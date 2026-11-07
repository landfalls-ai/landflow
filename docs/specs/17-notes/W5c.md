# W5c notes: just-bash as an Agent Shell plugin (prototype)

Rows for the integrator (this change edited none of the shared docs).

## docs/history.md

| Change | What and why |
| --- | --- |
| W5c: `plugins/agent-shell` | A TypeScript plugin `@landflow/plugin-agent-shell` (HTTP 7114, gRPC 7214, `pnpm plugin:agent-shell`) with one node, Agent Shell, usable as an agent tool (`command`, optional `files`). It runs just-bash 3.6.0 (pinned exact, published 2026-10-01) over an in-memory filesystem seeded from parameters or binary items, with no host mount, no network, no Python or JavaScript, an environment built from scratch, a time limit, a command length cap, an output cap and a filesystem cap. Optional per-execution persistence (cap and idle expiry). 22 tests, including `cat /etc/passwd`, `ls ~`, `curl`, `env` and secret-leak checks. Verdict in `docs/research/just-bash-verdict.md`: adopt as a flag. |

## docs/roadmap.md

W5c built as a prototype behind a flag (the plugin is opt-in): an agent can list and read files it was given in an in-memory shell and reach nothing on the host. Open: a container image and deploy entry, a live run through an AI Agent node, and a decision whether the bundled agents may attach it.

## docs/limitations.md

- **Agent Shell is a simulated bash.** About 85 commands: no git, zip, perl, bc, uname, id, or any real binary; `seq` stops at 10,000 and a loop at 10,000 commands. No network, Python or Node. Text files only. Shell state (cwd, variables) does not carry between calls, only files do, and only with "Keep Files for the Run".
- **Its isolation is in-process.** just-bash is a library inside the plugin's Node process (beta by its own README), not a VM. Run the plugin in its container, not on a host that holds secrets.

## docs/README.md (feature map) and a feature page

Add "Agent Shell: a safe bash for agents" pointing at a short page (or `plugins/agent-shell/README.md`) and at `docs/research/just-bash-verdict.md`. Suggested text: Agent Shell runs a command in an in-memory bash. Pass files as `{"name": "text"}` (or attach files to the item); they appear in `/home/user`. The result has `stdout`, `stderr`, `exitCode` (124 timeout, 126 a limit was hit, 127 command not found), `files` (created, modified and deleted files with sizes and trimmed text) and truncation flags. Options: Keep Files for the Run (per execution id, 30 minutes idle, 64 runs), Time Limit (default 10 s, max 60), Max Output (default 64 KB), Max Filesystem (default 4 MB, max 32).

## docs/reference/ (plugins and ports)

| Plugin | HTTP | gRPC | Script |
| --- | --- | --- | --- |
| agent-shell | 7114 | 7214 | `pnpm plugin:agent-shell` |

Limits (in `plugins/agent-shell/src/shell.ts`): command 8,000 characters; seeds 200 files and 2 MB; output 64 KB default and 512 KB ceiling per stream; filesystem 4 MB default and 32 MB ceiling; time 10 s default and 60 s ceiling; 64 kept runs, 30 minutes idle.

## For the integrator

- `pnpm-lock.yaml` gained only the plugin's importer and just-bash's dependency entries. The root `package.json` gained one script, `plugin:agent-shell`.
- Not done: `deploy/` (compose, Dockerfile, Kubernetes), the `dev:all` list, the sample flow and the docs above. `plugins/browser` has a Dockerfile to copy from.
