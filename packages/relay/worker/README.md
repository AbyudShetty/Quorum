# The hosted relay (Cloudflare Workers, free plan)

The same pairing logic as `quorum relay` (`../src/router.ts`), run as a Cloudflare Worker with one Durable Object per home server. Free plan limits (checked 2026-10-13): 100,000 requests a day, 13,000 GB-s of Durable Object time a day; incoming WebSocket messages count 20 to a request, and idle connections cost nothing thanks to the Hibernation API. Keepalive pings are answered without waking the object.

## Deploy (once, by a maintainer)

1. Make a free Cloudflare account at <https://dash.cloudflare.com/sign-up> (no card needed for Workers' free plan).
2. In this folder:

   ```
   npx wrangler login
   ```

   ```
   npx wrangler deploy
   ```

   It prints the address, like `https://quorum-relay.<your-subdomain>.workers.dev`.

3. Check it: open `https://quorum-relay.<your-subdomain>.workers.dev/health` in a browser; it shows `{"status":"ok","relay":"quorum-relay/1"}`.
4. Make it the default: set `HOSTED_RELAY` in `packages/cli/src/cli.ts` to `wss://quorum-relay.<your-subdomain>.workers.dev`.

Deployed 2026-10-13 by abyud as `https://quorum-relay.abyud.workers.dev`, the default in the CLI. To update it after changing the relay, run `npx wrangler deploy` again.

`wrangler` is not a dependency of the repository: `npx` fetches it when you deploy. Its settings are in `packages/relay/wrangler.toml` (next to `package.json`, where `npx` runs it); the commands work from `packages/relay` or this folder.
