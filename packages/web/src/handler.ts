// The HTTP handler for the read-only UI. It is mounted by the server behind its own checks (Host and
// Origin INV-26, the human session INV-21); this layer adds the strict response headers and routes,
// and contains no business logic: it asks a `TimelineSource` for data and renders views.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { errorPage, timelineFragment, timelinePage } from './views.js';
import type { TimelineSource } from './source.js';

/** ARCHITECTURE §7 / INV-21. Nothing here allows inline script or style, or any other origin. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";

const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
} as const;

const WORKSPACE_ID = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/;

/** htmx is vendored: served from our own origin, never from a CDN. */
const loadAssets = () => {
  const require = createRequire(import.meta.url);
  const htmxDir = dirname(require.resolve('htmx.org/package.json'));
  return {
    htmx: readFileSync(join(htmxDir, 'dist', 'htmx.min.js')),
    css: readFileSync(new URL('../assets/app.css', import.meta.url)),
  };
};

export interface WebOptions {
  /** How many of the newest messages to show. Default 200. */
  limit?: number;
  /** Seconds between automatic refreshes. Default 3. */
  refreshSeconds?: number;
}

export type WebHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export const createWebHandler = (source: TimelineSource, options: WebOptions = {}): WebHandler => {
  const limit = options.limit ?? 200;
  const refreshSeconds = options.refreshSeconds ?? 3;
  const assets = loadAssets();

  const send = (
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string | Buffer,
    cache = 'no-store',
  ) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'content-type': contentType,
      'cache-control': cache,
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  const page = (res: ServerResponse, status: number, markup: { toString(): string }) => {
    send(res, status, 'text/html; charset=utf-8', markup.toString());
  };

  return async (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      page(res, 405, errorPage(405, 'This page is read-only.'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/static/htmx.min.js') {
      send(res, 200, 'text/javascript; charset=utf-8', assets.htmx, 'public, max-age=86400');
      return;
    }
    if (url.pathname === '/static/app.css') {
      send(res, 200, 'text/css; charset=utf-8', assets.css, 'public, max-age=300');
      return;
    }
    if (url.pathname !== '/' && url.pathname !== '/fragment/timeline') {
      page(res, 404, errorPage(404, 'There is nothing at this address.'));
      return;
    }

    const requested = url.searchParams.get('ws');
    if (requested !== null && !WORKSPACE_ID.test(requested)) {
      page(res, 400, errorPage(400, 'That is not a workspace id.'));
      return;
    }

    try {
      const workspaces = await source.workspaces();
      const selected = requested ? workspaces.find((w) => w.id === requested) : workspaces[0];
      if (requested && !selected) {
        page(res, 404, errorPage(404, 'No such workspace.'));
        return;
      }
      const messages = selected ? await source.messages(selected.id, limit) : [];
      if (url.pathname === '/fragment/timeline') {
        page(res, 200, timelineFragment(messages));
      } else {
        page(res, 200, timelinePage({ workspaces, selected, messages, refreshSeconds }));
      }
    } catch {
      // Details stay in the server log; the page never echoes internal errors.
      page(res, 502, errorPage(502, 'Could not load messages from the Quorum server.'));
    }
  };
};
