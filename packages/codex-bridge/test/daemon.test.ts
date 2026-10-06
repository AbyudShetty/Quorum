// The Codex daemon client against a fake daemon (CI has no Codex): handshake, JSON-RPC, session
// lookup by folder, the exact `turn/start` parameters, failures, and the fixed proxy command.
import { describe, expect, it } from 'vitest';
import {
  CodexDaemon,
  CodexDaemonError,
  codexProxyCommand,
  type DaemonTransport,
  FrameReader,
  serverFrame,
  TURN_START_KEYS,
} from '../src/index.js';

type Handler = (method: string, params: Record<string, unknown>) => unknown;

/** A fake daemon: answers the handshake with `status`, then JSON-RPC requests with `handler`. */
const fakeDaemon = (handler: Handler, options: { status?: string; silent?: boolean } = {}) => {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const sent: number[] = []; // opcodes of client frames
  let onData: (chunk: Buffer) => void = () => undefined;
  let onClose: () => void = () => undefined;
  let handshakeDone = false;
  // The client's frames are masked; FrameReader unmasks them once it has seen a 101 line.
  const reader = new FrameReader();
  reader.push(Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
  const transport: DaemonTransport = {
    write: (data) => {
      if (options.silent) return;
      if (!handshakeDone) {
        handshakeDone = true;
        setImmediate(() => {
          onData(
            Buffer.from(
              `${options.status ?? 'HTTP/1.1 101 Switching Protocols'}\r\nupgrade: websocket\r\n\r\n`,
            ),
          );
        });
        return;
      }
      for (const frame of reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data))) {
        sent.push(frame.opcode);
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.data.toString('utf8')) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        requests.push({ method: message.method, params: message.params ?? {} });
        if (message.id === undefined) continue;
        const result = handler(message.method, message.params ?? {});
        // A handler answers { refuse: error } to send a JSON-RPC error instead of a result.
        const refused = (result as { refuse?: unknown } | undefined)?.refuse;
        const answer =
          refused === undefined ? { id: message.id, result } : { id: message.id, error: refused };
        setImmediate(() => {
          onData(serverFrame(JSON.stringify(answer)));
        });
      }
    },
    onData: (listener) => {
      onData = listener;
    },
    onClose: (listener) => {
      onClose = listener;
    },
    close: () => {
      onClose();
    },
  };
  return {
    transport,
    requests,
    sent,
    push: (b: Buffer) => {
      onData(b);
    },
    close: () => {
      onClose();
    },
  };
};

const threads: Record<
  string,
  { id: string; cwd: string; status: { type: string }; updatedAt: number }
> = {
  t1: { id: 't1', cwd: 'C:\\work\\web', status: { type: 'idle' }, updatedAt: 100 },
  t2: { id: 't2', cwd: 'c:/WORK/web/', status: { type: 'active' }, updatedAt: 300 },
  t3: { id: 't3', cwd: 'C:\\work\\api', status: { type: 'idle' }, updatedAt: 500 },
};
const handler: Handler = (method, params) => {
  if (method === 'initialize') return { userAgent: 'fake' };
  if (method === 'thread/loaded/list') return { data: Object.keys(threads), nextCursor: null };
  if (method === 'thread/read') return { thread: threads[String(params.threadId)] };
  if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
  return {};
};

describe('CodexDaemon', () => {
  it('handshakes, initializes, and finds the sessions in a folder however it is spelled', async () => {
    const fake = fakeDaemon(handler);
    const daemon = await CodexDaemon.open(fake.transport);
    expect(fake.requests.map((r) => r.method).slice(0, 2)).toEqual(['initialize', 'initialized']);
    const found = await daemon.threadsIn('C:\\work\\web');
    if (process.platform === 'win32') {
      // Same folder spelled differently on Windows; most recent first.
      expect(found.map((t) => [t.id, t.status])).toEqual([
        ['t2', 'active'],
        ['t1', 'idle'],
      ]);
    } else {
      expect(found.map((t) => t.id)).toEqual(['t1']);
    }
    daemon.close();
  });

  it('puts the text into the history as a user item, then starts a turn with no user input', async () => {
    const fake = fakeDaemon(handler);
    const daemon = await CodexDaemon.open(fake.transport);
    expect(await daemon.startTurn('t1', 'hello')).toBe('turn-1');
    const inject = fake.requests.find((r) => r.method === 'thread/inject_items');
    expect(inject?.params).toEqual({
      threadId: 't1',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    // Only the thread, empty input and the trigger: never sandbox or approval settings.
    const start = fake.requests.find((r) => r.method === 'turn/start');
    expect(Object.keys(start?.params ?? {}).sort()).toEqual([...TURN_START_KEYS].sort());
    expect(start?.params).toEqual({ threadId: 't1', input: [], turnTrigger: 'quorum' });
    expect(fake.requests.indexOf(inject as never)).toBeLessThan(
      fake.requests.indexOf(start as never),
    );
    daemon.close();
  });

  it('gives an older Codex (no thread/inject_items) the text as the turn input', async () => {
    const fake = fakeDaemon((method, params) =>
      method === 'thread/inject_items' ? { refuse: { code: -32601 } } : handler(method, params),
    );
    const daemon = await CodexDaemon.open(fake.transport);
    expect(await daemon.startTurn('t1', 'hello')).toBe('turn-1');
    const start = fake.requests.find((r) => r.method === 'turn/start');
    expect(start?.params).toEqual({
      threadId: 't1',
      input: [{ type: 'text', text: 'hello' }],
      turnTrigger: 'quorum',
    });
    daemon.close();
  });

  it('answers pings with pongs', async () => {
    const fake = fakeDaemon(handler);
    const daemon = await CodexDaemon.open(fake.transport);
    fake.push(serverFrame('', 9));
    expect(fake.sent).toContain(10);
    daemon.close();
  });

  it('fails clearly when the daemon refuses, stays silent, or goes away', async () => {
    await expect(
      CodexDaemon.open(fakeDaemon(handler, { status: 'HTTP/1.1 403 Forbidden' }).transport),
    ).rejects.toThrow(/refused/);
    await expect(
      CodexDaemon.open(fakeDaemon(handler, { silent: true }).transport, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(CodexDaemonError);
    const fake = fakeDaemon(handler);
    const daemon = await CodexDaemon.open(fake.transport);
    fake.close();
    await expect(daemon.threadsIn('C:\\work\\web')).rejects.toBeInstanceOf(CodexDaemonError);
  });
});

describe('codexProxyCommand (INV-10)', () => {
  it('prefers the managed daemon binary, a real program run without a shell', () => {
    const command = codexProxyCommand({ CODEX_HOME: 'C:\\Users\\a\\.codex' }, 'win32', () => true);
    expect(command.command).toMatch(/app-server-daemon[\\/]current[\\/]bin[\\/]codex\.exe$/);
    expect(command.args).toEqual(['app-server', 'proxy']);
  });

  it('falls back to a fixed command: cmd on Windows (npm shim), codex elsewhere', () => {
    expect(codexProxyCommand({ ComSpec: 'C:\\Windows\\cmd.exe' }, 'win32', () => false)).toEqual({
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/c', 'codex app-server proxy'],
    });
    expect(codexProxyCommand({}, 'linux', () => false)).toEqual({
      command: 'codex',
      args: ['app-server', 'proxy'],
    });
  });
});
