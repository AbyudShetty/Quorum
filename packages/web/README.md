# @quorum/web

Track: **B**. The read-only web timeline: server-rendered HTML with HTMX (ARCHITECTURE §7). The server (Track A) mounts `createWebHandler` behind its own checks; this package holds the templates and views and contains no business logic.

```ts
import { createWebHandler, fromApi } from '@quorum/web';

const handler = createWebHandler(fromApi(humanClient)); // (req, res) => Promise<void>
```

| Route                     | What                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `GET /?ws=<ws_id>`        | Timeline page for a workspace (the first one if `ws` is omitted) |
| `GET /fragment/timeline`  | The refreshable part (HTMX polls it every 3 s)                   |
| `GET /static/htmx.min.js` | Vendored HTMX (`htmx.org`, 0BSD), served from our own origin     |
| `GET /static/app.css`     | Styles (light and dark, phone width first)                       |

## Security (INV-21)

- Every response carries the CSP from ARCHITECTURE §7 (`default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`), `nosniff`, `Referrer-Policy: no-referrer`.
- Templates auto-escape every interpolation (`html` tag in `src/html.ts`); message text is never passed to `raw`. No inline script, style or event-handler attributes, no external origins. HTMX is configured with `allowEval: false`, `selfRequestsOnly: true`.
- Read-only: anything but GET/HEAD is 405. Bad `ws` values are rejected without being echoed. Internal errors become a generic 502.
- Authentication, Host/Origin checks (INV-26) and the human session are the server's job; this handler assumes they ran.

## Where it runs

The local server mounts the handler at its root (`/`, `/fragment/timeline`, `/static/*`; the API stays under `/v1`). `quorum ui` asks `POST /v1/auth/ui-link` for a one-time code (`qrm_ul_…`, single use, 60 s) and prints `http://localhost:<port>/login?code=…`; `GET /login` spends it and sets the session cookie `quorum_ui` (`qrm_us_…`, 12 h, `HttpOnly; Secure; SameSite=Strict`). Pages need the cookie; the vendored assets do not. The server's Host check (INV-26) runs first on every route. Sessions live in memory: a server restart signs the browser out (run `quorum ui` again). `localhost` is a secure context, so browsers keep the `Secure` cookie over plain HTTP there.

## Data

`TimelineSource` is the only dependency. `fromApi(client)` builds one from the public `/v1` API (workspace list plus the human's event-log export), so the UI also works against the fake server. The real server may implement `TimelineSource` directly on its message projection.

## Known gaps (first part)

- The timeline refreshes by polling, not by the SSE extension named in ARCHITECTURE §7; switching later needs the HTMX SSE extension vendored too.
- No approval queue yet (Phase 2), no Playwright phone/desktop runs yet.
- Every refresh re-reads the exported log; fine for local use, to be replaced by an indexed read on the server side.
