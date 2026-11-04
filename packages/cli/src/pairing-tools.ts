// Bind shared Codex MCP calls to the vendor session that actually invoked them. The trusted
// PreToolUse hook adds a one-use proof; neither a model-provided session ID nor last activity
// chooses the caller. Missing/unsupported hook rewriting therefore fails closed.
import { realpath } from 'node:fs/promises';
import { pathKey } from '@quorum/core';
import { loadAttachment } from '@quorum/adapter-mcp';
import {
  consumeToolProof,
  loadHookState,
  loadPairing,
  mintToolProof,
  pairingKey,
} from '@quorum/adapter-hooks';

export interface BoundToolSession {
  attachment: string;
  window: string;
}

/** Only Quorum's four pairing tools can acquire a proof. */
const toolOf = (name: unknown): string | undefined => {
  if (typeof name !== 'string') return undefined;
  return /^mcp__quorum__(quorum_(?:send|inbox|status|requests))$/.exec(name)?.[1];
};

export const preparePairingToolCall = async (
  dataDir: string,
  input: unknown,
  vendor: 'codex' | 'claude-code' = 'codex',
): Promise<string> => {
  if (!input || typeof input !== 'object') return '';
  const call = input as Record<string, unknown>;
  const tool = toolOf(call.tool_name);
  if (!tool) return '';
  const deny = () =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `This session has not joined Quorum in this folder. Type ${vendor === 'codex' ? '$' : '/'}quorum-id, then retry.`,
      },
    });
  const key = pairingKey(vendor, input);
  const session = key ? (await loadPairing(dataDir))[key] : undefined;
  if (!session || typeof call.session_id !== 'string' || typeof call.cwd !== 'string')
    return deny();
  const saved = await loadAttachment(dataDir, session.attachment);
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const cwd = await realpath(call.cwd).catch(() => undefined);
  const root = saved && (await realpath(saved.root).catch(() => undefined));
  if (
    !saved ||
    saved.vendor !== vendor ||
    !cwd ||
    !root ||
    pathKey(cwd, platform) !== pathKey(root, platform)
  )
    return deny();
  const state = await loadHookState(dataDir, session.attachment);
  const window = state.sessions[call.session_id];
  if (!window || state.windows?.[window]?.key !== call.session_id) return deny();
  if (!call.tool_input || typeof call.tool_input !== 'object' || Array.isArray(call.tool_input))
    return deny();
  const args = call.tool_input as Record<string, unknown>;
  const proof = await mintToolProof(dataDir, {
    sessionKey: key ?? '',
    attachment: session.attachment,
    window,
    tool,
    args,
  });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      ...(vendor === 'codex' ? { permissionDecision: 'allow' } : {}),
      updatedInput: { ...args, _quorum_call: proof },
    },
  });
};

export const resolvePairingToolCall = async (
  dataDir: string,
  tool: string,
  args: Record<string, unknown>,
  vendor: 'codex' | 'claude-code' = 'codex',
): Promise<BoundToolSession | undefined> => {
  const proof = await consumeToolProof(dataDir, args._quorum_call, tool, args);
  if (!proof || !proof.sessionKey.startsWith(`${vendor}:`)) return undefined;
  const joined = (await loadPairing(dataDir))[proof.sessionKey];
  if (joined?.attachment !== proof.attachment) return undefined;
  const state = await loadHookState(dataDir, proof.attachment);
  const raw = proof.sessionKey.slice(vendor.length + 1);
  if (state.sessions[raw] !== proof.window || state.windows?.[proof.window]?.key !== raw)
    return undefined;
  return { attachment: proof.attachment, window: proof.window };
};
