import { describe, expect, it } from 'vitest';
import { createIdFactory } from '../src/index.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('createIdFactory', () => {
  it('makes valid prefixed IDs for every kind', () => {
    const ids = createIdFactory();
    expect(ids.id('message')).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids.id('event')).toMatch(/^ev_/);
    expect(ids.id('session')).toMatch(/^sess_/);
    expect(ids.ulid()).toMatch(ULID);
  });

  it('encodes the time in the first 10 characters', () => {
    const ids = createIdFactory({ now: () => 0, random: () => new Uint8Array(16) });
    expect(ids.ulid()).toBe('0'.repeat(26));
    // The example from the ULID specification: 1469918176385 → 01ARYZ6S41…
    const spec = createIdFactory({ now: () => 1_469_918_176_385 });
    expect(spec.ulid().slice(0, 10)).toBe('01ARYZ6S41');
  });

  it('is strictly increasing within one millisecond', () => {
    const ids = createIdFactory({ now: () => 1_000 });
    const made = Array.from({ length: 1000 }, () => ids.ulid());
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
  });

  it('stays increasing when the clock goes backwards', () => {
    let time = 5_000;
    const ids = createIdFactory({ now: () => time });
    const first = ids.ulid();
    time = 4_000;
    const second = ids.ulid();
    expect(second > first).toBe(true);
    expect(second.slice(0, 10)).toBe(first.slice(0, 10));
  });

  it('carries into higher digits when the random part ends in Z', () => {
    const ids = createIdFactory({ now: () => 1, random: () => new Uint8Array(16).fill(31) });
    const first = ids.ulid(); // random part ZZZZZZZZZZZZZZZZ
    expect(() => ids.ulid()).toThrow(/overflowed/);
    expect(first.endsWith('Z'.repeat(16))).toBe(true);
  });

  it('rejects an impossible clock', () => {
    expect(() => createIdFactory({ now: () => -1 }).ulid()).toThrow(/invalid time/);
    expect(() => createIdFactory({ now: () => 2 ** 48 }).ulid()).toThrow(/invalid time/);
  });
});
