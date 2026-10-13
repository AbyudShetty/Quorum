import { describe, expect, it } from 'vitest';
import { formatServerLink, parseServerLink } from '../src/index.js';

const K = 'k'.repeat(43);
const J = `qrm_jc_${'j'.repeat(43)}`;

describe('server links and join codes (INV-24)', () => {
  it('reads an HTTPS front end link, with or without a join code', () => {
    expect(parseServerLink(`https://laptop-a.tail1.ts.net#k=${K}`)).toEqual({
      url: 'https://laptop-a.tail1.ts.net',
      fingerprint: K,
    });
    expect(parseServerLink(`https://laptop-a.tail1.ts.net/#k=${K}&j=${J}`)).toEqual({
      url: 'https://laptop-a.tail1.ts.net',
      fingerprint: K,
      secret: J,
    });
  });

  it('reads a relay address, whose path must be the key it pins (D-18)', () => {
    const link = { url: `quorum://relay.example.dev/${K}`, fingerprint: K, secret: J };
    expect(parseServerLink(formatServerLink(link))).toEqual(link);
    expect(parseServerLink(`quorum://127.0.0.1:7430/${K}#k=${K}`)).toEqual({
      url: `quorum://127.0.0.1:7430/${K}`,
      fingerprint: K,
    });
    // A path that names another server than the key pinned: refused.
    expect(parseServerLink(`quorum://relay.example.dev/${'x'.repeat(43)}#k=${K}`)).toBeUndefined();
    expect(parseServerLink(`quorum://relay.example.dev/#k=${K}`)).toBeUndefined();
  });

  it('refuses other schemes, plain HTTP elsewhere, queries and bad codes', () => {
    expect(parseServerLink(`http://laptop-a.example#k=${K}`)).toBeUndefined();
    expect(parseServerLink(`ftp://laptop-a.example#k=${K}`)).toBeUndefined();
    expect(parseServerLink(`https://laptop-a.example?x=1#k=${K}`)).toBeUndefined();
    expect(parseServerLink(`https://laptop-a.example#k=short`)).toBeUndefined();
    expect(parseServerLink(`https://laptop-a.example#k=${K}&j=nope`)).toBeUndefined();
    expect(parseServerLink(`http://localhost:7420#k=${K}`)).toEqual({
      url: 'http://localhost:7420',
      fingerprint: K,
    });
  });
});
