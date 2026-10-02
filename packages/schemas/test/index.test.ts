import { describe, expect, it } from 'vitest';
import { SPEC_VERSION } from '../src/index.js';

describe('@quorum/schemas', () => {
  it('declares the quorum/1 protocol version from MESSAGE_SPEC §2', () => {
    expect(SPEC_VERSION).toBe('quorum/1');
  });
});
