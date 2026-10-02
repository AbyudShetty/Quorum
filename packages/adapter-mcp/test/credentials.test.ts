import { randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { describe, expect, it } from 'vitest';
import { KeychainCredentialStore, MemoryCredentialStore } from '../src/index.js';

const credentials = {
  access_token: 'qrm_at_' + 'a'.repeat(43),
  refresh_token: 'qrm_rt_' + 'b'.repeat(43),
  access_expires_at: 1_800_000_000_000,
};

/** CI images without a Secret Service cannot run the keychain test; developer machines can. */
const keychainAvailable = (): boolean => {
  const probe = new Entry(`quorum-probe-${randomBytes(4).toString('hex')}`, 'probe');
  try {
    probe.setPassword('x');
    probe.deletePassword();
    return true;
  } catch {
    return false;
  }
};

describe('MemoryCredentialStore', () => {
  it('stores, loads and removes', async () => {
    const store = new MemoryCredentialStore();
    expect(await store.load('at_1')).toBeUndefined();
    await store.save('at_1', credentials);
    expect(await store.load('at_1')).toEqual(credentials);
    await store.remove('at_1');
    expect(await store.load('at_1')).toBeUndefined();
  });
});

describe.skipIf(!keychainAvailable())('KeychainCredentialStore (OS keychain, INV-25)', () => {
  const service = `quorum-test-${randomBytes(4).toString('hex')}`;

  it('round-trips credentials through the OS keychain and removes them', async () => {
    const store = new KeychainCredentialStore(service);
    expect(await store.load('at_1')).toBeUndefined();
    await store.save('at_1', credentials);
    try {
      expect(await store.load('at_1')).toEqual(credentials);
    } finally {
      await store.remove('at_1');
    }
    expect(await store.load('at_1')).toBeUndefined();
  });

  it('treats a damaged entry as missing rather than crashing', async () => {
    const store = new KeychainCredentialStore(service);
    const entry = new Entry(service, 'at_bad');
    entry.setPassword('{"access_token": 5}');
    try {
      expect(await store.load('at_bad')).toBeUndefined();
    } finally {
      entry.deletePassword();
    }
  });
});
