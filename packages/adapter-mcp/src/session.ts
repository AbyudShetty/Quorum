// A live run of the vendor tool, registered with the server (ARCHITECTURE §12, §13). Registering
// is how the server learns which working tree this agent is in and warns when another agent is in
// the same one (INV-28). Registration is best effort: a server that is down or refuses must never
// stop the agent from working, so failures are reported and the session simply goes unregistered.
import { randomBytes } from 'node:crypto';
import type { QuorumClient } from './client.js';
import { findGit } from './git.js';

export interface Session {
  id: string;
  /** Other live agents in the same working tree when this session registered (INV-28). */
  sharedWorktreeWith: string[];
  /** End the session. Safe to call more than once; never throws. */
  end(): Promise<void>;
}

export interface StartSessionOptions {
  client: Pick<QuorumClient, 'createSession' | 'deleteSession'>;
  /** Canonical absolute path of the attached folder. */
  root: string;
  /**
   * The vendor's own session id when known (hooks receive it). The MCP server cannot see it, so it
   * passes none and gets a random id for this process.
   */
  vendorSessionId?: string;
  onError?: (error: unknown) => void;
}

export const startSession = async (options: StartSessionOptions): Promise<Session | undefined> => {
  const onError = options.onError ?? (() => undefined);
  try {
    const git = await findGit(options.root);
    const created = await options.client.createSession({
      vendor_session_id: options.vendorSessionId ?? `mcp-${randomBytes(8).toString('hex')}`,
      root: options.root,
      ...(git ? { git } : {}),
    });
    let ended: Promise<void> | undefined;
    return {
      id: created.session_id,
      sharedWorktreeWith: created.shared_worktree_with,
      end: () => {
        ended ??= options.client.deleteSession(created.session_id).catch(onError);
        return ended;
      },
    };
  } catch (error) {
    onError(error);
    return undefined;
  }
};

/** The warning an agent should see when it shares its working tree (INV-28). */
export const sharedWorktreeNotice = (others: readonly string[]): string | undefined =>
  others.length === 0
    ? undefined
    : `WARNING: ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} working in the same folder as you right now. ` +
      'Stage only your own files (git add <paths>, never git add -A), and ask before editing files another agent may be changing.';
