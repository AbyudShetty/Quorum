import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A fresh ULID (48-bit time + 80 random bits, Crockford base32). */
export const ulid = (): string => {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = '';
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD.charAt((bytes[i] ?? 0) % 32);
  return timePart + randomPart;
};

export interface Reply {
  status: number;
  body: unknown;
}

/** JSON request with an optional bearer token. */
export const call = async (
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body: keep the text so assertions show what came back.
  }
  return { status: response.status, body };
};

/**
 * A request with a forged Host header. fetch() does not allow setting Host, so this uses
 * node:http directly (DNS-rebinding simulation, INV-26).
 */
export const callWithHost = (baseUrl: string, path: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: { host },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });

/**
 * Open an SSE stream and return the first `message` event whose id matches, or undefined
 * after the timeout. Minimal parser: enough for `id:`, `event:` and single-line `data:`.
 */
export const firstStreamEvent = async (
  url: string,
  token: string,
  lastEventId: string,
  wantId: string,
  timeoutMs = 5000,
): Promise<{ id: string; event: string; data: unknown } | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'last-event-id': lastEventId,
      },
      signal: controller.signal,
    });
    if (!response.body) return undefined;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block
            .split('\n')
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        const id = field('id');
        if (id === wantId) {
          return {
            id,
            event: field('event') ?? 'message',
            data: JSON.parse(field('data') ?? 'null') as unknown,
          };
        }
      }
    }
    return undefined;
  } catch (error) {
    if (controller.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};
