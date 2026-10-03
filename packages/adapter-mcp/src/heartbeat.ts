// Presence (MESSAGE_SPEC §5.10): while a session is live the adapter sends a heartbeat every 30 s;
// the server marks the agent offline after 90 s of silence. A clean exit sends `offline` at once.
// Heartbeats are ephemeral (the server records nothing in the log), so they bypass the outbox: a
// heartbeat that could not be sent is stale by the time the server is back.
import { createIdFactory, type IdFactory } from '@quorum/core';
import type { SubmittedEnvelope } from '@quorum/schemas';
import type { AttachmentInfo } from './attachment.js';
import type { QuorumClient } from './client.js';

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Do not hold up a shutdown for longer than this to say goodbye. */
const GOODBYE_TIMEOUT_MS = 2_000;

export type PresenceStatus = 'idle' | 'working' | 'blocked' | 'offline';

export interface HeartbeatOptions {
  client: Pick<QuorumClient, 'send'>;
  attachment: Pick<AttachmentInfo, 'agent' | 'workspaces'>;
  intervalMs?: number;
  ids?: IdFactory;
  now?: () => Date;
  /** Called with errors that were swallowed (server restarting, token expired). Never throws. */
  onError?: (error: unknown) => void;
}

export interface Heartbeat {
  /** Send one now (e.g. on a hook event, or when the status changes). */
  beat(status?: PresenceStatus): Promise<void>;
  /** Stop the timer and tell the server the session ended. Safe to call more than once. */
  stop(): Promise<void>;
}

export const startHeartbeat = (options: HeartbeatOptions): Heartbeat => {
  const ids = options.ids ?? createIdFactory();
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  let stopped: Promise<void> | undefined;

  const beat = async (status: PresenceStatus = 'idle'): Promise<void> => {
    await Promise.all(
      options.attachment.workspaces.map(async (workspace) => {
        const envelope = {
          spec: 'quorum/1',
          id: ids.id('message'),
          workspace,
          from: options.attachment.agent,
          to: ['*'],
          type: 'heartbeat',
          type_version: 1,
          created_at: now().toISOString(),
          body: { status, resources_in_use: [] },
        } as unknown as SubmittedEnvelope;
        try {
          await options.client.send(workspace, envelope);
        } catch (error) {
          onError(error);
        }
      }),
    );
  };

  void beat();
  const timer = setInterval(() => void beat(), options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref(); // presence must never keep a finished process alive

  return {
    beat,
    stop: () => {
      stopped ??= (async () => {
        clearInterval(timer);
        let giveUp: NodeJS.Timeout | undefined;
        await Promise.race([
          beat('offline'),
          new Promise<void>((resolve) => {
            giveUp = setTimeout(resolve, GOODBYE_TIMEOUT_MS);
            giveUp.unref();
          }),
        ]);
        clearTimeout(giveUp);
      })();
      return stopped;
    },
  };
};
