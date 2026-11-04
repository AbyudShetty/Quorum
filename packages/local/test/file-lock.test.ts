import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLockTimeout, withFileLock } from '../src/index.js';

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-named-lock-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('named cross-process locks', () => {
  it('never steals a live holder when the old age limit expires', async () => {
    const dir = await scratch();
    await withFileLock(dir, 'live', async () => {
      await expect(
        withFileLock(dir, 'live', () => Promise.resolve(), { timeoutMs: 100, staleMs: 1 }),
      ).rejects.toBeInstanceOf(FileLockTimeout);
    });
    await expect(withFileLock(dir, 'live', () => Promise.resolve('released'))).resolves.toBe(
      'released',
    );
  });
  it('takes over a dead process lock exactly once among concurrent contenders', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'locks'));
    await writeFile(join(dir, 'locks', 'crashed.lock'), `2147483647\n${randomUUID()}\n`);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 16 }, () =>
        withFileLock(dir, 'crashed', async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
  it('releases the lock when work fails', async () => {
    const dir = await scratch();
    await expect(
      withFileLock(dir, 'failure', () => Promise.reject(new Error('failed'))),
    ).rejects.toThrow('failed');
    await expect(withFileLock(dir, 'failure', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
