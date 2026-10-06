// Idle wake for Codex (spike 2026-10-05). Codex hooks cannot wake an idle session, but Codex 0.160+
// runs sessions on a shared local daemon, and a turn started there appears live in the person's
// Codex window. The daemon also runs Codex's MCP servers, so ONE `quorum mcp` serves every Codex
// window in the folder; it runs this waker for all of them. On new mail it asks the server, for
// each IDLE window its hooks registered, whether that window may be woken (INV-29: the server
// knows which window the mail is for) and, only on a grant, starts one turn carrying the mail.
// It also keeps the windows the daemon still has open alive on the server (a heartbeat each).
//
// The mail never takes the person's place: the framed mail (INV-9) goes into the thread's history
// as a user-role item (no more authority than the person's own words) and the turn starts with no
// user input, so the Codex window shows only the agent's reply, which starts by showing the person
// the mail. The bridge never changes the session's sandbox or approval settings. Off switch:
// QUORUM_CODEX_IDLE_WAKE=off, or wake mode `off`.
import { type AttachmentInfo } from '@quorum/adapter-mcp';
import { createIdFactory } from '@quorum/core';
import type { SubmittedEnvelope } from '@quorum/schemas';
import {
  collectMail,
  framedMail,
  MAX_CONTEXT_CHARS,
  MCP_WINDOW_PREFIX,
  IDLE_WAKE_INTRO,
} from './hooks.js';
import { type HookWindow, loadHookState } from './state.js';
import type { WatchClient } from './watch.js';

/** What the waker needs from the Codex daemon (the real one is @quorum/codex-bridge). */
export interface CodexSessions {
  /** Sessions in this folder, most recent first. */
  threadsIn(root: string): Promise<{ id: string; status: string }[]>;
  startTurn(threadId: string, text: string): Promise<unknown>;
  close(): void;
}

export interface CodexWakerOptions {
  client: WatchClient;
  attachment: AttachmentInfo;
  dataDir: string;
  /** Connect to the Codex daemon (one short connection per wake). */
  openCodex: () => Promise<CodexSessions>;
  reconnectMs?: number;
  /** How often open windows say they are alive (default 30 s, MESSAGE_SPEC §5.10). */
  keepAliveMs?: number;
  onError?: (error: unknown) => void;
}

export interface CodexWaker {
  stop(): Promise<void>;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve(); // stopped before we got here: the abort event will not come again
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Start watching for mail that may wake an idle Codex window. */
export const startCodexWaker = (options: CodexWakerOptions): Promise<CodexWaker> => {
  const { client, attachment } = options;
  const onError = options.onError ?? (() => undefined);
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  const ids = createIdFactory();

  /** The windows our hooks registered, by Codex thread id (the hooks' session id). */
  const windowsByThread = async (): Promise<Map<string, [string, HookWindow]>> => {
    const state = await loadHookState(options.dataDir, attachment.attachment);
    return new Map(
      Object.entries(state.windows ?? {})
        .filter(([, w]) => !w.key.startsWith(MCP_WINDOW_PREFIX))
        .map(([id, w]) => [w.key, [id, w]]),
    );
  };

  /** Wake one idle thread if the server allows it, speaking as its window (or the agent). */
  const wakeThread = async (
    codex: CodexSessions,
    workspace: string,
    threadId: string,
    session: string | undefined,
  ): Promise<boolean> =>
    client.asSession(session, async () => {
      // No probe at start: asking the server for a wake can use up a grant (and the mail with it).
      const decision = await client.requestWake(workspace);
      if (!decision.wake) return false;
      const mail = await collectMail(client, attachment, [workspace], MAX_CONTEXT_CHARS);
      if (mail.length === 0) return false;
      // The framed mail goes into the thread's history, not into the person's prompt box; the
      // agent starts its reply by showing the person the mail (like Claude Code's idle wake).
      await codex.startTurn(threadId, framedMail(mail, attachment, IDLE_WAKE_INTRO));
      return true;
    });

  /** One wake round for a workspace; serialised so two messages never start two turns at once. */
  const tryWake = async (workspace: string): Promise<void> => {
    let codex: CodexSessions | undefined;
    try {
      codex = await options.openCodex();
      const idle = (await codex.threadsIn(attachment.root)).filter((t) => t.status === 'idle');
      if (idle.length === 0) return; // busy: the hooks deliver mid-turn; or no Codex window open
      const windows = await windowsByThread();
      const registered = idle.filter((t) => windows.has(t.id));
      if (registered.length === 0) {
        // No hooks registered yet (they run with the first prompt): wake as the agent.
        const [first] = idle;
        if (first) await wakeThread(codex, workspace, first.id, undefined);
        return;
      }
      // Each window for its own mail: the server says which ones have any.
      for (const thread of registered) {
        await wakeThread(codex, workspace, thread.id, windows.get(thread.id)?.[0]);
      }
    } catch (error) {
      onError(error);
    } finally {
      codex?.close();
    }
  };

  /** Keep each window the daemon still has open alive on the server (its own heartbeat). */
  const keepAlive = async (): Promise<void> => {
    while (!stopped()) {
      let codex: CodexSessions | undefined;
      try {
        codex = await options.openCodex();
        const threads = await codex.threadsIn(attachment.root);
        const windows = await windowsByThread();
        for (const thread of threads) {
          const window = windows.get(thread.id);
          if (!window) continue;
          await client.asSession(window[0], () =>
            Promise.all(
              attachment.workspaces.map((workspace) =>
                client.send(workspace, {
                  spec: 'quorum/1',
                  id: ids.id('message'),
                  workspace,
                  from: attachment.agent,
                  to: ['*'],
                  type: 'heartbeat',
                  type_version: 1,
                  created_at: new Date().toISOString(),
                  body: {
                    status: thread.status === 'idle' ? 'idle' : 'working',
                    resources_in_use: [],
                  },
                } as unknown as SubmittedEnvelope),
              ),
            ),
          );
        }
      } catch (error) {
        onError(error);
      } finally {
        codex?.close();
      }
      await delay(options.keepAliveMs ?? 30_000, stop.signal);
    }
  };

  let queue: Promise<void> = Promise.resolve();
  // The stream is the agent's (no window): it sees the mail of every window.
  const streams = attachment.workspaces.map((workspace) =>
    client.asSession(undefined, async () => {
      let lastSeen: number | undefined;
      while (!stopped()) {
        try {
          await client.stream(
            workspace,
            (message) => {
              lastSeen = message.seq;
              if (message.from === attachment.agent) return;
              queue = queue.then(() => (stopped() ? undefined : tryWake(workspace)));
            },
            { signal: stop.signal, ...(lastSeen === undefined ? {} : { lastEventId: lastSeen }) },
          );
        } catch (error) {
          onError(error);
        }
        await delay(options.reconnectMs ?? 2000, stop.signal);
      }
    }),
  );
  const alive = keepAlive();

  return Promise.resolve({
    stop: async () => {
      stop.abort();
      await Promise.allSettled([...streams, alive]);
      await queue;
    },
  });
};
