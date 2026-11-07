# just-bash: verdict from the W5c prototype

**Verdict: adopt as a flag, off by default.** Keep `plugins/agent-shell` as an opt-in plugin (it is a separate process, so "off" means not started and not
registered). Do not make it a core node, and do not give it to an agent by default. It does what the spec asked and fails closed on every safety test we ran,
but its own README calls it beta, and its isolation is a library boundary inside our process, not a VM. The prototype is the safe subset; widening it
(Python, JavaScript, network, real directories) would change that verdict.

## What was checked

- Package `just-bash` (Vercel Labs, Apache-2.0), exact version **3.6.0**, published 2026-10-01 (37 days before this build; the line before it, 3.4.2, is
  from 2026-08-22). Needs Node 20.19 or newer. The only lockfile change is the new plugin's entries.
- Its README, read from `node_modules`: a TypeScript bash over an `InMemoryFs`, with optional curl, Python, JavaScript and sqlite. `Overlay`, `ReadWrite`
  and `Mountable` filesystems are the only things that reach the host; the default does not.

## How the plugin uses it

`InMemoryFs` only, `network` never passed, `python` and `javascript` never passed, `executionLimitProfile: 'hardened'`, a fresh `Bash` per call (or one per
execution id with the option "Keep Files for the Run"). The environment is built by us (`HOME`, `USER`, `LOGNAME`, `PWD`); nothing is copied from
`process.env`. Seed files from the `files` argument or from binary items go under `/home/user`. On top of just-bash's own limits the plugin adds a
wall-clock race with an abort, a command length cap (8,000 characters), an output cap (cut and flagged), a seed cap (200 files, 2 MB) and a filesystem cap.
Kept filesystems expire after 30 idle minutes, at most 64 at once, and one that goes over its cap is dropped.

## Safety results (22 tests, all passing)

- `cat /etc/passwd`: no such file. `ls ~` and `$HOME`: the sandbox home, containing only seeded files. Host paths (a real temp folder, the real home,
  `/proc/self/environ`, `../../..`) are absent. `/proc` and `/dev` exist but are empty simulations.
- `curl` is "command not found" (exit 127) because no network is configured; so are `wget`, `nc`, `ssh`, `python3`, `js-exec`.
- `env`, `printenv`, `set`, `declare -p` show only the six variables the sandbox defines. A secret put in `process.env` (including `AWS_SECRET_ACCESS_KEY`) is
  never visible, and `echo $SECRET` is empty. `PATH` is a fake `/usr/bin:/bin`.
- `date` is UTC (just-bash hides the host zone), `hostname` is `localhost`, `whoami` is `user`; `uname` and `id` do not exist.
- Writes to `/tmp/...` or `~/...` stay in memory; the host disk is untouched.
- An infinite loop stops on the command-count limit (10,000) in about 60 ms; `sleep 20` stops at the deadline with exit 124.

## Limits and surprises found

- **Missing commands:** `git`, `zip`, `unzip`, `bzip2`, `xz`, `bc`, `xxd`, `hexdump`, `patch`, `make`, `perl`, `uname`, `id`, `ps`, `df`, `free`, `less`, `vi`, `sudo`,
  `chown`. Present: awk, sed, grep, rg, jq, yq, xan (CSV), sqlite3, tar, gzip, find, xargs, diff, sort, tree, base64, sha256sum, md5sum, od, `date`, plus
  bash arithmetic, arrays, functions and loops. About 85 commands in all.
- **Hardened limits are tight:** `seq` stops at 10,000 iterations, and a runaway loop is killed after 10,000 commands. A normal agent task (filter a CSV, count,
  grep a log) fits; heavy data work does not.
- **Output over just-bash's own cap discards the whole output** (exit 126, empty stdout) instead of truncating. The plugin raises that cap to 4 MB and
  truncates itself, so the agent gets the head of the output with a flag.
- **No pipe from `/dev/zero`, no real devices:** `head -c N /dev/zero` is empty. Fine for safety; surprising for scripts.
- **`files` passed to the `Bash` constructor are ignored when you pass your own `fs`:** seed the filesystem directly (done here).
- **The shell state does not persist between calls** (variables, cwd), only the files do. An agent must not rely on `cd` or `export` across calls.
- **Persisted sessions keep the time limit of their first call** inside just-bash; the plugin's own deadline still applies per call.
- **Text only:** seeds are UTF-8 text, and binary items are read as text. A real binary file (an image, a zip) is not usable.
- **Isolation is in-process:** no VM and no memory cap on the Node process beyond the filesystem and output caps. A bug in just-bash would run in the plugin's
  process, which holds no credentials of its own and listens on loopback, but still runs as the user. Run the plugin in its container for anything beyond local use.
- `sqlite3` runs in a worker thread and `js-exec` and Python (not enabled here) add further surface; leaving them off is the point of the verdict.

## When to use it, and when not

Use it for an agent that needs to inspect, slice and transform text it was handed (logs, CSV, JSON, a diff) without being given a machine. Do not use it for
anything that needs git, a compiler, Python, the network or real files: that is the harness's sandboxed runner, not this plugin.

## Not done

No Docker image, no deploy manifest and no registration with the host (this prototype only serves on 7114 and 7214 when started with `pnpm plugin:agent-shell`).
No live run through an AI Agent node: the node was tested through the SDK's `runNode` with tool-style arguments in the item, and its manifest checked for
`usableAsTool` and `toolInputSchema`.
