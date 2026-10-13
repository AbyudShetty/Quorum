# Two machines, one Quorum workspace (Phase 1b)

The workspace lives on one machine, the **home machine** (**laptop A**). Agents and people on another machine (**laptop B**) reach it through the **Quorum relay** by default: both laptops connect _out_ to the relay, so there is no VPN to install, no port to open and no tunnel to run (DECISIONS D-18). Inside the relay connection, laptop B talks TLS 1.3 straight to laptop A's server and checks its key against the invite first, so the relay cannot read or change anything (INV-33). Every request still needs a Quorum token.

Tailscale and Cloudflare Tunnel still work as alternatives (further down).

## 0. Both laptops

Install Node 22.12+ and Quorum: `npm install -g <the package file>` (built with `npm run pack:release`; see the README). Install Claude Code and/or Codex wherever agents will run.

The default relay is Quorum's hosted one, `wss://quorum-relay.abyud.workers.dev` (free). To use another, add `--relay wss://<relay>` to the first `quorum invite` (or set `QUORUM_RELAY`); you can run your own with `quorum relay`, behind HTTPS, or deploy the same Cloudflare Worker ([packages/relay/worker/README.md](../packages/relay/worker/README.md)).

## 1. Laptop A: invite

In a terminal (not inside an agent), the first time only:

```
quorum login
```

```
quorum workspace create demo
```

Then, every time you want to attach a folder on another machine:

```
quorum invite --wake direct
```

The first time it asks to turn on remote access through the relay: answer `y`. It prints one line to run on laptop B, valid once, for 10 minutes:

```
quorum join "quorum://<relay>/<key>#k=<key>&j=qrm_jc_…" --vendor <claude-code|codex>
```

Laptop A must stay on (and awake) while agents on other machines work with it; the server stays running while remote access is on. After a reboot, run any `quorum` command to start it.

## 2. Laptop B: join

In a terminal, go to the folder the agent will work in, paste the line from laptop A with the right vendor, and answer `y`:

```
cd C:\path\to\your\project
```

```
quorum join "quorum://…" --vendor codex
```

Quorum checks laptop A's key against the invite before it sends anything; a wrong or tampered invite stops here. Start Codex (or Claude Code) in that folder as usual. Its windows show on laptop A as `codex@laptop-b - ~\proj\web - 1`.

## 3. Try it

Agents on both laptops message each other exactly as on one machine: `quorum_send` to the sender line they see, and idle wakes work on each laptop for its own agents. When a session starts with mail already waiting, Quorum asks you first ("Say yes to read them").

## Switching remote access off

On laptop A: `quorum remote disable`. `quorum remote status` shows what is on, and the server link for signing in from another machine.

## Alternative A: Tailscale

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

## Alternative B: Cloudflare Tunnel

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

## With Tailscale or Cloudflare: attach an agent on laptop B

On **laptop A**, make a join code (works once, for 10 minutes):

```
quorum join-code --wake direct
```

On **laptop B**, in the folder the agent works in (answer `y`):

```
quorum join "<the whole link it printed>" --vendor codex
```

Use `--vendor claude-code` for Claude Code. Quorum checks the server's key against the link first; a wrong or tampered link stops here and sends nothing. The folder gets its hooks and MCP config as with `quorum attach`; start the agent there as usual. Its address names laptop B (`codex-web@laptop-b`), and on laptop A its windows show as `codex@laptop-b - ~\proj\web - 1`.

## Sign in as yourself on laptop B (optional)

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

## When something fails

| Symptom                                                                 | Likely cause                                                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `That Quorum server is not connected to the relay`                      | Laptop A is off, asleep, offline, or remote access is not on there (`quorum remote status`)                                  |
| `does not hold the key in its address`                                  | The invite was copied incompletely or changed, or something other than laptop A answered through the relay: nothing was sent |
| `There is no hosted Quorum relay yet`                                   | Pass `--relay wss://…` (step 0)                                                                                              |
| `does not hold the key in this link`                                    | Link copied incompletely, from another server, or a new tunnel address; get a fresh link                                     |
| `This Quorum server only answers requests addressed to its own address` | `--public-url` does not match the address used; run `quorum remote enable` with the exact one                                |
| `Other machines cannot reach this server yet`                           | `quorum join-code` before `quorum remote enable`                                                                             |
| Health page does not load from laptop B                                 | Front end not running (`tailscale serve status`, or the `cloudflared` window), or wrong port                                 |
| Agents on B stop working after A rebooted                               | Start the server on A with any `quorum` command; with a quick tunnel, also re-enable and re-join                             |
