// Bearer tokens (ARCHITECTURE §6, INV-11).
// - Prefixed, so a leaked token is recognisable (and caught by the secret scanner, INV-14).
// - 256 random bits; only the SHA-256 hash is ever stored server-side.
// - Refresh tokens rotate; presenting an already-rotated one revokes the whole family.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIXES = {
  access: 'qrm_at_',
  refresh: 'qrm_rt_',
  join: 'qrm_jc_',
  /** One-time local-mode bootstrap code: proves the caller can read the private data directory. */
  bootstrap: 'qrm_bc_',
  /** One-time web login link from `quorum ui` (single use, 60 s). */
  uiLink: 'qrm_ul_',
  /** A web UI session (the cookie value). */
  uiSession: 'qrm_us_',
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** A new random token of the given kind: prefix + 43 base64url characters (32 bytes). */
export const generateToken = (
  kind: TokenKind,
  random: (size: number) => Uint8Array = randomBytes,
): string => TOKEN_PREFIXES[kind] + Buffer.from(random(32)).toString('base64url');

/** What the server stores instead of the token (hex SHA-256). */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time comparison of a presented token against a stored hash. */
export const tokenMatches = (token: string, storedHash: string): boolean => {
  const presented = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
};

const TOKEN_SHAPE = /^qrm_(at|rt|jc|bc|ul|us)_[A-Za-z0-9_-]{43}$/;

/** The kind of a well-formed token, or undefined. Shape only: says nothing about validity. */
export const tokenKind = (token: string): TokenKind | undefined => {
  const match = TOKEN_SHAPE.exec(token);
  if (!match) return undefined;
  return (
    {
      at: 'access',
      rt: 'refresh',
      jc: 'join',
      bc: 'bootstrap',
      ul: 'uiLink',
      us: 'uiSession',
    } as const
  )[match[1] as 'at' | 'rt' | 'jc' | 'bc' | 'ul' | 'us'];
};

/** A stored refresh token (only its hash is kept). */
export interface RefreshRecord {
  /** Every token issued by rotating from the same original belongs to one family. */
  family: string;
  status: 'active' | 'rotated' | 'revoked';
  /** RFC 3339. */
  expires_at: string;
}

export type RefreshDecision =
  | { outcome: 'rotate'; family: string }
  | { outcome: 'reject'; reason: 'unknown' | 'expired' | 'revoked' }
  | { outcome: 'reject_and_revoke_family'; reason: 'reused'; family: string };

/**
 * What to do with a presented refresh token. A rotated token being presented again means
 * someone else holds a copy, so the whole family is revoked (INV-11).
 */
export const decideRefresh = (record: RefreshRecord | undefined, now: Date): RefreshDecision => {
  if (!record) return { outcome: 'reject', reason: 'unknown' };
  if (record.status === 'revoked') return { outcome: 'reject', reason: 'revoked' };
  if (record.status === 'rotated') {
    return { outcome: 'reject_and_revoke_family', reason: 'reused', family: record.family };
  }
  if (Date.parse(record.expires_at) <= now.getTime())
    return { outcome: 'reject', reason: 'expired' };
  return { outcome: 'rotate', family: record.family };
};

/** How long a local bootstrap code stays valid (ARCHITECTURE §6). */
export const BOOTSTRAP_CODE_TTL_SECONDS = 600;

/** The server's record of the current bootstrap code (only its hash is kept). */
export interface BootstrapRecord {
  hash: string;
  /** RFC 3339. */
  expires_at: string;
  used: boolean;
}

export type BootstrapDecision =
  | { outcome: 'accept' }
  | { outcome: 'reject'; reason: 'malformed' | 'unknown' | 'used' | 'expired' };

/**
 * Whether a presented local bootstrap code may be exchanged for the owner's human tokens. The
 * caller must mark the record used on "accept" before doing anything else, so the code works once.
 */
export const decideBootstrap = (
  record: BootstrapRecord | undefined,
  presented: string,
  now: Date,
): BootstrapDecision => {
  if (tokenKind(presented) !== 'bootstrap') return { outcome: 'reject', reason: 'malformed' };
  if (!record || !tokenMatches(presented, record.hash)) {
    return { outcome: 'reject', reason: 'unknown' };
  }
  if (record.used) return { outcome: 'reject', reason: 'used' };
  if (Date.parse(record.expires_at) <= now.getTime()) {
    return { outcome: 'reject', reason: 'expired' };
  }
  return { outcome: 'accept' };
};
