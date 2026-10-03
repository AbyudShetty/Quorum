import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalBootstrap, readBootstrapCode } from '../src/index.js';

const dirs: string[] = [];
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-bootstrap-'));
  mkdirSync(join(dir, 'local'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A clock the test can move. */
const clock = (start: string) => {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
};

describe('local bootstrap code (ARCHITECTURE §6)', () => {
  it('issues a 10-minute code into the data directory', async () => {
    const dir = dataDir();
    const time = clock('2026-10-02T10:00:00Z');
    const bootstrap = new LocalBootstrap(dir, { now: time.now });
    expect(await bootstrap.issue()).toBe('2026-10-02T10:10:00.000Z');
    const file = await readBootstrapCode(dir, time.now());
    expect(file?.code).toMatch(/^qrm_bc_[A-Za-z0-9_-]{43}$/);
    await bootstrap.discard();
  });

  it('works exactly once, then removes the file', async () => {
    const dir = dataDir();
    const bootstrap = new LocalBootstrap(dir);
    await bootstrap.issue();
    const code = (await readBootstrapCode(dir))?.code ?? '';
    expect(await bootstrap.redeem(code)).toEqual({ outcome: 'accept' });
    expect(await readBootstrapCode(dir)).toBeUndefined();
    expect(await bootstrap.redeem(code)).toEqual({ outcome: 'reject', reason: 'used' });
  });

  it('lets only one of two simultaneous exchanges succeed', async () => {
    const dir = dataDir();
    const bootstrap = new LocalBootstrap(dir);
    await bootstrap.issue();
    const code = (await readBootstrapCode(dir))?.code ?? '';
    const results = await Promise.all([bootstrap.redeem(code), bootstrap.redeem(code)]);
    expect(results.filter((r) => r.outcome === 'accept')).toHaveLength(1);
  });

  it('refuses an expired code and removes it', async () => {
    const dir = dataDir();
    const time = clock('2026-10-02T10:00:00Z');
    const bootstrap = new LocalBootstrap(dir, { now: time.now });
    await bootstrap.issue();
    const code = (await readBootstrapCode(dir, time.now()))?.code ?? '';
    time.advance(600_000);
    expect(await bootstrap.redeem(code)).toEqual({ outcome: 'reject', reason: 'expired' });
    time.advance(-600_000);
    expect(await readBootstrapCode(dir, time.now())).toBeUndefined();
  });

  it('refuses a wrong code without spending the real one', async () => {
    const dir = dataDir();
    const bootstrap = new LocalBootstrap(dir);
    await bootstrap.issue();
    const code = (await readBootstrapCode(dir))?.code ?? '';
    const wrong = `qrm_bc_${'x'.repeat(43)}`;
    expect(await bootstrap.redeem(wrong)).toEqual({ outcome: 'reject', reason: 'unknown' });
    expect(await bootstrap.redeem(code)).toEqual({ outcome: 'accept' });
  });

  it('replaces the previous code when a new one is issued (restart)', async () => {
    const dir = dataDir();
    const bootstrap = new LocalBootstrap(dir);
    await bootstrap.issue();
    const old = (await readBootstrapCode(dir))?.code ?? '';
    await bootstrap.issue();
    expect(await bootstrap.redeem(old)).toEqual({ outcome: 'reject', reason: 'unknown' });
    await bootstrap.discard();
  });
});
