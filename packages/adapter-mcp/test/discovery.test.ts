import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDataDir as serverDataDir } from '@quorum/server';
import { describe, expect, it } from 'vitest';
import { defaultDataDir, discoveryFile, readLocalDiscovery } from '../src/discovery.js';

describe('defaultDataDir', () => {
  it.each([
    [{ QUORUM_HOME: 'D:/q' }, 'win32'],
    [{ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, 'win32'],
    [{}, 'win32'],
    [{}, 'linux'],
    [{ QUORUM_HOME: '/data/q' }, 'darwin'],
  ] as const)('matches the server for %j on %s', (env, platform) => {
    expect(defaultDataDir(env, platform, '/home/x')).toBe(serverDataDir(env, platform, '/home/x'));
  });
});

describe('readLocalDiscovery', () => {
  const valid = {
    instance_id: '01J9ZZZZZZZZZZZZZZZZZZZZZZ',
    pid: 1234,
    port: 51234,
    public_key: 'A'.repeat(43),
    version: '0.0.0',
    started_at: '2026-10-03T10:00:00.000Z',
  };

  const write = async (content: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-disc-'));
    await mkdir(join(dir, 'local'));
    await writeFile(discoveryFile(dir), content);
    return dir;
  };

  it('returns the published details', async () => {
    expect(await readLocalDiscovery(await write(JSON.stringify(valid)))).toEqual(valid);
  });

  it('treats a missing file as no server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-disc-'));
    expect(await readLocalDiscovery(dir)).toBeUndefined();
  });

  it.each(['not json', '{}', JSON.stringify({ ...valid, port: 70000 })])(
    'treats a malformed file (%s) like a missing one',
    async (content) => {
      expect(await readLocalDiscovery(await write(content))).toBeUndefined();
    },
  );
});
