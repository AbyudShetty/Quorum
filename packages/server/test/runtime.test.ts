import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/database.js';

describe('native runtime boundary', () => {
  it('rejects an insufficient Node-API before loading the SQLite native binding', () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'napi');
    if (!original) throw new Error('Missing Node-API version descriptor.');
    Object.defineProperty(process.versions, 'napi', { ...original, value: '9' });
    try {
      expect(() => openDatabase(':memory:')).toThrow('Quorum SQLite requires Node-API 10');
    } finally {
      Object.defineProperty(process.versions, 'napi', original);
    }
    const db = openDatabase(':memory:');
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(6);
    } finally {
      db.close();
    }
  });
});
