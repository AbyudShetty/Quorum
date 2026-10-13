import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHomeProof, CLOSE, homeProofMessage, type Relay, startRelay } from '../src/index.js';

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
