// RFC 8785 JSON Canonicalization Scheme (JCS), used for every hash and signature (MESSAGE_SPEC §3).
// JCS is defined in terms of ECMAScript's own JSON serialization, so for JSON values it is:
// object keys sorted by UTF-16 code units, no whitespace, JSON.stringify for strings and numbers.

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    /** JSON Pointer to the offending value. */
    readonly path: string,
  ) {
    super(`${message} at "${path}"`);
    this.name = 'CanonicalJsonError';
  }
}

const pointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

const serialize = (value: unknown, path: string): string => {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new CanonicalJsonError('NaN and Infinity are not JSON', path);
    return JSON.stringify(value); // ES number serialization, as JCS requires; -0 becomes 0
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item, pointer(path, i))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(
        'only plain objects are JSON (convert Dates and Maps first)',
        path,
      );
    }
    const entries = Object.entries(value as Record<string, unknown>);
    // Absent and undefined are the same thing in JSON; skip undefined like JSON.stringify does.
    const present = entries.filter(([, v]) => v !== undefined);
    present.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // UTF-16 code unit order
    return `{${present.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, pointer(path, k))}`).join(',')}}`;
  }
  throw new CanonicalJsonError(`${typeof value} is not JSON`, path);
};

/** The canonical JSON text of a JSON value. Throws `CanonicalJsonError` for anything that is not JSON. */
export const canonicalJson = (value: unknown): string => serialize(value, '');
