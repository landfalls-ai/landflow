# Network runners

A flow often has to call something the Landflow host cannot reach: an internal API in an office network, a service in a
VPC. A **network runner** is a small process you start inside that network. It connects out to Landflow over HTTPS (no
inbound port, nothing listens), and an HTTP Request node set to **Run In** that network makes its call from there.

> Only the HTTP Request node uses a runner. Database nodes keep using the databases plugin, which can run inside a network
> and serve its nodes over a message broker both sides dial out to ([transports.md](transports.md#a-plugin-inside-a-private-network-or-a-network-runner)).
> Code nodes and agent tools do not go through a runner.

## How a call goes

```
node (host) ── queue the prepared request ──▶ network_calls (sealed)
runner  ◀── POST /api/runner/v1/poll (held up to 25 s) ── claims it
runner  ── makes the call inside the network (its own allow-list) ──▶ the internal service
runner  ── POST /api/runner/v1/calls/:id { status, headers, body } ──▶ host ──▶ the node's output
```

- The host never connects to a runner. The runner dials the host's own URL, over HTTPS (`http://` is accepted only for
  `localhost` and `host.docker.internal`, for a check on one machine).
- The node builds the request in the host as it always does: the URL, the query, the headers, the credential header
  (Header Auth, Bearer or OAuth2) and the body. The runner makes that request and sends back the status, headers and body;
  the node reads them as if it had fetched them itself (JSON, text or a file, **Include Status & Headers**, an HTTP
  error). A redirect is followed by the runner (five hops at most, each checked again).
- The call waits in the shared database table `network_calls` with its request and its answer sealed (they hold the
  credential header and the response). Any main and any worker can queue, claim or read a call, so queue mode needs
  nothing special. A row is deleted when the node has read its answer, and an ended one is purged after two minutes.
- Several runners of one network share the work: one call goes to one runner. A runner that dies after claiming a call
  makes that call fail (**The runner was lost during the call**): it is never retried, because the request may have
  reached the service.

## Set one up

1. **Settings → Networks → New network.** Name it (`Office`). A network is open to any workflow, or bound to one project:
   only that project's workflows may run in it. Owners and admins manage networks (it is an instance-wide setting).
2. **Register runner.** Give it a name and, if you like, the addresses it may connect from. The token (`lf_run_…`) is shown
   once, with a ready `docker run` line. Landflow keeps only its SHA-256. Copy it now.
3. **Start the runner inside the network**, with the allow-list of what it may reach:

   ```bash
   docker run -d --name landflow-runner-office \
     -e LANDFLOW_URL=https://landflow.example.com \
     -e LANDFLOW_RUNNER_TOKEN=lf_run_… \
     -e LANDFLOW_RUNNER_ALLOW="inside.office 10.20.0.0/16" \
     landflow-network-runner
   ```

   Build the image from the repository (`deploy/docker/network-runner.Dockerfile`); nothing is pushed anywhere. Without
   Docker: `pnpm --filter @landflow/network-runner start` with the same variables.
4. The runner shows **Online** in Settings → Networks within seconds, with its version and when it was last seen.
5. In a flow, open the HTTP Request node and set **Run In** to the network. Leave it on **Host** for everything else.

| Variable | |
|---|---|
| `LANDFLOW_URL` | required: the host's address |
| `LANDFLOW_RUNNER_TOKEN` | required: the runner's token |
| `LANDFLOW_RUNNER_ALLOW` | the hosts, addresses and CIDR ranges it may reach, separated by commas or spaces: `inside.office`, `api.office:8443`, `10.20.0.0/16`, `fd00::/8`, `[fd00::1]:9000`. **Empty refuses every call.** |
| `LANDFLOW_RUNNER_NAME` | shown in the log (default: the host name) |
| `LANDFLOW_RUNNER_CONCURRENCY` | calls at once, 1 to 64 (default 8) |

## Two fences

- **In the host: who may use a network.** A network bound to a project is for that project's workflows; the check is made
  when the node runs, from the run's workflow (**This network belongs to another project**). **Run In** is not an
  expression, so data cannot pick a network.
- **On the runner: what the network may reach.** The runner's own allow-list decides. The host cannot widen it. A name
  entry allows that name; an address or range entry is checked against the address the name resolves to, when the
  connection is made (a name cannot resolve to somewhere else after the check) and on every redirect hop. A call outside
  the list fails on the runner: **refused: 10.30.0.1 is not in this runner's allow-list**.

## Credentials and logs

The credential header is added in the host, travels inside the sealed call and the TLS connection to the runner, and
exists on the runner only in memory for that call. The runner never writes it to disk and never logs it: its log has one
line per call (id, method, origin, status, time), never a header, a query string or a body. A runner token is a bearer
secret like an API key: it is stored as its SHA-256, compared in constant time, and caught by the log redaction.

## Revoking

**Revoke** (Settings → Networks) refuses the token from its next check: a poll the runner has waiting is cut off within a
second, its next one answers 401 and the runner exits (code 3, "this runner's token was revoked"). A call it was making
fails as lost. A runner can also be limited to the addresses it may connect from. Deleting a network revokes all its
runners.

## Audit

`network.created`, `network.updated`, `network.deleted`, `network.runner.registered`, `network.runner.revoked`,
`network.runner.connected` (the first poll after a gap of more than a minute), `network.runner.disconnected` (the first
read that finds a connected runner gone for a minute) and `network.call`: one per run, node and network, on its first call,
with the runner, the node and the workflow, never a URL or data. A runner's polls and answers leave no event.

## When it fails

| The node says | Why |
|---|---|
| **No runner online for network Office** | no runner of the network was seen in the last 30 s, or none claimed the call within 30 s |
| **The runner was lost during the call** | the runner that took the call went quiet for 30 s; not retried |
| **refused: … is not in this runner's allow-list** | the runner's own list does not name the target |
| **This network belongs to another project** | the network is bound to a project; the workflow is in another |
| **Network not found** | the node's Run In names a deleted network |
| **This network is busy** | 1,000 calls are already waiting for it |

Limits: a request or a response up to 10 MiB each (multipart and file bodies are buffered); at most 1,000 queued calls per
network. A production server's request timeout must be above 25 s (the poll answers `204` at 25 s either way). When you
rotate the encryption key, let in-flight calls end first (a call row lives seconds).

## Checking it on this machine

`deploy/compose.network-check.yml` is a throwaway two-container project (`landflow-runner-check`): a runner and a small HTTP
service on an `internal: true` network with no published port, reachable from the runner and not from the host. Register a
runner, put its token in `LANDFLOW_RUNNER_TOKEN`, build and start it, run a flow with **Run In** set to the network, and
bring it down with `--rmi local -v` afterwards. Tests: `pnpm --filter @landflow/network-runner test` and, in `apps/web`,
`networks-*.test.ts`.

## What is not covered yet

A relay for hosts that are themselves private, mTLS with an instance CA (a runner proves itself with its token), database
nodes or any other plugin over the runner channel, Code nodes and agent tools on a runner, a Helm chart.
