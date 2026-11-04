// A vendor's PreToolUse hook binds one MCP invocation to the exact joined session (INV-7/12/34).
// The model supplies neither identity nor authority: it receives only a short-lived opaque proof.
// The file stores a hash of the arguments, not messages, credentials, or the bearer proof itself.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '@quorum/core';
import { withFileLock, writePrivateFile } from '@quorum/local';

export const TOOL_PROOF_TTL_MS = 60_000;
export const MAX_PENDING_TOOL_PROOFS = 1024;

export interface ToolProofIdentity {
  sessionKey: string;
  attachment: string;
  window: string;
}

export interface ToolProofInput extends ToolProofIdentity {
  tool: string;
  args: Record<string, unknown>;
}

interface StoredProof extends ToolProofIdentity {
  version: 1;
  tool: string;
  argsHash: string;
  mintedAt: number;
  expiresAt: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const directory = (dataDir: string): string => join(dataDir, 'hooks', 'calls');
const fileOf = (dataDir: string, digest: string): string =>
  join(directory(dataDir), `${digest}.json`);
const PROOF_FILE = /^[0-9a-f]{64}\.json$/;

/** Match SDK defaulting on both sides; the invocation's opaque proof never hashes itself. */
const argsHash = (tool: string, args: unknown): string => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new TypeError('Quorum tool arguments must be a JSON object.');
  }
  const { _quorum_call: _proof, ...normalized } = args as Record<string, unknown>;
  if (tool === 'quorum_send' && normalized.type === undefined) normalized.type = 'note';
  if (tool === 'quorum_inbox' && normalized.mark_read === undefined) normalized.mark_read = true;
  return sha256(canonicalJson(normalized));
};

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

const validRecord = (value: unknown): value is StoredProof => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Partial<StoredProof>;
  return (
    p.version === 1 &&
    nonempty(p.sessionKey) &&
    nonempty(p.attachment) &&
    nonempty(p.window) &&
    nonempty(p.tool) &&
    typeof p.argsHash === 'string' &&
    /^[0-9a-f]{64}$/.test(p.argsHash) &&
    typeof p.mintedAt === 'number' &&
    Number.isSafeInteger(p.mintedAt) &&
    p.mintedAt >= 0 &&
    typeof p.expiresAt === 'number' &&
    p.expiresAt - p.mintedAt === TOOL_PROOF_TTL_MS
  );
};

const readProof = async (path: string): Promise<StoredProof | undefined> => {
  try {
    const info = await lstat(path);
    // Refuse symlinks and unexpectedly large records before reading their contents.
    if (!info.isFile() || info.size > 4096) return undefined;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return validRecord(value) ? value : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined;
    throw error;
  }
};

/** Mint only from a hook which already established its session, folder, attachment and window. */
export const mintToolProof = async (
  dataDir: string,
  input: ToolProofInput,
  now = Date.now(),
): Promise<string> => {
  if (
    ![input.sessionKey, input.attachment, input.window, input.tool].every(nonempty) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new TypeError('Invalid Quorum tool proof identity.');
  const hash = argsHash(input.tool, input.args);
  await mkdir(directory(dataDir), { recursive: true, mode: 0o700 });
  return withFileLock(dataDir, 'tool-proof-mint', async () => {
    let pending = 0;
    for (const name of await readdir(directory(dataDir))) {
      if (!PROOF_FILE.test(name)) continue;
      const path = join(directory(dataDir), name);
      const record = await readProof(path);
      if (!record || record.expiresAt <= now) await rm(path, { force: true });
      else pending += 1;
    }
    if (pending >= MAX_PENDING_TOOL_PROOFS) {
      throw new Error('Too many Quorum tool calls are waiting; retry after one minute.');
    }
    const token = randomBytes(32).toString('base64url');
    const record: StoredProof = {
      version: 1,
      sessionKey: input.sessionKey,
      attachment: input.attachment,
      window: input.window,
      tool: input.tool,
      argsHash: hash,
      mintedAt: now,
      expiresAt: now + TOOL_PROOF_TTL_MS,
    };
    await writePrivateFile(fileOf(dataDir, sha256(token)), `${JSON.stringify(record)}\n`);
    return token;
  });
};

/** A proof is burned on its first use, including an invalid invocation; replay always fails. */
export const consumeToolProof = async (
  dataDir: string,
  token: unknown,
  tool: string,
  args: Record<string, unknown>,
  now = Date.now(),
): Promise<ToolProofIdentity | undefined> => {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, 'base64url').toString('base64url') !== token ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return undefined;
  const digest = sha256(token);
  try {
    return await withFileLock(dataDir, `tool-proof-${digest}`, async () => {
      const path = fileOf(dataDir, digest);
      const proof = await readProof(path);
      if (!proof) {
        await rm(path, { force: true });
        return undefined;
      }
      // Without force: a simultaneous expiry-pruner removing this file also invalidates it.
      await rm(path);
      if (
        now < proof.mintedAt ||
        now >= proof.expiresAt ||
        proof.tool !== tool ||
        proof.argsHash !== argsHash(tool, args)
      )
        return undefined;
      return { sessionKey: proof.sessionKey, attachment: proof.attachment, window: proof.window };
    });
  } catch {
    // Missing files, lock failures, invalid JSON and malformed arguments all fail closed.
    return undefined;
  }
};
