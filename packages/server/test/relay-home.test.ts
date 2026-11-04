// A real relay plus the home-side TLS edge: shutdown must release sockets and waiters, and a
// caller that never starts TLS must not hold every connection slot forever (INV-15, INV-33).
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdFactory, serverFingerprint } from '@quorum/core';
import { closeRelayConnections, connectThroughRelay, createQuorumFetch } from '@quorum/local';
import { type Relay, startRelay } from '@quorum/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRelayHome, loadOrCreateInstance } from '../src/index.js';

let relay: Relay;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-relay-home-'));
  relay = await startRelay({ port: 0, perMinute: 10_000 });
});

afterAll(async () => {
  closeRelayConnections();
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('relay home lifecycle', () => {
  it('rejects pending and subsequent ready calls as soon as the home closes', async () => {
    const instance = await loadOrCreateInstance(dir, createIdFactory());
    const link = connectRelayHome({ relay: relay.url, instance, server: createServer() });
    const pending = expect(link.ready(100)).rejects.toThrow(/closed/);
    link.close();
    await pending;
    expect(link.state()).toBe('down');
    await expect(link.ready(100)).rejects.toThrow(/closed/);
  });

  it('closes connections that have been paired but have not finished TLS', async () => {
    const instance = await loadOrCreateInstance(dir, createIdFactory());
    const server = createServer();
    let admitted = 0;
    server.on('connection', () => {
      admitted += 1;
    });
    const link = connectRelayHome({ relay: relay.url, instance, server });
    await link.ready();
    const stream = await connectThroughRelay(relay.url, serverFingerprint(instance.publicKey));
    stream.resume();
    try {
      link.close();
      await expect.poll(() => stream.readableEnded, { timeout: 5000 }).toBe(true);
      expect(admitted).toBe(0);
    } finally {
      stream.destroy();
      link.close();
    }
  });

  it('expires stalled TLS handshakes and releases their slots without timing out live HTTP', async () => {
    const instance = await loadOrCreateInstance(dir, createIdFactory());
    const server = createServer((_request, response) => {
      response.end('ok');
    });
    let admitted = 0;
    server.on('connection', () => {
      admitted += 1;
    });
    const link = connectRelayHome({
      relay: relay.url,
      instance,
      server,
      maxConnections: 1,
      handshakeTimeoutMs: 1000,
    });
    await link.ready();
    const stream = await connectThroughRelay(relay.url, serverFingerprint(instance.publicKey));
    stream.resume();
    try {
      await expect.poll(() => stream.readableEnded, { timeout: 5000 }).toBe(true);
      expect(admitted).toBe(0);
      const send = createQuorumFetch();
      const response = await send(`${link.linkUrl}/health`);
      expect(await response.text()).toBe('ok');
      expect(admitted).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const again = await send(`${link.linkUrl}/health`);
      expect(await again.text()).toBe('ok');
      expect(admitted).toBe(1); // still the first, live keep-alive connection
    } finally {
      stream.destroy();
      closeRelayConnections();
      link.close();
    }
  });
});
