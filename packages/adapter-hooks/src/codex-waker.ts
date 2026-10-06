// Idle wake for Codex (spike 2026-10-05). Codex hooks cannot wake an idle session, but Codex 0.160+
// runs sessions on a shared local daemon, and a turn started there appears live in the person's
// Codex window. `quorum mcp` (alive for the whole Codex session) runs this waker: on new mail it
// asks the server for a wake (INV-29) and, only on a grant and only for an IDLE session in this
// folder, starts one turn carrying the mail.
//
// Codex shows that turn in the user's position, to the person as well: so it carries only the neat
// form (`claude - /proj/api - 1:`, blank line, message). The agent learns the turn is mail, not its human (INV-9),
// from the MCP instructions and session-start context, and from the framed copy the woken turn's
// prompt hook adds as hidden context. The bridge never changes the session's sandbox or approval
// settings. Off switch: QUORUM_CODEX_IDLE_WAKE=off, or wake mode `off`.
import { type AttachmentInfo } from '@quorum/adapter-mcp';
import {
  collectMail,
  framedMail,
  MAX_CONTEXT_CHARS,
  MCP_WINDOW_PREFIX,
  neatMail,
  WOKEN_INTRO,
} from './hooks.js';
import { loadHookState, saveHookState } from './state.js';
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
  onError?: (error: unknown) => void;
  /**
   * The Codex session this `quorum mcp` belongs to (its key is the Codex thread id), read at each
   * wake: the window can change (its hooks start late). When known, only that window is woken;
   * otherwise the most suitable idle window in the folder.
   */
  windowKey?: () => string | undefined;
}

export interface CodexWaker {
  stop(): Promise<void>;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
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

/** Start watching for mail that may wake an idle Codex session. */
export const startCodexWaker = (options: CodexWakerOptions): Promise<CodexWaker> => {
  const { client, attachment } = options;
  const onError = options.onError ?? (() => undefined);
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;

  // No probe at start: asking the server for a wake can use up a grant (and the mail with it).
  // Wake mode `off` is the server's answer to each request.
  /** One wake attempt for a workspace; serialised so two messages never start two turns. */
  const tryWake = async (workspace: string): Promise<void> => {
    let codex: CodexSessions | undefined;
    try {
      codex = await options.openCodex();
      const threads = await codex.threadsIn(attachment.root);
      const idle = threads.filter((t) => t.status === 'idle');
      if (idle.length === 0) return; // busy: the hooks deliver mid-turn; or no Codex session open
      // Prefer the sessions our hooks registered for this attachment (Codex session id = thread id).
      const ours = new Set(
        Object.keys((await loadHookState(options.dataDir, attachment.attachment)).sessions),
      );
      const windowKey = options.windowKey?.();
      const target =
        windowKey && !windowKey.startsWith(MCP_WINDOW_PREFIX)
          ? idle.find((t) => t.id === windowKey)
          : (idle.find((t) => ours.has(t.id)) ?? idle[0]);
      if (!target) return;
      const decision = await client.requestWake(workspace);
      if (!decision.wake) return;
      const mail = await collectMail(client, attachment, [workspace], MAX_CONTEXT_CHARS);
      if (mail.length === 0) return;
      // The framed copy waits for the woken turn's prompt hook (hidden from the person).
      const state = await loadHookState(options.dataDir, attachment.attachment);
      state.wakeContexts = {
        ...state.wakeContexts,
        [target.id]: { text: framedMail(mail, attachment, WOKEN_INTRO), atMs: Date.now() },
      };
      await saveHookState(options.dataDir, attachment.attachment, state).catch(() => undefined);
      // The visible turn: the neat lines only.
      await codex.startTurn(target.id, neatMail(mail, attachment));
    } catch (error) {
      onError(error);
    } finally {
      codex?.close();
    }
  };

  let queue: Promise<void> = Promise.resolve();
  const streams = attachment.workspaces.map(async (workspace) => {
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
  });

  return Promise.resolve({
    stop: async () => {
      stop.abort();
      await Promise.allSettled(streams);
      await queue;
    },
  });
};
