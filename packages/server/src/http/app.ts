// The /v1 HTTP API on Fastify (ARCHITECTURE §5). Only translation lives here: requests to service
// calls, DomainErrors to ErrorResponses (MESSAGE_SPEC §6). Every rule is in the service or core.
import { homedir } from 'node:os';
import { DomainError } from '@quorum/core';
import { type DeliveredEnvelope, validateApiPayload } from '@quorum/schemas';
import {
  CONTENT_SECURITY_POLICY,
  createWebHandler,
  errorPage,
  messagesFromExport,
  type TimelineSource,
  type WebHandler,
} from '@quorum/web';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { LocalBootstrap } from '../local/bootstrap.js';
import type { ServerInstance } from '../local/instance.js';
import { checkLocalRequest } from '../local/request-guard.js';
import type { Caller, Quorum } from '../service/quorum.js';
import { RateLimiter, RateLimitError } from '../service/rate-limit.js';

/** A request body may be up to 1 MiB; message bodies are limited to 96 KiB by the schema. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
const SSE_KEEPALIVE_MS = 15_000;

const STATUS: Record<DomainError['kind'], number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
};

export interface AppOptions {
  quorum: Quorum;
  instance: ServerInstance;
  version: string;
  mode: 'local' | 'remote';
  /** Local mode: the one-time code that signs in the owner (ARCHITECTURE §6). */
  bootstrap?: LocalBootstrap;
  /** The port being listened on, for the local Host check (INV-26). */
  port: () => number;
  /** Called on every request, e.g. for idle shutdown. */
  onActivity?: () => void;
  /** Requests per minute per client address on routes that need no token (INV-23). */
  openRequestsPerMinute?: number;
}

const toResponse = (error: unknown): { status: number; body: unknown; retryAfter?: number } => {
  if (error instanceof DomainError) {
    return {
      status: STATUS[error.kind],
      body: error.toResponse(),
      ...(error instanceof RateLimitError ? { retryAfter: error.retryAfterSeconds } : {}),
    };
  }
  const fastifyError = error as { statusCode?: number; code?: string };
  if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      status: 413,
      body: new DomainError(
        'too_large',
        'request.too_large',
        'The request is larger than 1 MiB.',
        'Put large content in an artifact and reference it.',
      ).toResponse(),
    };
  }
  const status = fastifyError.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const media = fastifyError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    return {
      status: 400,
      body: new DomainError(
        'invalid',
        media ? 'request.unsupported_media_type' : 'request.bad_json',
        media ? 'Request bodies must be JSON.' : 'The body is not valid JSON.',
        'Send "Content-Type: application/json" with a JSON body.',
      ).toResponse(),
    };
  }
  // Never echo internals: they could contain paths or values the caller should not see.
  return {
    status: 500,
    body: {
      error: {
        code: 'server.internal',
        message: 'The server hit an unexpected error.',
        fix: 'Try again; if it keeps happening, check the server log and report it.',
      },
    },
  };
};

/** The web UI session cookie (ARCHITECTURE §6). */
const UI_COOKIE = 'quorum_ui';

/** One cookie's value from the Cookie header, if present. */
const cookie = (request: FastifyRequest, name: string): string | undefined => {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
};

/** A small HTML page with the UI's security headers (sign-in problems). */
const uiPage = (reply: FastifyReply, status: number, message: string) =>
  reply
    .code(status)
    .header('content-security-policy', CONTENT_SECURITY_POLICY)
    .header('referrer-policy', 'no-referrer')
    .header('content-type', 'text/html; charset=utf-8')
    .send(errorPage(status, message).toString());

/** The timeline as one human sees it: their workspaces and the messages in their export. */
const timelineOf = (quorum: Quorum, viewer: Caller): TimelineSource => ({
  workspaces: () =>
    Promise.resolve(
      quorum.listWorkspaces(viewer).workspaces.map((w) => ({ id: w.id, name: w.name })),
    ),
  messages: async (workspace, limit) =>
    messagesFromExport(await quorum.exportEvents(viewer, workspace)).slice(-limit),
});

/** For the public asset routes, which never read data. */
const NO_TIMELINE: TimelineSource = {
  workspaces: () => Promise.resolve([]),
  messages: () => Promise.resolve([]),
};

const bearer = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
};

/** A non-negative integer query parameter, or undefined when absent; 400 when malformed. */
const intParam = (
  request: FastifyRequest,
  name: string,
  range: { min: number; max: number },
): number | undefined => {
  const raw = (request.query as Record<string, unknown>)[name];
  if (raw === undefined) return undefined;
  const value = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= range.min && value <= range.max)) {
    throw new DomainError(
      'invalid',
      'request.bad_query',
      `Query parameter "${name}" must be an integer from ${String(range.min)} to ${String(range.max)}.`,
      `Fix "${name}" in the query string.`,
    );
  }
  return value;
};

export const buildApp = (options: AppOptions): FastifyInstance => {
  const { quorum } = options;
  const app = Fastify({
    logger: false, // tokens travel in headers and bodies: nothing is logged by default (INV-11)
    bodyLimit: MAX_REQUEST_BYTES,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
  });
  const openLimit = new RateLimiter(options.openRequestsPerMinute ?? 120, 60_000);
  const authFailureLimit = new RateLimiter(30, 60_000);
  const bootstrapLimit = new RateLimiter(10, 60_000);
  const uiLoginLimit = new RateLimiter(20, 60_000);

  const caller = (request: FastifyRequest): Caller => {
    try {
      // The calling window, when the adapter names it (verified by the service, INV-7).
      const session = request.headers['quorum-session'];
      return quorum.authenticate(
        bearer(request),
        typeof session === 'string' && /^sess_[0-9A-HJKMNP-TV-Z]{26}$/.test(session)
          ? session
          : undefined,
      );
    } catch (error) {
      // Guessing tokens costs: repeated failures from one address are throttled (INV-23).
      authFailureLimit.take(request.ip, 'failed sign-ins');
      throw error;
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    const { status, body, retryAfter } = toResponse(error);
    if (retryAfter !== undefined) void reply.header('retry-after', String(retryAfter));
    void reply.code(status).send(body);
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply
      .code(404)
      .send(
        new DomainError(
          'not_found',
          'route.not_found',
          'There is no such API route.',
          'See packages/schemas/openapi.v1.json for the /v1 API.',
        ).toResponse(),
      );
  });

  app.addHook('onRequest', async (request, reply) => {
    options.onActivity?.();
    void reply.header('cache-control', 'no-store');
    void reply.header('x-content-type-options', 'nosniff');
    if (options.mode === 'local') {
      const refused = checkLocalRequest(
        { method: request.method, host: request.headers.host, origin: request.headers.origin },
        options.port(),
      );
      if (refused) throw refused;
    }
    if (!request.headers.authorization) openLimit.take(request.ip, 'requests without a token');
    return Promise.resolve();
  });

  // --- open routes -----------------------------------------------------------------------------

  app.get('/v1/health', () => ({
    status: 'ok',
    spec: 'quorum/1',
    version: options.version,
    instance_id: options.instance.instanceId,
  }));

  app.post('/v1/hello', (request) => {
    const checked = validateApiPayload('helloRequest', request.body);
    if (!checked.ok) {
      throw new DomainError(
        'invalid',
        'request.invalid',
        'The nonce must be 32 random bytes, base64url without padding.',
        'Send {"nonce": "<43 base64url characters>"}.',
        '/nonce',
      );
    }
    return options.instance.hello(checked.value.nonce);
  });

  app.post('/v1/auth/refresh', (request) => quorum.refresh(request.body));

  app.post('/v1/auth/local-bootstrap', async (request) => {
    const bootstrap = options.bootstrap;
    if (options.mode !== 'local' || !bootstrap) {
      throw new DomainError(
        'not_found',
        'auth.bootstrap_unavailable',
        'This server is not in local mode, so it has no bootstrap code.',
        'Sign in with a join code from the server owner.',
      );
    }
    bootstrapLimit.take(request.ip, 'bootstrap attempts');
    const checked = validateApiPayload('localBootstrapRequest', request.body);
    if (!checked.ok) {
      throw new DomainError(
        'invalid',
        'request.invalid',
        'The bootstrap code is malformed.',
        'Send the `code` from <data dir>/local/bootstrap.json (`quorum login` does this).',
        '/code',
      );
    }
    const decision = await bootstrap.redeem(checked.value.code);
    if (decision.outcome !== 'accept') {
      throw new DomainError(
        'unauthorized',
        'auth.bootstrap_invalid',
        'This bootstrap code is wrong, expired or already used.',
        'Restart the local server (`quorum stop`, then any command) to get a new code, then run `quorum login`.',
      );
    }
    return quorum.signInOwner();
  });

  // --- web UI (ARCHITECTURE §7): `quorum ui` → one-time link → session cookie → timeline -------

  app.post('/v1/auth/ui-link', async (request, reply) =>
    reply.code(201).send(quorum.createUiLink(caller(request))),
  );

  // The link is opened in the browser: spend it, set the session cookie, go to the timeline. The
  // Host check above already ran (INV-26); the cookie is HttpOnly, Secure (localhost is a secure
  // context) and SameSite=Strict (INV-21).
  app.get('/login', async (request, reply) => {
    uiLoginLimit.take(request.ip, 'web sign-in attempts');
    const code = (request.query as Record<string, unknown>).code;
    let opened: { session: string; maxAgeSeconds: number };
    try {
      opened = quorum.openUiSession(typeof code === 'string' ? code : undefined);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return uiPage(reply, 401, error.message + ' Run `quorum ui` again.');
    }
    return reply
      .code(303)
      .header('referrer-policy', 'no-referrer')
      .header(
        'set-cookie',
        `${UI_COOKIE}=${opened.session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${String(opened.maxAgeSeconds)}`,
      )
      .header('location', '/')
      .send();
  });

  // The timeline and its assets. Pages need the session; the vendored assets are public files.
  const webHandlers = new Map<string, WebHandler>();
  const web = async (request: FastifyRequest, reply: FastifyReply, needsSession: boolean) => {
    let viewer: Caller | undefined;
    if (needsSession) {
      try {
        viewer = quorum.authenticateUi(cookie(request, UI_COOKIE));
      } catch {
        authFailureLimit.take(request.ip, 'failed sign-ins');
        return uiPage(
          reply,
          401,
          'Not signed in. Run `quorum ui` in a terminal and open its link.',
        );
      }
    }
    const key = viewer?.id ?? '';
    let handler = webHandlers.get(key);
    if (!handler) {
      handler = createWebHandler(viewer ? timelineOf(quorum, viewer) : NO_TIMELINE, {
        display: { machine: quorum.machine, home: homedir() },
      });
      webHandlers.set(key, handler);
    }
    void reply.hijack();
    await handler(request.raw, reply.raw);
  };
  for (const path of ['/', '/fragment/timeline']) {
    app.get(path, (request, reply) => web(request, reply, true));
  }
  for (const path of ['/static/htmx.min.js', '/static/app.css']) {
    app.get(path, (request, reply) => web(request, reply, false));
  }

  // --- setup -----------------------------------------------------------------------------------

  app.get('/v1/workspaces', (request) => quorum.listWorkspaces(caller(request)));

  app.post('/v1/workspaces', async (request, reply) => {
    const created = quorum.createWorkspace(caller(request), request.body);
    return reply.code(201).send(created);
  });

  app.post('/v1/attachments', async (request, reply) => {
    const created = await quorum.createAttachment(caller(request), request.body);
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { attachment: string } }>('/v1/attachments/:attachment', (request) =>
    quorum.updateAttachment(caller(request), request.params.attachment, request.body),
  );

  app.delete<{ Params: { attachment: string } }>(
    '/v1/attachments/:attachment',
    async (request, reply) => {
      quorum.deleteAttachment(caller(request), request.params.attachment);
      return reply.code(204).send();
    },
  );

  app.post('/v1/sessions', async (request, reply) => {
    const created = quorum.createSession(caller(request), request.body);
    return reply.code(201).send(created);
  });

  app.delete<{ Params: { session: string } }>('/v1/sessions/:session', async (request, reply) => {
    quorum.endSession(caller(request), request.params.session);
    return reply.code(204).send();
  });

  app.post<{ Params: { agent: string } }>('/v1/agents/:agent/revoke', async (request, reply) => {
    quorum.revokeAgent(caller(request), request.params.agent);
    return reply.code(204).send();
  });

  // --- messages --------------------------------------------------------------------------------

  type WsParams = { Params: { workspace: string } };

  app.post<WsParams>('/v1/workspaces/:workspace/messages', async (request, reply) => {
    const { status, body } = quorum.sendMessage(
      caller(request),
      request.params.workspace,
      request.body,
    );
    return reply.code(status).send(body);
  });

  app.get<WsParams>('/v1/workspaces/:workspace/inbox', (request) => {
    const after = intParam(request, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const limit = intParam(request, 'limit', { min: 1, max: 500 });
    return quorum.inbox(caller(request), request.params.workspace, {
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    });
  });

  app.post<WsParams>('/v1/workspaces/:workspace/inbox/ack', async (request, reply) => {
    quorum.ack(caller(request), request.params.workspace, request.body);
    return reply.code(204).send();
  });

  app.get<{ Params: { workspace: string; thread: string } }>(
    '/v1/workspaces/:workspace/threads/:thread/messages',
    (request) => {
      const after = intParam(request, 'after', { min: 0, max: Number.MAX_SAFE_INTEGER });
      const limit = intParam(request, 'limit', { min: 1, max: 500 });
      return quorum.thread(caller(request), request.params.workspace, request.params.thread, {
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      });
    },
  );

  app.post<WsParams>('/v1/workspaces/:workspace/wake', (request) =>
    quorum.requestWake(caller(request), request.params.workspace, request.body),
  );

  app.get<WsParams>('/v1/workspaces/:workspace/agents', (request) =>
    quorum.agents(caller(request), request.params.workspace),
  );

  app.get<WsParams>('/v1/workspaces/:workspace/export', async (request, reply) => {
    const text = await quorum.exportEvents(caller(request), request.params.workspace);
    return reply.type('application/x-ndjson').send(text);
  });

  app.get<WsParams>('/v1/workspaces/:workspace/stream', (request, reply) => {
    openStream(quorum, caller(request), request, reply);
  });

  return app;
};

/** Server-Sent Events: `id: <seq>`, `event: message`, JSON data (MESSAGE_SPEC §4). */
const openStream = (
  quorum: Quorum,
  who: Caller,
  request: FastifyRequest<{ Params: { workspace: string } }>,
  reply: FastifyReply,
): void => {
  const header = request.headers['last-event-id'];
  const lastEventId =
    typeof header === 'string' && /^\d{1,15}$/.test(header) ? Number(header) : undefined;
  // Checks run before the stream opens, so failures still get a normal error response.
  let closed = false;
  const raw = reply.raw;
  const pending: DeliveredEnvelope[] = [];
  let started = false;
  const write = (message: DeliveredEnvelope) => {
    raw.write(`id: ${String(message.seq)}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    raw.end();
  };
  const unsubscribe = quorum.subscribe(who, request.params.workspace, lastEventId, {
    send: (message) => {
      if (started) write(message);
      else pending.push(message);
    },
    close,
  });
  reply.hijack();
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  raw.write(': open\n\n');
  started = true;
  for (const message of pending.splice(0)) write(message);
  const keepalive = setInterval(() => raw.write(': keepalive\n\n'), SSE_KEEPALIVE_MS);
  keepalive.unref();
  request.raw.on('close', close);
};
