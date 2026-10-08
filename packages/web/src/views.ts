// The HTML for the read-only timeline. Pure functions from data to markup: no I/O, no logic beyond
// presentation. Everything that came from a message goes through the escaping `html` template; no
// inline scripts, styles or event-handler attributes, so the strict CSP (INV-21) holds.
//
// People and windows are named as the agents see them (MESSAGE_SPEC §1.1): a window as
// `claude - C:\proj\api - 10`, an agent as `claude-api@laptop`, a human as `abyud (human)`.
import { html, type Safe } from './html.js';
import type { TimelineMessage, WorkspaceSummary } from './source.js';

const SECTION_PREFIX = 'quorum-';

/** Where the timeline is read: this machine's name and home folder (to show full paths). */
export interface DisplayOptions {
  machine?: string;
  home?: string;
  /** "Today" is decided against this; defaults to now. */
  now?: Date;
}

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

const LABEL = /^([a-z][a-z0-9-]*)@(.+)-([1-9][0-9]*)$/;

/** The parts of a sender's name: tool or name, machine when another, folder, window number. */
interface Shown {
  kind: 'human' | 'agent' | 'system';
  /** `claude`, `claude-api@laptop`, `abyud`, `Quorum`. */
  name: string;
  machine?: string;
  path?: string;
  window?: string;
  /** Avatar text and colour class. */
  initials: string;
  tone: string;
}

const tone = (name: string): string =>
  name.startsWith('claude') ? 'claude' : name.startsWith('codex') ? 'codex' : 'other';

const initialsOf = (name: string): string =>
  name.startsWith('claude') ? 'Cl' : name.startsWith('codex') ? 'Cx' : name.slice(0, 2);

/** The full path on this machine (`~` expanded), the `~` form from another. */
const pathFor = (path: string, sameMachine: boolean, home?: string): string =>
  sameMachine && home && /^~(?:[\\/]|$)/.test(path)
    ? `${home.replace(/[\\/]+$/, '')}${path.slice(1)}`
    : path;

const sender = (message: TimelineMessage, options: DisplayOptions): Shown => {
  const kind = senderKind(message.from);
  const window = message.from_session;
  const parts = window ? LABEL.exec(window.label) : undefined;
  if (window && parts) {
    const [, tool = '', folder = '', number = ''] = parts;
    const same = window.machine === options.machine;
    return {
      kind,
      name: tool,
      ...(same ? {} : { machine: window.machine }),
      path: window.path ? pathFor(window.path, same, options.home) : folder,
      window: number,
      initials: initialsOf(tool),
      tone: tone(tool),
    };
  }
  if (kind === 'human') {
    const name = message.from.slice('human:'.length);
    return {
      kind,
      name: `${name} (human)`,
      initials: name.slice(0, 1).toUpperCase(),
      tone: 'human',
    };
  }
  if (kind === 'system') return { kind, name: 'Quorum', initials: 'Q', tone: 'system' };
  const name = message.from.slice('agent:'.length);
  return { kind, name, initials: initialsOf(name), tone: tone(name) };
};

/** A recipient as people read it: a window `codex - web - 10`, `everyone`, or the address. */
export const recipientName = (address: string): string => {
  if (address === '*') return 'everyone';
  if (address.startsWith('human:')) return `${address.slice('human:'.length)} (human)`;
  if (address.startsWith('agent:')) return address.slice('agent:'.length);
  const parts = LABEL.exec(address);
  return parts ? `${parts[1] ?? ''} - ${parts[2] ?? ''} - ${parts[3] ?? ''}` : address;
};

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) =>
  `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local time of day, `21:28`. */
const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** `Today`, `Yesterday`, or `Tue 6 Oct 2026`, in this machine's time zone. */
const dayLabel = (iso: string, now: Date): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

export const messageCard = (message: TimelineMessage, options: DisplayOptions = {}): Safe => {
  const who = sender(message, options);
  const summary = summaryOf(message);
  // The same text the agents see (`codex@laptop - ~/proj/web - 2`), with each part styled.
  const name = who.machine ? `${who.name}@${who.machine}` : who.name;
  const sep = html`<span class="sep"> - </span>`;
  const named = who.window
    ? html`<span class="name">${name}</span>${sep}<span class="path">${who.path ?? ''}</span
        >${sep}<span class="win">${who.window}</span>`
    : html`<span class="name">${name}</span>`;
  return html`<li class="msg msg-${who.kind}" id="${`${SECTION_PREFIX}seq-${String(message.seq)}`}">
    <div class="avatar tone-${who.tone}" aria-hidden="true">${who.initials}</div>
    <div class="content">
      <div class="head">
        <span class="who">${named}</span>
        <time class="when" datetime="${message.created_at}" title="${message.created_at}"
          >${clock(message.created_at)}</time
        >
      </div>
      <div class="to">
        to
        ${message.to.map(recipientName).join(', ')}${
          message.type === 'note' ? '' : html` <span class="badge">${message.type}</span>`
        }
      </div>
      ${
        summary
          ? html`<p class="text">${clip(summary, 2000)}</p>`
          : html`<p class="text empty-text">(no text)</p>`
      }
      <details class="raw">
        <summary>details</summary>
        <dl>
          <dt>message</dt>
          <dd>${message.id} · #${message.seq}</dd>
          <dt>from</dt>
          <dd>${message.from}</dd>
          ${
            message.thread
              ? html`<dt>thread</dt>
                  <dd>${message.thread}</dd>`
              : ''
          }
          ${
            message.refs?.length
              ? html`<dt>refs</dt>
                  <dd>${message.refs.join(', ')}</dd>`
              : ''
          }
        </dl>
        <pre>${clip(JSON.stringify(message.body, null, 2), 20_000)}</pre>
      </details>
    </div>
  </li>`;
};

/** The part htmx refreshes: newest first, under a heading per day. */
export const timelineFragment = (
  messages: readonly TimelineMessage[],
  options: DisplayOptions = {},
): Safe => {
  if (messages.length === 0) {
    return html`<p class="empty">No messages yet. They appear here as agents talk.</p>`;
  }
  const now = options.now ?? new Date();
  let day = '';
  const items: Safe[] = [];
  for (const message of [...messages].reverse()) {
    const label = dayLabel(message.created_at, now);
    if (label !== day) {
      day = label;
      items.push(html`<li class="day" role="presentation"><span>${label}</span></li>`);
    }
    items.push(messageCard(message, options));
  }
  return html`<ol class="timeline">
    ${items}
  </ol>`;
};

export interface PageModel {
  workspaces: readonly WorkspaceSummary[];
  selected: WorkspaceSummary | undefined;
  messages: readonly TimelineMessage[];
  /** How often the timeline refreshes itself. */
  refreshSeconds: number;
  display?: DisplayOptions;
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
        <div class="brand"><span class="logo" aria-hidden="true">Q</span>Quorum</div>
        <nav aria-label="Workspaces">
          <span class="nav-label">Workspace</span>
          ${model.workspaces.map(
            (w) =>
              html`<a
                class="ws${w.id === selected?.id ? ' current' : ''}"
                href="/?ws=${w.id}"
                ${w.id === selected?.id ? html`aria-current="page"` : ''}
                >${w.name}</a
              >`,
          )}
        </nav>
        ${selected ? html`<span class="live">live</span>` : ''}
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
                ${timelineFragment(model.messages, model.display)}
              </section>`
            : html`<p class="empty">
                No workspace yet. Create one with <code>quorum workspace create &lt;name&gt;</code>.
              </p>`
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
    html`<header class="top">
        <div class="brand"><span class="logo" aria-hidden="true">Q</span>Quorum</div>
      </header>
      <main class="error">
        <h1>${String(status)}</h1>
        <p>${message}</p>
        <p><a href="/">Back to the timeline</a></p>
      </main>`,
  );
