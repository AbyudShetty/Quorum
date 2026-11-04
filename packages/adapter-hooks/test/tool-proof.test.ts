// Per-invocation proofs are minted by a trusted vendor hook, bound to one identity, tool and
// argument object, and consumed once by MCP even when several processes compete (INV-7/12/34).
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumeToolProof,
  MAX_PENDING_TOOL_PROOFS,
  mintToolProof,
  TOOL_PROOF_TTL_MS,
} from '../src/index.js';

const dirs: string[] = [];
const NOW = 100_000;
const identity = { sessionKey: 'codex:one', attachment: 'at_one', window: 'sess_one' };
const input = {
  ...identity,
  tool: 'quorum_send',
  args: { to: ['codex@web-1'], body: { text: 'hello' } },
};
const callsOf = (dir: string) => join(dir, 'hooks', 'calls');
const pathOf = (dir: string, token: string) =>
  join(callsOf(dir), `${createHash('sha256').update(token).digest('hex')}.json`);
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-call-proof-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('single-use vendor tool-call proofs', () => {
  it('stores only an opaque hash and binding, then resolves exactly that joined session', async () => {
    const dir = await scratch();
    const token = await mintToolProof(dir, input, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const names = await readdir(callsOf(dir));
    expect(names).toEqual([`${createHash('sha256').update(token).digest('hex')}.json`]);
    const stored = await readFile(pathOf(dir, token), 'utf8');
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('hello');
    expect(await consumeToolProof(dir, token, input.tool, input.args, NOW)).toEqual(identity);
    expect(await consumeToolProof(dir, token, input.tool, input.args, NOW)).toBeUndefined();
    expect(await readdir(callsOf(dir))).toEqual([]);
  });

  it('accepts canonical key ordering and SDK defaults while excluding the proof field', async () => {
    const dir = await scratch();
    const token = await mintToolProof(
      dir,
      { ...input, args: { ...input.args, _quorum_call: 'ignored old token' } },
      NOW,
    );
    const args = {
      body: { text: 'hello' },
      type: 'note',
      to: ['codex@web-1'],
      _quorum_call: token,
    };
    expect(await consumeToolProof(dir, token, input.tool, args, NOW)).toEqual(identity);
    const inbox = await mintToolProof(dir, { ...identity, tool: 'quorum_inbox', args: {} }, NOW);
    expect(await consumeToolProof(dir, inbox, 'quorum_inbox', { mark_read: true }, NOW)).toEqual(
      identity,
    );
  });

  it('allows only one simultaneous consumer', async () => {
    const dir = await scratch();
    const token = await mintToolProof(dir, input, NOW);
    const taken = await Promise.all(
      Array.from({ length: 20 }, () => consumeToolProof(dir, token, input.tool, input.args, NOW)),
    );
    expect(taken.filter(Boolean)).toEqual([identity]);
  });

  it.each(['tool', 'body', 'recipient', 'nested proof', 'expired', 'clock rollback'])(
    'refuses and consumes a proof with changed %s',
    async (change) => {
      const dir = await scratch();
      const token = await mintToolProof(dir, input, NOW);
      const args: Record<string, unknown> = { ...input.args };
      let tool = input.tool;
      let time = NOW;
      if (change === 'tool') tool = 'quorum_status';
      if (change === 'body') args.body = { text: 'different message' };
      if (change === 'recipient') args.to = ['other'];
      if (change === 'nested proof') args.body = { text: 'hello', _quorum_call: 'content' };
      if (change === 'expired') time += TOOL_PROOF_TTL_MS;
      if (change === 'clock rollback') time -= 1;
      expect(await consumeToolProof(dir, token, tool, args, time)).toBeUndefined();
      expect(await consumeToolProof(dir, token, input.tool, input.args, NOW)).toBeUndefined();
    },
  );

  it.each([
    undefined,
    '',
    '../calls/file',
    '/absolute/path',
    'a'.repeat(44),
    'a'.repeat(42),
    'a'.repeat(43),
  ])('refuses malformed, missing or unknown token %s', async (token) => {
    const dir = await scratch();
    expect(await consumeToolProof(dir, token, input.tool, input.args, NOW)).toBeUndefined();
  });

  it('rejects malformed records and removes them on the attempted consume', async () => {
    const dir = await scratch();
    const token = await mintToolProof(dir, input, NOW);
    await writeFile(pathOf(dir, token), '{not JSON');
    expect(await consumeToolProof(dir, token, input.tool, input.args, NOW)).toBeUndefined();
    expect(await readdir(callsOf(dir))).toEqual([]);
  });

  it('prunes expired proofs before minting and keeps live calls', async () => {
    const dir = await scratch();
    const expired = await mintToolProof(dir, input, NOW);
    const alive = await mintToolProof(dir, input, NOW + 1);
    await mintToolProof(dir, input, NOW + TOOL_PROOF_TTL_MS);
    expect(await readdir(callsOf(dir))).toHaveLength(2);
    expect(
      await consumeToolProof(dir, expired, input.tool, input.args, NOW + TOOL_PROOF_TTL_MS),
    ).toBeUndefined();
    expect(
      await consumeToolProof(dir, alive, input.tool, input.args, NOW + TOOL_PROOF_TTL_MS),
    ).toEqual(identity);
  });

  it('bounds the number of abandoned live proofs', async () => {
    const dir = await scratch();
    const token = await mintToolProof(dir, input, NOW);
    const record = await readFile(pathOf(dir, token), 'utf8');
    await Promise.all(
      Array.from({ length: MAX_PENDING_TOOL_PROOFS }, (_, n) =>
        writeFile(join(callsOf(dir), `${n.toString(16).padStart(64, '0')}.json`), record),
      ),
    );
    await expect(mintToolProof(dir, input, NOW)).rejects.toThrow(/Too many/);
    await expect(mintToolProof(dir, input, NOW + TOOL_PROOF_TTL_MS)).resolves.toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(await readdir(callsOf(dir))).toHaveLength(1);
  });

  it('does not prune unrelated files or follow an invalid proof filename', async () => {
    const dir = await scratch();
    await mkdir(callsOf(dir), { recursive: true });
    await writeFile(join(callsOf(dir), 'keep.txt'), 'unrelated');
    await mintToolProof(dir, input, NOW);
    expect(await readFile(join(callsOf(dir), 'keep.txt'), 'utf8')).toBe('unrelated');
  });
});
