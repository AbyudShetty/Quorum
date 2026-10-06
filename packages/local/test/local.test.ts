import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acquireStartLock,
  bootstrapPath,
  checkPrivate,
  defaultDataDir,
  discoveryPath,
  ensurePrivateDir,
  isProcessAlive,
  lockPath,
  readBootstrapCode,
  readDiscovery,
  removeBootstrapCode,
  removeDiscovery,
  writeBootstrapCode,
  writeDiscovery,
  writePrivateFile,
} from '../src/index.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-local-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const windows = process.platform === 'win32';

// Each Windows check starts PowerShell, which can take seconds on CI machines.
describe('data directory (INV-25)', { timeout: 60_000 }, () => {
  it('uses QUORUM_HOME, else %LOCALAPPDATA%\\Quorum on Windows, else ~/.quorum', () => {
    expect(defaultDataDir({ QUORUM_HOME: '/custom' }, 'linux', '/home/a')).toBe('/custom');
    expect(defaultDataDir({}, 'linux', '/home/a')).toBe(join('/home/a', '.quorum'));
    expect(
      defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'),
    ).toBe(join('C:\\Users\\a\\AppData\\Local', 'Quorum'));
  });

  it('makes a new data directory private and verifies it', async () => {
    const dir = join(tempDir(), 'Quorum');
    await ensurePrivateDir(dir);
    expect(await checkPrivate(dir)).toEqual({ ok: true });
  });

  it.runIf(windows)(
    'detects a Windows folder readable by another group and gives the fix',
    async () => {
      const dir = join(tempDir(), 'Quorum');
      await ensurePrivateDir(dir);
      // Grant BUILTIN\Users read access, like an inherited sandbox group would have.
      execFileSync('icacls', [dir, '/grant', '*S-1-5-32-545:(OI)(CI)R'], { windowsHide: true });
      const check = await checkPrivate(dir);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.problem).toContain('S-1-5-32-545');
        // The fix both stops inheritance and removes the explicit grant to the other group.
        expect(check.fix).toMatch(
          /^icacls ".*" \/inheritance:r \/grant:r .*; icacls ".*" \/remove:g \*S-1-5-32-545$/,
        );
      }
      // ensurePrivateDir repairs it.
      await ensurePrivateDir(dir);
      expect(await checkPrivate(dir)).toEqual({ ok: true });
    },
  );

  it.runIf(!windows)(
    'detects a POSIX folder open to group or others and gives the fix',
    async () => {
      const dir = join(tempDir(), 'Quorum');
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      expect(await checkPrivate(dir)).toMatchObject({ ok: false, fix: `chmod 700 "${dir}"` });
      await ensurePrivateDir(dir);
      expect(await checkPrivate(dir)).toEqual({ ok: true });
    },
  );
});

describe('discovery file', () => {
  const info = {
    instance_id: '01J9Z8X7W6V5T4S3R2Q1P0N9M8',
    pid: 4242,
    port: 51234,
    public_key: 'k'.repeat(43),
    version: '0.0.0',
    started_at: '2026-10-02T10:00:00Z',
  };

  it('writes, reads back and removes the discovery file', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'local'));
    expect(await readDiscovery(dir)).toBeUndefined();
    await writeDiscovery(dir, info);
    expect(await readDiscovery(dir)).toEqual(info);
    await removeDiscovery(dir);
    expect(await readDiscovery(dir)).toBeUndefined();
  });

  it('treats a malformed or tampered file as missing', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'local'));
    writeFileSync(discoveryPath(dir), '{not json');
    expect(await readDiscovery(dir)).toBeUndefined();
    writeFileSync(discoveryPath(dir), JSON.stringify({ ...info, port: 70000 }));
    expect(await readDiscovery(dir)).toBeUndefined();
  });
});

describe('start lock (one local server per user)', () => {
  const lockDir = () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'local'));
    return dir;
  };

  it('lets exactly one of two simultaneous starters win', async () => {
    const dir = lockDir();
    const attempts = await Promise.all([acquireStartLock(dir), acquireStartLock(dir)]);
    expect(attempts.filter((a) => a.acquired)).toHaveLength(1);
    expect(attempts.find((a) => !a.acquired)).toEqual({ acquired: false, holderPid: process.pid });
  });

  it('can be taken again after release', async () => {
    const dir = lockDir();
    const first = await acquireStartLock(dir);
    if (first.acquired) await first.lock.release();
    expect((await acquireStartLock(dir)).acquired).toBe(true);
  });

  const crashedLock = `999999\n${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}\n`;
  const deadIs999999 = (pid: number) => pid !== 999999;

  it('takes over a lock left by a crashed process', async () => {
    const dir = lockDir();
    writeFileSync(lockPath(dir), crashedLock);
    const attempt = await acquireStartLock(dir, deadIs999999);
    expect(attempt.acquired).toBe(true);
    expect(readFileSync(lockPath(dir), 'utf8').startsWith(`${String(process.pid)}\n`)).toBe(true);
  });

  it('lets exactly one of several simultaneous starters take over a crashed lock', async () => {
    for (let round = 0; round < 10; round++) {
      const dir = lockDir();
      writeFileSync(lockPath(dir), crashedLock);
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () => acquireStartLock(dir, deadIs999999)),
      );
      expect(attempts.filter((a) => a.acquired)).toHaveLength(1);
    }
  });

  it('never releases a lock that someone else now holds', async () => {
    const dir = lockDir();
    const mine = await acquireStartLock(dir);
    const theirs = `4242\n${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}\n`;
    writeFileSync(lockPath(dir), theirs);
    if (mine.acquired) await mine.lock.release();
    expect(readFileSync(lockPath(dir), 'utf8')).toBe(theirs);
  });

  it('takes over an unreadable lock file', async () => {
    const dir = lockDir();
    writeFileSync(lockPath(dir), 'garbage');
    expect((await acquireStartLock(dir)).acquired).toBe(true);
  });

  it('knows this process is alive and a nonsense pid is not', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 30)).toBe(false);
  });
});

describe('bootstrap code file', () => {
  const code = `qrm_bc_${'b'.repeat(43)}`;
  const file = { code, expires_at: '2026-10-02T10:10:00Z' };
  const before = new Date('2026-10-02T10:05:00Z');
  const codeDir = () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'local'));
    return dir;
  };

  it('writes, reads back and removes the code', async () => {
    const dir = codeDir();
    expect(await readBootstrapCode(dir, before)).toBeUndefined();
    await writeBootstrapCode(dir, file);
    expect(await readBootstrapCode(dir, before)).toEqual(file);
    await removeBootstrapCode(dir);
    expect(await readBootstrapCode(dir, before)).toBeUndefined();
  });

  it('reports an expired code as missing', async () => {
    const dir = codeDir();
    await writeBootstrapCode(dir, file);
    expect(await readBootstrapCode(dir, new Date('2026-10-02T10:10:00Z'))).toBeUndefined();
  });

  it('treats a malformed file, or a token of another kind, as missing', async () => {
    const dir = codeDir();
    writeFileSync(bootstrapPath(dir), '{not json');
    expect(await readBootstrapCode(dir, before)).toBeUndefined();
    writeFileSync(
      bootstrapPath(dir),
      JSON.stringify({ ...file, code: `qrm_at_${'a'.repeat(43)}` }),
    );
    expect(await readBootstrapCode(dir, before)).toBeUndefined();
  });

  it.runIf(!windows)('is written readable by the owner only (INV-25)', async () => {
    const dir = codeDir();
    await writeBootstrapCode(dir, file);
    expect(statSync(bootstrapPath(dir)).mode & 0o077).toBe(0);
  });
});

describe('writePrivateFile', () => {
  it('replaces a file while others keep reading it (Windows refuses for a moment)', async () => {
    const path = join(tempDir(), 'state.json');
    await writePrivateFile(path, '0');
    const reads = Array.from({ length: 200 }, () => readFile(path, 'utf8'));
    const writes = Array.from({ length: 50 }, (_, i) => writePrivateFile(path, String(i + 1)));
    await Promise.all([...reads, ...writes]);
    expect(Number(await readFile(path, 'utf8'))).toBeGreaterThan(0);
    expect(readdirSync(join(path, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
