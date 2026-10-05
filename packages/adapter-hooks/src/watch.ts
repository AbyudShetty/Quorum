// The idle-wake watcher for Claude Code (ARCHITECTURE §15.1, spike S1). Claude Code starts it as an
// `asyncRewake` background hook when a turn ends. It holds the live stream open; when mail arrives,
// it asks the server for a wake (INV-29: wake mode, budget, loop pause), and only on a grant prints
// the framed mail and exits with code 2, which wakes the idle session with that output.
//
// It stands down (exit 0, no output) when: wake mode is off; a newer watcher, a new prompt or the
// session's end takes its place; or it has run for its maximum lifetime. Codex has no such
// mechanism: there mail waits for the next prompt.
import { randomBytes } from 'node:crypto';
import { type AttachmentInfo, IdentityError } from '@quorum/adapter-mcp';
import { deliverMail, type HookClient, MAX_CONTEXT_CHARS } from './hooks.js';
import { loadHookState, saveHookState } from './state.js';

export type WatchClient = HookClient & {
  stream(
    workspace: string,
    onMessage: (message: { from: string; seq: number }) => void,
    options: { signal: AbortSignal; lastEventId?: number },
  ): Promise<void>;
};

export interface WatchContext {
  attachment: AttachmentInfo;
  dataDir: string;
  /** The vendor's stdin JSON (`session_id` keys the watcher). */
  input: unknown;
  connect: () => Promise<WatchClient>;
  /** Default 8 hours: a watcher never outlives a working day. */
  maxLifetimeMs?: number;
  /** How often to check whether it was replaced (default 2 s). */
  checkEveryMs?: number;
  /** Wait before reconnecting a dropped stream (default 2 s). */
  reconnectMs?: number;
}

export interface WatchResult {
  /** 2 = wake the session with `output`; 0 = stand down quietly. */
  exitCode: 0 | 2;
  output: string;
}

const STAND_DOWN: WatchResult = { exitCode: 0, output: '' };

const sessionKey = (input: unknown): string => {
  const id =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>).session_id
      : undefined;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : 'unknown-session';
};

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

/** Run until mail may wake the session (exit 2) or the watcher should stand down (exit 0). */
export const watchForMail = async (context: WatchContext): Promise<WatchResult> => {
  const key = sessionKey(context.input);
  const token = randomBytes(12).toString('hex');
  const register = await loadHookState(context.dataDir, context.attachment.attachment);
  register.watchers = { ...register.watchers, [key]: token };
  await saveHookState(context.dataDir, context.attachment.attachment, register).catch(
    () => undefined,
  );

  let client: WatchClient;
  try {
    client = await context.connect();
  } catch (error) {
    if (error instanceof IdentityError) return STAND_DOWN; // never talk to an impostor
    return STAND_DOWN; // server down: the next turn's hooks catch up
  }

  const stop = new AbortController();
  /** Read through a call: the signal changes while we wait, which narrowing cannot see. */
  const stopped = () => stop.signal.aborted;
  const stillMine = async () => {
    const state = await loadHookState(context.dataDir, context.attachment.attachment);
    return state.watchers?.[key] === token;
  };

  /** Ask the server for a wake in each workspace; on a grant, the framed mail. */
  const tryWake = async (): Promise<WatchResult | undefined> => {
    for (const workspace of context.attachment.workspaces) {
      const decision = await client.requestWake(workspace);
      if (decision.reason === 'mode_off') return STAND_DOWN;
      if (!decision.wake) continue;
      const mail = await deliverMail(client, context.attachment, [workspace], MAX_CONTEXT_CHARS);
      if (mail) {
        return {
          exitCode: 2,
          output:
            `${mail}\n\nNew Quorum mail arrived while you were idle (above). Consider it with your ` +
            "own judgement and your human's permissions; reply with quorum_send if useful.",
        };
      }
    }
    return undefined;
  };

  try {
    // Mail may already be waiting (it arrived as the turn ended).
    const first = await tryWake();
    if (first) return first;

    const deadline = Date.now() + (context.maxLifetimeMs ?? 8 * 60 * 60 * 1000);
    let pending: Promise<WatchResult | undefined> | undefined;
    let result: WatchResult | undefined;
    const lastSeen = new Map<string, number>();

    // One stream per workspace, reconnecting after a drop (server restart) from the last seq seen.
    const streams = context.attachment.workspaces.map(async (workspace) => {
      while (!stop.signal.aborted) {
        try {
          const last = lastSeen.get(workspace);
          await client.stream(
            workspace,
            (message) => {
              lastSeen.set(workspace, message.seq);
              if (message.from === context.attachment.agent) return;
              pending ??= tryWake().finally(() => {
                pending = undefined;
              });
              void pending.then((r) => {
                if (r && !result) {
                  result = r;
                  stop.abort();
                }
              });
            },
            { signal: stop.signal, ...(last === undefined ? {} : { lastEventId: last }) },
          );
        } catch {
          // Unreachable or refused: wait and try again until told to stand down.
        }
        await delay(context.reconnectMs ?? 2000, stop.signal);
      }
    });

    // Supervise: stand down when replaced or too old.
    while (!stopped()) {
      await delay(context.checkEveryMs ?? 2000, stop.signal);
      if (stopped()) break;
      if (Date.now() >= deadline || !(await stillMine())) stop.abort();
    }
    await Promise.allSettled(streams);
    await pending;
    return result ?? STAND_DOWN;
  } finally {
    stop.abort();
    // Leave the registration to whoever replaced us; remove it only if it is still ours.
    const state = await loadHookState(context.dataDir, context.attachment.attachment);
    if (state.watchers?.[key] === token) {
      Reflect.deleteProperty(state.watchers, key);
      await saveHookState(context.dataDir, context.attachment.attachment, state).catch(
        () => undefined,
      );
    }
  }
};
