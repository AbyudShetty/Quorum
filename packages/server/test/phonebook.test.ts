// The phone book end to end (D-20): a real home link registers its Quorum IDs with a real relay;
// lookups find them, and an answer that does not match the ID is refused.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdFactory, newQuorumId, serverFingerprint } from '@quorum/core';
import { RelayError } from '@quorum/local';
import { type Relay, startRelay } from '@quorum/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRelayHome, loadOrCreateInstance, lookupQuorumId } from '../src/index.js';

let relay: Relay;
let dir: string;

beforeAll(async () => {
  relay = await startRelay({ port: 0 });
  dir = mkdtempSync(join(tmpdir(), 'quorum-phonebook-'));
});

afterAll(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('phone book (D-20)', () => {
  it('a home registers its IDs on connect and later; lookups find and check them', async () => {
    const instance = await loadOrCreateInstance(dir, createIdFactory());
    const home = serverFingerprint(instance.publicKey);
    const first = newQuorumId(home);
    const link = connectRelayHome({
      relay: relay.url,
      instance,
      server: createServer(),
      quorumIds: () => [first],
    });
    await link.ready();
    const until = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const found = await lookupQuorumId(relay.url, id);
        if (found) return found;
        await new Promise((done) => setTimeout(done, 20));
      }
      return undefined;
    };
    expect(await until(first.id)).toEqual({ home, salt: first.salt });
    const later = newQuorumId(home);
    link.register([later]);
    expect(await until(later.id)).toEqual({ home, salt: later.salt });
    expect(await lookupQuorumId(relay.url, newQuorumId(home).id)).toBeUndefined();
    link.close();
  });

  it('refuses an answer that does not produce the ID (a relay pointing it elsewhere)', async () => {
    const real = newQuorumId('A'.repeat(43));
    const liar: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ home: 'B'.repeat(43), salt: real.salt }), { status: 200 }),
      );
    await expect(lookupQuorumId('wss://relay.example', real.id, liar)).rejects.toBeInstanceOf(
      RelayError,
    );
    await expect(lookupQuorumId('wss://relay.example', real.id, liar)).rejects.toThrow(
      /does not match the ID/,
    );
  });
});
