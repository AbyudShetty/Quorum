import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAs, note, startWorld, type World } from '../../adapter-mcp/test/helpers.js';
import {
  CONTENT_SECURITY_POLICY,
  createWebHandler,
  escapeHtml,
  fromApi,
  html,
  messagesFromExport,
  raw,
  type TimelineMessage,
  type TimelineSource,
  timelineFragment,
  timelinePage,
} from '../src/index.js';

const WS = 'ws_01J9ZZZZZZZZZZZZZZZZZZZZZZ';

const msg = (overrides: Partial<TimelineMessage> = {}): TimelineMessage => ({
  seq: 1,
  id: 'msg_01J9ZZZZZZZZZZZZZZZZZZZZZZ',
  from: 'agent:peer@lab',
  to: ['agent:me@lab'],
  type: 'note',
  created_at: '2026-10-03T10:00:00.000Z',
  body: { text: 'hello' },
  ...overrides,
});

const XSS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  '</pre><script>alert(1)</script>',
  '<a href="javascript:alert(1)">x</a>',
  '`${alert(1)}`',
];

describe('html template', () => {
  it('escapes interpolated values and leaves trusted markup alone', () => {
    expect(html`<p>${'<b>&"\'`'}</p>`.toString()).toBe('<p>&lt;b&gt;&amp;&quot;&#39;&#96;</p>');
    expect(html`<p>${raw('<b>ok</b>')}</p>`.toString()).toBe('<p><b>ok</b></p>');
    expect(
      html`<ul>
        ${['a', '<i>'].map((x) => html`<li>${x}</li>`)}
      </ul>`
        .toString()
        .replaceAll(/\s+/g, ' '),
    ).toBe('<ul> <li>a</li><li>&lt;i&gt;</li> </ul>');
    expect(html`${null}${undefined}${false}${true}${0}`.toString()).toBe('0');
    expect(escapeHtml('a<b')).toBe('a&lt;b');
  });
});

describe('views (hostile message content, INV-21)', () => {
  // Any tag the payloads try to open. Escaped text such as "&lt;img onerror=…" is inert and fine.
  const executable = /<(script|img|svg)\b/i;

  it.each(XSS)('renders %j as inert text in every field', (payload) => {
    const evil = msg({
      from: `agent:${payload}@lab`,
      to: [payload],
      type: payload,
      thread: payload,
      refs: [payload],
      created_at: payload,
      body: { text: payload, claim: payload },
    });
    for (const type of ['note', 'finding', 'request', payload]) {
      const out = timelineFragment([{ ...evil, type }]).toString();
      expect(out).not.toMatch(executable);
      expect(out).not.toContain(payload); // every payload has a character that must be escaped
    }
    const page = timelinePage({
      workspaces: [{ id: WS, name: payload }],
      selected: { id: WS, name: payload },
      messages: [evil],
      refreshSeconds: 3,
    }).toString();
    // The one legitimate script is our own vendored htmx; nothing else may look executable.
    const withoutOurScript = page.replace('<script src="/static/htmx.min.js" defer></script>', '');
    expect(withoutOurScript).not.toMatch(executable);
    expect(withoutOurScript).not.toContain(payload);
  });

  it('never produces inline scripts, styles or event handlers', () => {
    const out = timelinePage({
      workspaces: [{ id: WS, name: 'demo' }],
      selected: { id: WS, name: 'demo' },
      messages: [msg(), msg({ seq: 2, type: 'finding', body: { claim: 'c' } })],
      refreshSeconds: 3,
    }).toString();
    expect(out).not.toMatch(/<script(?![^>]*\bsrc=)/i); // only <script src=…>
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/\sstyle=/i);
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).toContain('src="/static/htmx.min.js"');
    expect(out).not.toMatch(/https?:\/\/(?!localhost)/); // no external origins at all
  });

  it('shows newest first, with a readable summary and the raw message folded away', () => {
    const out = timelineFragment([
      msg({ seq: 1, body: { text: 'first' } }),
      msg({ seq: 2, body: { text: 'second' } }),
    ]).toString();
    expect(out.indexOf('second')).toBeLessThan(out.indexOf('first'));
    expect(out).toContain('<details class="raw">');
  });

  it('says so when there is nothing to show', () => {
    expect(timelineFragment([]).toString()).toContain('No messages yet');
  });
});

describe('messagesFromExport', () => {
  it('keeps only accepted messages, in order, and ignores damaged lines', () => {
    const lines = [
      { seq: 1, kind: 'workspace.created', payload: {} },
      {
        seq: 2,
        kind: 'message.accepted',
        ts: 't',
        payload: {
          envelope: {
            id: 'msg_1',
            from: 'human:a',
            to: ['*'],
            type: 'note',
            created_at: 'c',
            body: { text: 'x' },
          },
        },
      },
      { seq: 3, kind: 'inbox.acked', payload: {} },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const out = messagesFromExport(`${lines}\nnot json\n`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ seq: 2, id: 'msg_1', from: 'human:a' });
  });
});

describe('web handler', () => {
  let server: Server | undefined;
  let world: World | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
    await world?.server.close();
    world = undefined;
  });

  const serve = async (source: TimelineSource) => {
    const handler = createWebHandler(source);
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  };

  const fixed: TimelineSource = {
    workspaces: () => Promise.resolve([{ id: WS, name: 'demo' }]),
    messages: () => Promise.resolve([msg({ body: { text: '<script>alert(1)</script>' } })]),
  };

  it('sends the strict CSP and hardening headers on every response', async () => {
    const base = await serve(fixed);
    for (const path of [
      '/',
      '/fragment/timeline',
      '/static/app.css',
      '/static/htmx.min.js',
      '/nope',
    ]) {
      const reply = await fetch(`${base}${path}`);
      expect(reply.headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
      expect(reply.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(reply.headers.get('referrer-policy'), path).toBe('no-referrer');
    }
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe');
  });

  it('serves the page, the fragment and its own vendored htmx', async () => {
    const base = await serve(fixed);
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('hx-get="/fragment/timeline?ws=' + WS + '"');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>alert(1)');
    const htmx = await fetch(`${base}/static/htmx.min.js`);
    expect(htmx.headers.get('content-type')).toContain('javascript');
    expect((await htmx.text()).length).toBeGreaterThan(10_000);
    expect((await fetch(`${base}/static/app.css`)).headers.get('content-type')).toContain(
      'text/css',
    );
  });

  it('is read-only, and rejects bad input without echoing it', async () => {
    const base = await serve(fixed);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    const bad = await fetch(`${base}/?ws=<script>alert(1)</script>`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('alert(1)');
    expect((await fetch(`${base}/?ws=${WS.replace('ZZZ', 'YYY')}`)).status).toBe(404);
    expect((await fetch(`${base}/missing`)).status).toBe(404);
  });

  it('does not leak internal errors', async () => {
    const base = await serve({
      workspaces: () => Promise.reject(new Error('secret db path C:\\data\\x.sqlite')),
      messages: () => Promise.resolve([]),
    });
    const reply = await fetch(`${base}/`);
    expect(reply.status).toBe(502);
    expect(await reply.text()).not.toContain('sqlite');
  });

  it('shows real messages from a /v1 server through the export (fake server)', async () => {
    world = await startWorld();
    const agent = await connectAs(world);
    await agent.send(world.workspace, note(world, world.agent.address, ['*'], 'build is green'));
    await agent.send(
      world.workspace,
      note(world, world.agent.address, ['*'], 'second note <b>bold?</b>'),
    );
    await world.store.save('human', {
      access_token: world.human.token,
      refresh_token: 'qrm_rt_' + 'x'.repeat(43),
      access_expires_at: Date.now() + 3_600_000,
    });
    const human = await connectAs(world, { credentialKey: 'human' });
    const base = await serve(fromApi(human));
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('build is green');
    expect(page).toContain('second note &lt;b&gt;bold?&lt;/b&gt;');
    expect(page).toContain(world.agent.address);
    expect(page.indexOf('second note')).toBeLessThan(page.indexOf('build is green'));
  });
});
