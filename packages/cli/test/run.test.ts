import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keychainService } from '../src/run.js';

describe('keychainService (one keychain service per data folder, INV-25)', () => {
  const env = { LOCALAPPDATA: join('C:', 'Users', 'me', 'AppData', 'Local') };

  it('keeps plain `quorum` for the usual data folder', () => {
    expect(keychainService(env, 'win32')).toBe('quorum');
    expect(
      keychainService({ ...env, QUORUM_HOME: join(env.LOCALAPPDATA, 'QUORUM') }, 'win32'),
    ).toBe('quorum');
  });

  it('gives another data folder its own service, so its sign-in never replaces the usual one', () => {
    const trial = keychainService({ ...env, QUORUM_HOME: join('D:', 'trial', 'qhome') }, 'win32');
    const other = keychainService({ ...env, QUORUM_HOME: join('D:', 'trial', 'other') }, 'win32');
    expect(trial).toMatch(/^quorum:[0-9a-f]{12}$/);
    expect(other).toMatch(/^quorum:[0-9a-f]{12}$/);
    expect(trial).not.toBe(other);
    expect(keychainService({ ...env, QUORUM_HOME: join('D:', 'trial', 'qhome') }, 'win32')).toBe(
      trial,
    );
  });
});
