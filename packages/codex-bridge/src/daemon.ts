// A client for the shared local Codex app-server daemon (Codex CLI 0.160+), used to wake an idle
// Codex session: list the sessions loaded in a folder, then start a turn in one (verified in the
// 2026-10-05 spike: the turn appears live in the person's Codex window).
//
// Transport: `codex app-server proxy` pipes our bytes to the daemon's control socket, which is a
// local socket protected by the OS account (no network port, no token). The daemon speaks
// WebSocket carrying JSON-RPC objects without the "jsonrpc" member.
//
// Safety (THREAT_MODEL, Codex idle wake): `turn/start` sends only the thread, the text and the
// trigger label. It never passes sandbox, approval, model or cwd settings, so the session keeps
// exactly the permissions the person gave it.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathKey } from '@quorum/core';
import { clientFrame, FrameReader, handshakeRequest } from './websocket.js';

export interface CodexThread {
  id: string;
  cwd: string;
  /** "idle", "active", "notLoaded", "systemError". */
  status: string;
  /** Seconds since the epoch. */
  updatedAt: number;
}

/** A byte stream to the daemon (the proxy process in production, a fake in tests). */
export interface DaemonTransport {
  write(data: Buffer | string): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export class CodexDaemonError extends Error {}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** The parameters `turn/start` may carry. Anything else (sandbox, approvals, model) is never sent. */
export const TURN_START_KEYS = ['threadId', 'input', 'turnTrigger'] as const;

export class CodexDaemon {
  readonly #transport: DaemonTransport;
  readonly #reader = new FrameReader();
  readonly #pending = new Map<number, Pending>();
  readonly #timeoutMs: number;
  #nextId = 1;
  #closed = false;
  #upgraded: () => void = () => undefined;
  #failed: (error: Error) => void = () => undefined;

  private constructor(transport: DaemonTransport, timeoutMs: number) {
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
  }

  /** Connect over `transport`: WebSocket handshake, then `initialize`. */
  static async open(
    transport: DaemonTransport,
    options: { timeoutMs?: number; clientVersion?: string } = {},
  ): Promise<CodexDaemon> {
    const daemon = new CodexDaemon(transport, options.timeoutMs ?? 10_000);
    const upgraded = new Promise<void>((resolve, reject) => {
      daemon.#upgraded = resolve;
      daemon.#failed = reject;
    });
    transport.onData((chunk) => {
      daemon.#receive(chunk);
    });
    transport.onClose(() => {
      daemon.#fail(new CodexDaemonError('The Codex daemon connection closed.'));
    });
    // Wait for the handshake answer before sending a frame: the proxy drops early bytes.
    transport.write(handshakeRequest());
    await daemon.#within(upgraded, 'the WebSocket handshake');
    await daemon.request('initialize', {
      clientInfo: { name: 'quorum', title: 'Quorum', version: options.clientVersion ?? '0' },
    });
    daemon.#send({ method: 'initialized' });
    return daemon;
  }

  async #within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new CodexDaemonError(`The Codex daemon did not answer ${what} in time.`));
          }, this.#timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #send(message: Record<string, unknown>): void {
    this.#transport.write(clientFrame(Buffer.from(JSON.stringify(message), 'utf8')));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failed(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #receive(chunk: Buffer): void {
    for (const frame of this.#reader.push(chunk)) {
      if (frame.opcode === 9) this.#transport.write(clientFrame(frame.data, 10)); // ping → pong
      if (frame.opcode === 8)
        this.#fail(new CodexDaemonError('The Codex daemon closed the session.'));
      if (frame.opcode !== 1) continue;
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(frame.data.toString('utf8')) as typeof message;
      } catch {
        continue;
      }
      if (typeof message.id !== 'number') continue; // notifications are not needed here
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new CodexDaemonError(`Codex refused: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
    }
    if (this.#reader.refused) {
      this.#fail(
        new CodexDaemonError(`The Codex daemon refused the connection: ${this.#reader.refused}`),
      );
    } else if (this.#reader.upgraded) {
      this.#upgraded();
    }
  }

  /** A JSON-RPC request. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new CodexDaemonError('The Codex daemon connection is closed.'));
    const id = this.#nextId++;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ id, method, params });
    return this.#within(answer, method);
  }

  /** Sessions loaded in `root` (however its path is spelled), most recently updated first. */
  async threadsIn(root: string): Promise<CodexThread[]> {
    const platform = process.platform === 'win32' ? 'win32' : 'posix';
    const want = pathKey(root, platform);
    const loaded = (await this.request('thread/loaded/list', {})) as { data?: unknown };
    const ids = Array.isArray(loaded.data) ? loaded.data.filter((x) => typeof x === 'string') : [];
    const threads: CodexThread[] = [];
    for (const id of ids) {
      const read = (await this.request('thread/read', { threadId: id, includeTurns: false })) as {
        thread?: { id?: unknown; cwd?: unknown; status?: { type?: unknown }; updatedAt?: unknown };
      };
      const t = read.thread;
      if (typeof t?.cwd !== 'string' || pathKey(t.cwd, platform) !== want) continue;
      threads.push({
        id: String(t.id),
        cwd: t.cwd,
        status: typeof t.status?.type === 'string' ? t.status.type : 'unknown',
        updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
      });
    }
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Start a turn that reads `text` without showing it as the person's message (spike 2026-10-07):
   * `text` goes into the thread's model-visible history (`thread/inject_items`, role `user`, the
   * least authority; never `developer` or `system`), then a turn starts with no user input. The
   * person's Codex window shows only the agent's reply: the user-prompt look stays the human's.
   * A Codex without `thread/inject_items` gets `text` as the turn's input instead.
   * Only the keys in TURN_START_KEYS are sent with `turn/start`.
   */
  async startTurn(threadId: string, text: string): Promise<string> {
    let input: { type: 'text'; text: string }[] = [];
    try {
      await this.request('thread/inject_items', {
        threadId,
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
      });
    } catch (error) {
      if (!(error instanceof CodexDaemonError) || this.#closed) throw error;
      input = [{ type: 'text', text }]; // an older Codex: the text is the turn's input
    }
    const params = { threadId, input, turnTrigger: 'quorum' };
    const result = (await this.request('turn/start', params)) as { turn?: { id?: unknown } };
    return typeof result.turn?.id === 'string' ? result.turn.id : '';
  }

  close(): void {
    this.#fail(new CodexDaemonError('closed'));
    this.#transport.close();
  }
}

/**
 * The fixed command that reaches the daemon: Codex's managed daemon binary when present (a real
 * program), else `codex` through the platform shell (npm installs a shim on Windows). Callers
 * choose nothing; this is the only process Quorum's adapters can cause to start for Codex (INV-10).
 */
export const codexProxyCommand = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } => {
  const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
  const managed = join(
    codexHome,
    'packages',
    'app-server-daemon',
    'current',
    'bin',
    platform === 'win32' ? 'codex.exe' : 'codex',
  );
  if (exists(managed)) return { command: managed, args: ['app-server', 'proxy'] };
  if (platform === 'win32') {
    return { command: env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', 'codex app-server proxy'] };
  }
  return { command: 'codex', args: ['app-server', 'proxy'] };
};

/** Connect to the local Codex daemon through `codex app-server proxy`. */
export const openCodexDaemon = async (
  options: { timeoutMs?: number } = {},
): Promise<CodexDaemon> => {
  const { command, args } = codexProxyCommand();
  const child: ChildProcess = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const transport: DaemonTransport = {
    write: (data) => child.stdin?.write(data),
    onData: (listener) => child.stdout?.on('data', listener),
    onClose: (listener) => {
      child.once('exit', listener);
      child.once('error', listener);
    },
    close: () => {
      child.stdin?.end();
      child.kill();
    },
  };
  try {
    return await CodexDaemon.open(transport, options);
  } catch (error) {
    transport.close();
    throw error;
  }
};
