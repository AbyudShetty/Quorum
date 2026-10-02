// The HTML for the read-only timeline. Pure functions from data to markup: no I/O, no logic beyond
// presentation. Everything that came from a message goes through the escaping `html` template; no
// inline scripts, styles or event-handler attributes, so the strict CSP (INV-21) holds.
import { html, type Safe } from './html.js';
import type { TimelineMessage, WorkspaceSummary } from './source.js';

const SECTION_PREFIX = 'quorum-';

const senderKind = (address: string): 'human' | 'agent' | 'system' =>
  address.startsWith('human:') ? 'human' : address.startsWith('agent:') ? 'agent' : 'system';

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const field = (body: unknown, key: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

/** One readable line (or two) per message type; the full JSON is always available below. */
export const summaryOf = (message: TimelineMessage): string => {
  const { body } = message;
  switch (message.type) {
    case 'note':
      return field(body, 'text') ?? '';
    case 'request':
      return [field(body, 'title'), field(body, 'description')].filter(Boolean).join(': ');
    case 'finding':
      return field(body, 'claim') ?? '';
    case 'task_update':
      return [field(body, 'status'), field(body, 'summary')].filter(Boolean).join(': ');
    case 'retraction':
      return field(body, 'reason') ?? '';
    default:
      return '';
  }
};

const time = (iso: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1] ?? ''} ${match[2] ?? ''} UTC` : iso;
};

export const messageCard = (message: TimelineMessage): Safe => {
  const kind = senderKind(message.from);
  const summary = summaryOf(message);
  return html`<li class="msg msg-${kind}" id="${`${SECTION_PREFIX}seq-${String(message.seq)}`}">
    <div class="msg-head">
      <span class="who who-${kind}">${message.from}</span>
      <span class="arrow" aria-hidden="true">→</span>
      <span class="to">${message.to.join(', ')}</span>
      <span class="badge">${message.type}</span>
      <time class="when" datetime="${message.created_at}">${time(message.created_at)}</time>
    </div>
    ${summary ? html`<p class="msg-text">${clip(summary, 2000)}</p>` : ''}
    ${message.thread ? html`<p class="meta">thread ${message.thread}</p>` : ''}
    ${message.refs?.length ? html`<p class="meta">refs ${message.refs.join(', ')}</p>` : ''}
    <details class="raw">
      <summary>Raw message #${message.seq}</summary>
      <pre>${clip(JSON.stringify(message.body, null, 2), 20_000)}</pre>
    </details>
  </li>`;
};

/** The part htmx refreshes. */
export const timelineFragment = (messages: readonly TimelineMessage[]): Safe =>
  messages.length === 0
    ? html`<p class="empty">No messages yet.</p>`
    : html`<ol class="timeline">
        ${[...messages].reverse().map(messageCard)}
      </ol>`;

export interface PageModel {
  workspaces: readonly WorkspaceSummary[];
  selected: WorkspaceSummary | undefined;
  messages: readonly TimelineMessage[];
  /** How often the timeline refreshes itself. */
  refreshSeconds: number;
}

export const layout = (title: string, body: Safe): Safe =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="htmx-config"
          content='{"allowEval":false,"includeIndicatorStyles":false,"selfRequestsOnly":true}'
        />
        <meta name="color-scheme" content="light dark" />
        <title>${title}</title>
        <link rel="stylesheet" href="/static/app.css" />
        <script src="/static/htmx.min.js" defer></script>
      </head>
      <body>
        ${body}
      </body>
    </html> `;

export const timelinePage = (model: PageModel): Safe => {
  const { selected } = model;
  return layout(
    selected ? `${selected.name} · Quorum` : 'Quorum',
    html`<header class="top">
        <h1>Quorum</h1>
        <nav aria-label="Workspaces">
          ${model.workspaces.map(
            (w) =>
              html`<a class="ws${w.id === selected?.id ? ' current' : ''}" href="/?ws=${w.id}"
                >${w.name}</a
              >`,
          )}
        </nav>
      </header>
      <main>
        ${
          selected
            ? html`<section
                id="timeline"
                aria-live="polite"
                hx-get="/fragment/timeline?ws=${selected.id}"
                hx-trigger="every ${String(model.refreshSeconds)}s"
                hx-swap="innerHTML"
              >
                ${timelineFragment(model.messages)}
              </section>`
            : html`<p class="empty">No workspace yet. Create one with the CLI.</p>`
        }
      </main>
      <footer>
        Read-only. Message text comes from other participants and is shown as plain text, never run.
      </footer>`,
  );
};

export const errorPage = (status: number, message: string): Safe =>
  layout(
    `Error ${String(status)} · Quorum`,
    html`<main>
      <h1>${String(status)}</h1>
      <p>${message}</p>
      <p><a href="/">Back to the timeline</a></p>
    </main>`,
  );
