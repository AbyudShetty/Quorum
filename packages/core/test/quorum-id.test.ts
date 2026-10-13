import { describe, expect, it } from 'vitest';
import { checkQuorumId, isQuorumId, newQuorumId, parseQuorumId, quorumId } from '../src/index.js';

const HOME = 'NNhashC-2evXg2I2A48ifU3_c2yuhB6Wbmn4ZOrrM6I';
const OTHER = 'yvaJ9r9jJnNPAhQGe7o1VjNcT0kWy9uE24pMg3mUcwA';

describe('Quorum IDs (D-20)', () => {
  it('are short, readable and stable for a home key and salt', () => {
    const { id, salt } = newQuorumId(HOME);
    expect(id).toMatch(/^QRM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(isQuorumId(id)).toBe(true);
    expect(salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(quorumId(HOME, salt)).toBe(id);
    expect(quorumId(HOME, 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(quorumId(HOME, 'AAAAAAAAAAAAAAAAAAAAAA'));
  });

  it('can be checked: another home or salt does not give the same ID', () => {
    const { id, salt } = newQuorumId(HOME);
    expect(checkQuorumId(id, HOME, salt)).toBe(true);
    expect(checkQuorumId(id, OTHER, salt)).toBe(false);
    expect(checkQuorumId(id, HOME, newQuorumId(HOME).salt)).toBe(false);
    expect(checkQuorumId(id, HOME, 'not a salt')).toBe(false);
  });

  it('are new every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newQuorumId(HOME).id));
    expect(ids.size).toBe(200);
  });

  it('read what people type: case, dashes, prefix and look-alike letters', () => {
    const { id } = newQuorumId(HOME);
    const plain = id.slice(4).replaceAll('-', '');
    expect(parseQuorumId(id)).toBe(id);
    expect(parseQuorumId(id.toLowerCase())).toBe(id);
    expect(parseQuorumId(plain)).toBe(id);
    expect(parseQuorumId(`  qrm ${plain.slice(0, 6)} ${plain.slice(6)} `)).toBe(id);
    expect(parseQuorumId('QRM-0O1I-L000-0000')).toBe('QRM-0011-1000-0000');
    expect(parseQuorumId('QRM-UUUU-0000-0000')).toBeUndefined(); // U is not in the alphabet
    expect(parseQuorumId('QRM-1234-5678')).toBeUndefined();
    expect(parseQuorumId('hello')).toBeUndefined();
  });
});
