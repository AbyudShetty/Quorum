import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from '../src/index.js';

describe('canonicalJson (RFC 8785 JCS)', () => {
  it('sorts object keys and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"b":1}',
    );
  });

  it('sorts keys by UTF-16 code units, as RFC 8785 §3.2.3 requires', () => {
    // The RFC sorting example, written as escapes so editors cannot recompose the characters.
    const value = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    // Compare the text itself: parsing it back would let JavaScript move "1" to the front.
    const expectedOrder = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'];
    const expected = `{${expectedOrder
      .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key as keyof typeof value])}`)
      .join(',')}}`;
    expect(canonicalJson(value)).toBe(expected);
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes numbers the ECMAScript way (RFC 8785 §3.2.2.3)', () => {
    expect(canonicalJson([0, -0, 1e21, 1e-7, 0.1, 100, -1.5])).toBe(
      '[0,0,1e+21,1e-7,0.1,100,-1.5]',
    );
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson('line\n"quoted"\u0001')).toBe('"line\\n\\"quoted\\"\\u0001"');
  });

  it('gives the same text for the same data regardless of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: [{ b: 2, a: 1 }] })).toBe(
      canonicalJson({ y: [{ a: 1, b: 2 }], x: 1 }),
    );
  });

  it('skips undefined object members like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it.each([
    ['NaN', { n: NaN }, '/n'],
    ['Infinity', [Infinity], '/0'],
    ['a Date', { when: new Date(0) }, '/when'],
    ['a Map', { m: new Map() }, '/m'],
    ['a bigint', { big: 1n }, '/big'],
    ['undefined', undefined, ''],
  ])('rejects %s with the path to it', (_name, value, path) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    try {
      canonicalJson(value);
    } catch (error) {
      expect((error as CanonicalJsonError).path).toBe(path);
    }
  });
});
