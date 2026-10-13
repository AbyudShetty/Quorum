import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newQuorumId, quorumId } from '@quorum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkHomeProof,
  CLOSE,
  homeProofMessage,
  QUORUM_ID,
  quorumIdOf,
  type Relay,
  startRelay,
} from '../src/index.js';

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay({ port: 0 });
});

afterAll(async () => {
  await relay.close();
});

const newHome = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = privateKey.export({ format: 'jwk' }).x ?? '';
  const id = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url');
  return { privateKey, publicKey, id };
};

/** A WebSocket that records what it receives and how it closed. */
const open = async (path: string) => {
  const ws = new WebSocket(`${relay.url}${path}`);
  ws.binaryType = 'arraybuffer';
  const texts: Record<string, unknown>[] = [];
  const bytes: Buffer[] = [];
  const closed = new Promise<number>((done) => {
    ws.addEventListener('close', (event) => {
      done(event.code);
    });
  });
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string')
      texts.push(JSON.parse(event.data) as Record<string, unknown>);
    else bytes.push(Buffer.from(event.data as ArrayBuffer));
  });
  await new Promise<void>((done) => {
    ws.addEventListener('open', () => {
      done();
    });
    ws.addEventListener('close', () => {
      done();
    });
  });
  const next = async (type: string) => {
    for (let i = 0; i < 200; i++) {
      const found = texts.find((t) => t.type === type);
      if (found) return found;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error(`no ${type}`);
  };
  return { ws, texts, bytes, closed, next };
};

/** A home server's control connection that proves its key. */
const provenHome = async (home: { privateKey: KeyObject; publicKey: string; id: string }) => {
  const control = await open(`/v1/home/${home.id}`);
  const { nonce } = (await control.next('challenge')) as { nonce: string };
  control.ws.send(
    JSON.stringify({
      type: 'prove',
      public_key: home.publicKey,
      signature: sign(null, homeProofMessage(home.id, nonce), home.privateKey).toString(
        'base64url',
      ),
    }),
  );
  await control.next('ready');
  return control;
};

describe('relay (DECISIONS D-18)', () => {
  it('answers a health check', async () => {
    const response = await fetch(relay.url.replace('ws://', 'http://') + '/health');
    expect(await response.json()).toEqual({ status: 'ok', relay: 'quorum-relay/1' });
  });

  it('checks a home proof: right key and signature only', async () => {
    const home = newHome();
    const other = newHome();
    const signature = sign(null, homeProofMessage(home.id, 'n1'), home.privateKey).toString(
      'base64url',
    );
    expect(await checkHomeProof(home.id, 'n1', home.publicKey, signature)).toBe(true);
    expect(await checkHomeProof(home.id, 'n2', home.publicKey, signature)).toBe(false);
    expect(await checkHomeProof(other.id, 'n1', home.publicKey, signature)).toBe(false);
    expect(await checkHomeProof(home.id, 'n1', other.publicKey, signature)).toBe(false);
  });

  it('closes a home that cannot prove the key its name is the fingerprint of', async () => {
    const home = newHome();
    const impostor = newHome();
    const control = await open(`/v1/home/${home.id}`);
    const { nonce } = (await control.next('challenge')) as { nonce: string };
    control.ws.send(
      JSON.stringify({
        type: 'prove',
        public_key: impostor.publicKey,
        signature: sign(null, homeProofMessage(home.id, nonce), impostor.privateKey).toString(
          'base64url',
        ),
      }),
    );
    expect(await control.closed).toBe(CLOSE.unproven);
  });

  it('refuses a connection to a home that is not connected', async () => {
    const b = await open(`/v1/connect/${newHome().id}`);
    expect(await b.closed).toBe(CLOSE.offline);
  });

  it('pairs a connection with its home and passes bytes both ways, then closes both', async () => {
    const home = newHome();
    const control = await provenHome(home);
    const b = await open(`/v1/connect/${home.id}`);
    const { conn, client } = (await control.next('open')) as { conn: string; client: string };
    expect(conn).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(client).toBe('127.0.0.1');
    const a = await open(`/v1/accept/${home.id}/${conn}`);
    await b.next('paired');
    b.ws.send(Buffer.from('hello home'));
    a.ws.send(Buffer.from('hello there'));
    for (let i = 0; i < 100 && (a.bytes.length === 0 || b.bytes.length === 0); i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(Buffer.concat(a.bytes).toString()).toBe('hello home');
    expect(Buffer.concat(b.bytes).toString()).toBe('hello there');
    a.ws.close();
    expect(await b.closed).toBe(1000);
    control.ws.close();
  });

  it('refuses an accept for a connection that does not exist, and bytes before pairing', async () => {
    const home = newHome();
    const control = await provenHome(home);
    const stray = await open(`/v1/accept/${home.id}/${'A'.repeat(22)}`);
    expect(await stray.closed).toBe(CLOSE.offline);
    const b = await open(`/v1/connect/${home.id}`);
    await control.next('open');
    b.ws.send(Buffer.from('too early'));
    expect(await b.closed).toBe(CLOSE.protocol);
    control.ws.close();
  });

  it('lets a newer proven connection of the same home replace the older one', async () => {
    const home = newHome();
    const first = await provenHome(home);
    const second = await provenHome(home);
    expect(await first.closed).toBe(CLOSE.replaced);
    second.ws.close();
  });

  it('passes the home a refusal for a connection it does not want', async () => {
    const home = newHome();
    const control = await provenHome(home);
    const b = await open(`/v1/connect/${home.id}`);
    const { conn } = (await control.next('open')) as { conn: string };
    control.ws.send(JSON.stringify({ type: 'refuse', conn }));
    expect(await b.closed).toBe(CLOSE.refused);
    control.ws.close();
  });
});

describe('the phone book (D-20)', () => {
  const http = (path: string, on: Relay = relay) =>
    fetch(`${on.url.replace('ws://', 'http://')}${path}`);

  it('computes IDs exactly like @quorum/core', async () => {
    const { id, salt } = newQuorumId(newHome().id);
    const home = newHome().id;
    expect(await quorumIdOf(home, salt)).toBe(quorumId(home, salt));
    expect(id).toMatch(QUORUM_ID);
  });

  it('stores only IDs derived from the registering home key, and answers lookups', async () => {
    const home = newHome();
    const other = newHome();
    const control = await provenHome(home);
    const mine = newQuorumId(home.id);
    const theirs = newQuorumId(other.id);
    control.ws.send(
      JSON.stringify({ type: 'register', ids: [mine, theirs, { id: 'x', salt: 1 }] }),
    );
    expect(await control.next('registered')).toEqual({ type: 'registered', ids: [mine.id] });

    const found = await http(`/v1/lookup/${mine.id}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ home: home.id, salt: mine.salt });
    expect((await http(`/v1/lookup/${theirs.id}`)).status).toBe(404); // claimed by the wrong home
    expect((await http('/v1/lookup/QRM-0000-0000-0000')).status).toBe(404);
    expect((await http('/v1/lookup/nonsense')).status).toBe(404);
    control.ws.close();
  });

  it('ignores registrations before the home has proven its key', async () => {
    const home = newHome();
    const control = await open(`/v1/home/${home.id}`);
    await control.next('challenge');
    const early = newQuorumId(home.id);
    control.ws.send(JSON.stringify({ type: 'register', ids: [early] }));
    expect(await control.closed).toBe(CLOSE.unproven);
    expect((await http(`/v1/lookup/${early.id}`)).status).toBe(404);
  });

  it('limits lookups per address, and keeps the phone book in a file across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-phonebook-'));
    const file = join(dir, 'phonebook.json');
    const first = await startRelay({ port: 0, lookupsPerMinute: 2, phonebookFile: file });
    const home = newHome();
    const saved = newQuorumId(home.id);
    const control = new WebSocket(`${first.url}/v1/home/${home.id}`);
    const answers: Record<string, unknown>[] = [];
    control.addEventListener('message', (event) => {
      answers.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const until = async (type: string) => {
      for (let i = 0; i < 200 && !answers.some((a) => a.type === type); i++) {
        await new Promise((done) => setTimeout(done, 10));
      }
      return answers.find((a) => a.type === type);
    };
    const { nonce } = (await until('challenge')) as { nonce: string };
    control.send(
      JSON.stringify({
        type: 'prove',
        public_key: home.publicKey,
        signature: sign(null, homeProofMessage(home.id, nonce), home.privateKey).toString(
          'base64url',
        ),
      }),
    );
    await until('ready');
    control.send(JSON.stringify({ type: 'register', ids: [saved] }));
    await until('registered');
    control.close();
    expect((await http(`/v1/lookup/${saved.id}`, first)).status).toBe(200);
    expect((await http(`/v1/lookup/${saved.id}`, first)).status).toBe(200);
    expect((await http(`/v1/lookup/${saved.id}`, first)).status).toBe(429);
    await first.close();

    const second = await startRelay({ port: 0, phonebookFile: file });
    expect(await (await http(`/v1/lookup/${saved.id}`, second)).json()).toEqual({
      home: home.id,
      salt: saved.salt,
    });
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
