import type { QuorumClient } from '@quorum/adapter-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createPairingClientCache } from '../src/pairing-clients.js';

const client = () => ({ session: undefined }) as unknown as QuorumClient;

describe('verified pairing clients', () => {
  it('reuses one handshake for repeated and simultaneous calls of the same window', async () => {
    const connect = vi.fn(() => Promise.resolve(client()));
    const cache = createPairingClientCache(connect);
    const clients = await Promise.all(
      Array.from({ length: 150 }, () => cache.get('attachment-a', 'window-a')),
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clients.every((c) => c === clients[0] && c.session === 'window-a')).toBe(true);
  });

  it('never shares mutable session identity between windows, attachments or remote targets', async () => {
    const cache = createPairingClientCache(() => Promise.resolve(client()));
    const a = await cache.get('attachment-a', 'window-a');
    const b = await cache.get('attachment-a', 'window-b');
    const c = await cache.get('attachment-b', 'window-a');
    const d = await cache.get('attachment-a', 'window-a', 'different-pinned-server');
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a.session).toBe('window-a');
    expect(b.session).toBe('window-b');
    expect(await cache.get('attachment-a', 'window-a')).toBe(a);
  });

  it('retries a failed handshake and bounds clients kept for historical sessions', async () => {
    const connect = vi.fn(() => Promise.resolve(client()));
    connect.mockRejectedValueOnce(new Error('server busy'));
    const cache = createPairingClientCache(connect, 2);
    await expect(cache.get('a', 'window')).rejects.toThrow('server busy');
    const a = await cache.get('a', 'window');
    await cache.get('b', 'window');
    expect(await cache.get('a', 'window')).toBe(a);
    await cache.get('c', 'window');
    await cache.get('b', 'window');
    expect(connect).toHaveBeenCalledTimes(5);
  });
});
