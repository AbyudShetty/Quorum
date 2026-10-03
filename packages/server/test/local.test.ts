import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdFactory, newHelloNonce, verifyHello } from '@quorum/core';
import { afterAll, describe, expect, it } from 'vitest';
import { checkLocalRequest, loadOrCreateInstance } from '../src/index.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-local-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const ids = createIdFactory();

// Each Windows check starts PowerShell, which can take seconds on CI machines.
describe('server instance identity (INV-24)', () => {
  it('creates a key once and reuses it on restart', async () => {
    const dir = tempDir();
    const first = await loadOrCreateInstance(dir, ids);
    const again = await loadOrCreateInstance(dir, ids);
    expect(again.instanceId).toBe(first.instanceId);
    expect(again.publicKey).toBe(first.publicKey);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('answers hello so that a client holding the pinned key can verify it', async () => {
    const server = await loadOrCreateInstance(tempDir(), ids);
    const nonce = newHelloNonce();
    expect(verifyHello(server.publicKey, nonce, server.hello(nonce))).toBe(true);
  });

  it('fails verification for another server (port squatting), another nonce or a tampered signature', async () => {
    const real = await loadOrCreateInstance(tempDir(), ids);
    const squatter = await loadOrCreateInstance(tempDir(), ids);
    const nonce = newHelloNonce();
    expect(verifyHello(real.publicKey, nonce, squatter.hello(nonce))).toBe(false);
    expect(verifyHello(real.publicKey, nonce, real.hello(newHelloNonce()))).toBe(false);
    const forged = { ...squatter.hello(nonce), public_key: real.publicKey };
    expect(verifyHello(real.publicKey, nonce, forged)).toBe(false);
  });

  it('never writes the private key into the identity file', async () => {
    const dir = tempDir();
    await loadOrCreateInstance(dir, ids);
    expect(readFileSync(join(dir, 'instance.json'), 'utf8')).not.toContain('PRIVATE KEY');
    expect(readFileSync(join(dir, 'instance.key'), 'utf8')).toContain('PRIVATE KEY');
  });
});

describe('local request guard (INV-26)', () => {
  const port = 51234;
  const check = (method: string, host: string | undefined, origin?: string) =>
    checkLocalRequest({ method, host, origin }, port)?.code;

  it.each(['localhost:51234', '127.0.0.1:51234', '[::1]:51234', 'LOCALHOST:51234'])(
    'accepts Host %s',
    (host) => {
      expect(check('GET', host)).toBeUndefined();
    },
  );

  it.each([
    ['DNS rebinding', 'attacker.example:51234'],
    ['wrong port', 'localhost:80'],
    ['missing Host', undefined],
    ['LAN address', '192.168.1.5:51234'],
  ])('rejects %s', (_case, host) => {
    expect(check('GET', host)).toBe('request.foreign_host');
  });

  it('rejects state-changing requests from another site', () => {
    expect(check('POST', 'localhost:51234', 'https://attacker.example')).toBe(
      'request.foreign_origin',
    );
    expect(check('DELETE', 'localhost:51234', 'null')).toBe('request.foreign_origin');
  });

  it('accepts writes from our own UI and from clients that send no Origin (CLI, adapters)', () => {
    expect(check('POST', 'localhost:51234', 'http://localhost:51234')).toBeUndefined();
    expect(check('POST', 'localhost:51234')).toBeUndefined();
  });

  it('does not block reads by Origin (they still need a token)', () => {
    expect(check('GET', 'localhost:51234', 'https://attacker.example')).toBeUndefined();
  });
});
