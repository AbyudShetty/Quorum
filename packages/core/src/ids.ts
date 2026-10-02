// Prefixed ULIDs (MESSAGE_SPEC §1): 48-bit millisecond time + 80 random bits, Crockford base32.
// IDs from one factory are strictly increasing, even within one millisecond or if the clock
// steps backwards, so sorting by ID matches creation order on one machine.
import { randomBytes } from 'node:crypto';
import { ID_PREFIXES, type IdKind } from '@quorum/schemas';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

export interface IdFactoryOptions {
  /** Milliseconds since the epoch. Default: Date.now. */
  now?: () => number;
  /** Cryptographically random bytes. Default: node:crypto randomBytes. */
  random?: (size: number) => Uint8Array;
}

export interface IdFactory {
  /** A bare ULID (26 characters). */
  ulid(): string;
  /** A prefixed ID such as "msg_01J9…". */
  id(kind: IdKind): string;
}

const encodeTime = (ms: number): string => {
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
};

export const createIdFactory = (options: IdFactoryOptions = {}): IdFactory => {
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  let lastTime = -1;
  let lastRandom: number[] = []; // base32 digits, most significant first

  const freshRandom = (): number[] => {
    const bytes = random(RANDOM_CHARS);
    return Array.from({ length: RANDOM_CHARS }, (_, i) => (bytes[i] ?? 0) % 32);
  };

  /** Add one to the random part; it only overflows after 2^80 IDs in one millisecond. */
  const increment = (digits: number[]): number[] => {
    const next = [...digits];
    for (let i = next.length - 1; i >= 0; i--) {
      const digit = next[i] ?? 0;
      if (digit < 31) {
        next[i] = digit + 1;
        return next;
      }
      next[i] = 0;
    }
    throw new Error('ULID random part overflowed within one millisecond');
  };

  const ulid = (): string => {
    const time = now();
    if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
      throw new Error(`clock returned an invalid time: ${String(time)}`);
    }
    if (time > lastTime) {
      lastTime = time;
      lastRandom = freshRandom();
    } else {
      // Same millisecond, or the clock went backwards: stay monotonic on the last time.
      lastRandom = increment(lastRandom);
    }
    return encodeTime(lastTime) + lastRandom.map((d) => CROCKFORD.charAt(d)).join('');
  };

  return { ulid, id: (kind) => `${ID_PREFIXES[kind]}_${ulid()}` };
};
