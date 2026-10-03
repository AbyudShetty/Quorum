import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CODE_TTL_SECONDS,
  type BootstrapRecord,
  decideBootstrap,
  decideRefresh,
  findSecrets,
  generateToken,
  hashToken,
  type RefreshRecord,
  tokenKind,
  tokenMatches,
} from '../src/index.js';

// Built from parts so this file itself never contains a complete fake secret.
const fake = (...parts: string[]) => parts.join('');

describe('findSecrets (INV-14)', () => {
  it.each([
    ['AWS access key', fake('AKIA', 'IOSFODNN7EXAMPLE')],
    ['GitHub token', fake('ghp_', 'a'.repeat(36))],
    ['GitHub token', fake('github_', 'pat_', 'A'.repeat(60))],
    ['Anthropic API key', fake('sk-', 'ant-', 'api03-', 'x'.repeat(40))],
    ['OpenAI API key', fake('sk-', 'proj-', 'y'.repeat(40))],
    ['Slack token', fake('xox', 'b-', '1234567890-abcdef')],
    ['Google API key', fake('AIza', 'S'.repeat(35))],
    ['Stripe live key', fake('sk_', 'live_', 'z'.repeat(24))],
    ['npm token', fake('npm_', 'n'.repeat(36))],
    ['Hugging Face token', fake('hf_', 'h'.repeat(34))],
    ['private key', fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----')],
    ['Quorum token', fake('qrm_', 'rt_', 'q'.repeat(43))],
    ['Quorum token', fake('qrm_', 'bc_', 'b'.repeat(43))],
  ])('finds a %s and names the field, not the value', (kind, secret) => {
    const findings = findSecrets({ notes: ['fine', `token: ${secret}`] }, '/body');
    expect(findings).toEqual([{ path: '/body/notes/1', kind }]);
  });

  it('finds secrets in object keys too', () => {
    expect(findSecrets({ [fake('AKIA', 'IOSFODNN7EXAMPLE')]: 1 })).toEqual([
      { path: `/${fake('AKIA', 'IOSFODNN7EXAMPLE')}`, kind: 'AWS access key' },
    ]);
  });

  it.each([
    'see sk-learn for clustering',
    'the AKIA prefix marks AWS keys',
    'ghp_ is the GitHub prefix',
    'run task-ant-colony',
    'hf_ token missing',
    'a sha256: ' + 'a'.repeat(64),
  ])('does not flag ordinary text: %s', (text) => {
    expect(findSecrets({ text })).toEqual([]);
  });
});

describe('tokens (INV-11)', () => {
  it('generates prefixed 256-bit tokens of each kind', () => {
    expect(generateToken('access')).toMatch(/^qrm_at_[A-Za-z0-9_-]{43}$/);
    expect(generateToken('refresh')).toMatch(/^qrm_rt_/);
    expect(generateToken('join')).toMatch(/^qrm_jc_/);
    expect(generateToken('bootstrap')).toMatch(/^qrm_bc_[A-Za-z0-9_-]{43}$/);
    expect(generateToken('access')).not.toBe(generateToken('access'));
  });

  it('is caught by the secret scanner if leaked into a message', () => {
    expect(findSecrets({ text: `my token is ${generateToken('access')}` })[0]?.kind).toBe(
      'Quorum token',
    );
  });

  it('stores only a hash and compares it in constant time', () => {
    const token = generateToken('access');
    const stored = hashToken(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token.slice(7));
    expect(tokenMatches(token, stored)).toBe(true);
    expect(tokenMatches(generateToken('access'), stored)).toBe(false);
    expect(tokenMatches(token, 'not-hex')).toBe(false);
  });

  it('recognises token kinds by shape only', () => {
    expect(tokenKind(generateToken('refresh'))).toBe('refresh');
    expect(tokenKind(generateToken('bootstrap'))).toBe('bootstrap');
    expect(tokenKind('Bearer something')).toBeUndefined();
    expect(tokenKind(`${generateToken('access')}x`)).toBeUndefined();
  });

  describe('refresh rotation', () => {
    const now = new Date('2026-10-02T10:00:00Z');
    const record = (
      status: RefreshRecord['status'],
      expires = '2026-11-01T00:00:00Z',
    ): RefreshRecord => ({
      family: 'fam_1',
      status,
      expires_at: expires,
    });

    it('rotates an active, unexpired token', () => {
      expect(decideRefresh(record('active'), now)).toEqual({ outcome: 'rotate', family: 'fam_1' });
    });

    it('revokes the whole family when a rotated token is reused', () => {
      expect(decideRefresh(record('rotated'), now)).toEqual({
        outcome: 'reject_and_revoke_family',
        reason: 'reused',
        family: 'fam_1',
      });
    });

    it.each([
      ['unknown', undefined],
      ['revoked', record('revoked')],
      ['expired', record('active', '2026-10-02T09:59:59Z')],
    ])('rejects a %s token', (reason, rec) => {
      expect(decideRefresh(rec, now)).toEqual({ outcome: 'reject', reason });
    });
  });
});

describe('local bootstrap codes', () => {
  const now = new Date('2026-10-02T10:00:00Z');
  const code = generateToken('bootstrap');
  const record = (over: Partial<BootstrapRecord> = {}): BootstrapRecord => ({
    hash: hashToken(code),
    expires_at: '2026-10-02T10:10:00Z',
    used: false,
    ...over,
  });

  it('accepts the current code once it is presented before expiry', () => {
    expect(decideBootstrap(record(), code, now)).toEqual({ outcome: 'accept' });
  });

  it.each([
    ['malformed', record(), 'qrm_bc_short'],
    ['malformed', record(), generateToken('access')],
    ['unknown', undefined, code],
    ['unknown', record(), generateToken('bootstrap')],
    ['used', record({ used: true }), code],
    ['expired', record({ expires_at: '2026-10-02T10:00:00Z' }), code],
  ])('rejects a %s code', (reason, rec, presented) => {
    expect(decideBootstrap(rec, presented, now)).toEqual({ outcome: 'reject', reason });
  });

  it('lasts ten minutes', () => {
    expect(BOOTSTRAP_CODE_TTL_SECONDS).toBe(600);
  });
});
