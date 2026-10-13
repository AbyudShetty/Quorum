// Quorum IDs (DECISIONS D-20, PAIRING.md §3): the short, permanent name a session gets with
// `/quorum-id`, e.g. QRM-7KD2-PX9F-M3TA. It is derived from the session's home server key, so a
// relay cannot point an ID at a server of its choosing: whoever looks an ID up gets the home's key
// fingerprint and a salt, and recomputes the ID. Forging an entry would take about 2^60 hashes.
import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so IDs are easy to read out and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_CHARS = 12; // 60 bits
const ID = /^QRM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** The text that is hashed: protocol, the home's key fingerprint, a 16-byte salt (base64url). */
export const quorumIdInput = (fingerprint: string, salt: string): string =>
  `quorum-id/1\n${fingerprint}\n${salt}`;

const encode = (bytes: Uint8Array, chars: number): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length === chars) break;
  }
  return out;
};

const format = (chars: string): string =>
  `QRM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;

/** The ID for a home key fingerprint and salt. */
export const quorumId = (fingerprint: string, salt: string): string =>
  format(encode(createHash('sha256').update(quorumIdInput(fingerprint, salt)).digest(), ID_CHARS));

/** A new ID for a home: its salt (keep it) and the ID. */
export const newQuorumId = (fingerprint: string): { id: string; salt: string } => {
  const salt = randomBytes(16).toString('base64url');
  return { id: quorumId(fingerprint, salt), salt };
};

/** Does this fingerprint and salt really give this ID? (What a lookup must prove.) */
export const checkQuorumId = (id: string, fingerprint: string, salt: string): boolean =>
  /^[A-Za-z0-9_-]{22}$/.test(salt) && quorumId(fingerprint, salt) === id;

/**
 * What a person typed, as an ID: case does not matter, the dashes and the `QRM` prefix are
 * optional, and the letters people confuse with digits are read as those digits (O→0, I/L→1).
 * Undefined when it cannot be an ID.
 */
export const parseQuorumId = (text: string): string | undefined => {
  const plain = text
    .trim()
    .toUpperCase()
    .replace(/^QRM/, '')
    .replace(/[\s-]/g, '')
    .replaceAll('O', '0')
    .replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(plain)) return undefined;
  const id = format(plain);
  return ID.test(id) ? id : undefined;
};

export const isQuorumId = (text: string): boolean => ID.test(text);
