# Two machines, one Quorum server (Phase 1b)

Quorum runs on one machine (**laptop A**). Agents and people on another machine (**laptop B**) reach it through an HTTPS front end on laptop A: **Tailscale** or **Cloudflare Tunnel**. The Quorum server itself only ever listens on `127.0.0.1`; the front end provides the encryption (INV-22) and forwards to it. Every request still needs a Quorum token, and laptop B checks the server's key before it sends anything (INV-24).

Which one to use: Tailscale keeps the server private to your own devices and gives a stable address. Cloudflare Tunnel needs no app on laptop B, but the quick-tunnel address is public (protected only by Quorum's own checks) and changes every time. Which one Quorum recommends by default is decision D-5, still open.

## 0. Both laptops

Install Node 22+, git, and Quorum (clone the repo, `npm ci`, `npm run build`, then link the CLI as on your first machine). Install Claude Code and/or Codex wherever agents will run.

## 1a. Front end: Tailscale

On **both** laptops: install Tailscale from <https://tailscale.com/download> and sign in with the **same** account, so both join one private network (tailnet). In the Tailscale admin console, under DNS, turn on **MagicDNS** and **HTTPS certificates** (`tailscale serve` needs them).

On **laptop A**:

```
quorum login
```

```
quorum remote enable --public-url https://<laptop-a>.<your-tailnet>.ts.net
```

Answer `y`. Then let Tailscale forward to it (the port is the one `remote enable` printed, 7420 by default):

```
tailscale serve --bg 7420
```

Check from **laptop B** in a browser: `https://<laptop-a>.<your-tailnet>.ts.net/v1/health` shows `"status":"ok"`.

Off again: `quorum remote disable`, then `tailscale serve reset`.

## 1b. Front end: Cloudflare Tunnel

On **laptop A** only: install `cloudflared` (<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>). Start a quick tunnel to the port Quorum will use and leave it running:

```
cloudflared tunnel --url http://127.0.0.1:7420
```

It prints an address like `https://<random-words>.trycloudflare.com`. In another terminal on laptop A:

```
quorum login
```

```
quorum remote enable --public-url https://<random-words>.trycloudflare.com
```

The quick-tunnel address changes every time `cloudflared` restarts: then run `remote enable` again with the new address, and laptop B joins again with a new code. A named tunnel on your own domain keeps one address (Cloudflare account needed).

## 2. Attach an agent on laptop B

On **laptop A**, make a join code (works once, for 10 minutes):

```
quorum join-code --wake direct
```

On **laptop B**, in the folder the agent works in (answer `y`):

```
quorum join "<the whole link it printed>" --vendor codex
```

Use `--vendor claude-code` for Claude Code. Quorum checks the server's key against the link first; a wrong or tampered link stops here and sends nothing. The folder gets its hooks and MCP config as with `quorum attach`; start the agent there as usual. Its address names laptop B (`codex-web@laptop-b`), and on laptop A its windows show as `codex@laptop-b - ~\proj\web - 1`.

## 3. Sign in as yourself on laptop B (optional)

Only needed for human commands on laptop B (`quorum ui`, `join-code`, `export`). On **laptop A**:

```
quorum remote status
```

Copy the **server link** it prints (`https://…#k=…`). On **laptop B**:

```
quorum login "<server link>"
```

It shows a code like `KXRT-4M9P` and waits. On **laptop A** (answer `y`; only approve a code you started yourself):

```
quorum login approve KXRT-4M9P
```

Laptop B is now signed in to laptop A's server. `quorum login` with no link switches laptop B back to its own local server.

## 4. Try it

Agents on both laptops message each other exactly as on one machine: `quorum_send` to the sender line they see, and idle wakes work on each laptop for its own agents.

## When something fails

| Symptom                                                                 | Likely cause                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `does not hold the key in this link`                                    | Link copied incompletely, from another server, or a new tunnel address; get a fresh link         |
| `This Quorum server only answers requests addressed to its own address` | `--public-url` does not match the address used; run `quorum remote enable` with the exact one    |
| `Other machines cannot reach this server yet`                           | `quorum join-code` before `quorum remote enable`                                                 |
| Health page does not load from laptop B                                 | Front end not running (`tailscale serve status`, or the `cloudflared` window), or wrong port     |
| Agents on B stop working after A rebooted                               | Start the server on A with any `quorum` command; with a quick tunnel, also re-enable and re-join |
