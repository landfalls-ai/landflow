# Landflow network runner

Runs the HTTP Request node's calls from inside a private network. It dials the Landflow host over HTTPS and long-polls
for calls (no inbound port, nothing listens), makes each call with its own outbound rule, and posts the answer back. Node
built-ins only. The full guide is [docs/network-runners.md](../../docs/network-runners.md).

```bash
# Settings → Networks → New network → Register runner gives the token (shown once).
LANDFLOW_URL=https://landflow.example.com \
LANDFLOW_RUNNER_TOKEN=lf_run_… \
LANDFLOW_RUNNER_ALLOW="inside.office 10.20.0.0/16" \
  pnpm --filter @landflow/network-runner start          # or: node dist/main.mjs after `build`, or the image
```

| Variable | |
|---|---|
| `LANDFLOW_URL` | required. The host. `https://`; `http://` only for `localhost` and `host.docker.internal`. |
| `LANDFLOW_RUNNER_TOKEN` | required. The runner's token (`lf_run_…`). Revoke it in Settings → Networks. |
| `LANDFLOW_RUNNER_ALLOW` | what this runner may reach: host names, `host:port`, addresses, CIDR ranges (`10.20.0.0/16`, `fd00::/8`), `[v6]:port`, separated by commas or spaces. **Empty refuses every call.** |
| `LANDFLOW_RUNNER_NAME` | default: the host name. |
| `LANDFLOW_RUNNER_CONCURRENCY` | calls at once, 1 to 64 (default 8). |

The allow-list is the runner's alone: the host can't widen it. A name entry allows the name (and what it resolves to); an
address or range entry is checked against the address the name resolves to, when the connection is made, and again on every
redirect hop (five at most). Bodies are capped at 10 MiB. The log has one line per call (its id, method, origin, status and
time) and never a header, query or body.

Exit codes: 0 stopped, 2 bad configuration, 3 the token was revoked.

```bash
pnpm --filter @landflow/network-runner test        # allow-list, one call, the loop
```
