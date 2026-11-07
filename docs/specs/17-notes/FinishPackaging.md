# FinishPackaging notes (for the integrator)

history.md rows:

`| FP1 | Browser: Continue On Failure for Act on Page (After a Failed Step: stop or run the rest); a failed step returns ok:false with its error, `stepsFailed`, the results read so far and the page; outputSchema, README and fake-CLI test updated | plugins/browser tests |`

`| FP2 | Browser image built and run locally (OrbStack, arm64): Dockerfile fixed: Chrome for Testing has no Linux arm64 build, so arm64 installs Debian chromium; AGENT_BROWSER_HOME is not honoured, so the install runs with HOME=/opt/agent-home and /opt/agent-browser/chrome (AGENT_BROWSER_EXECUTABLE_PATH) points at the browser; AGENT_BROWSER_VERSION pinned to 0.41.2 | built, ran read-only with caps dropped, read a page on the host through host.docker.internal; image and container removed |`

`| FP3 | Agent Shell (7114/7214) and Web Search (7113/7213) packaged: compose services in profiles agent-shell and web-search, scan hosts and ports 7111-7114/7211-7214, k8s components, `pnpm dev:all:agent-shell` and `dev:all:web-search`, docs/deployment.md "Agent Shell and Web Search plugins" | docker compose config, kubectl apply --dry-run=client (components and the orbstack overlay with both enabled); Agent Shell and Web Search images built, Agent Shell ran an echo through /execute, Web Search answered health |`

`| FP4 | Python SDK: the composite validator checks starter-node onError (stop/continue), retryOnFail, maxTries, waitBetweenTriesMs (0-60000) and retryBackoff (fixed/exponential) like the protocol schema; the fields already passed through dict descriptors | sdks/python test_composites |`

roadmap.md: tick the Browser "Continue On Failure" item, the Browser image build, and Agent Shell / Web Search packaging.

limitations.md: replace "the Browser image has never been built here" with: built and run on arm64 only; amd64 verified for the install step only (a Debian probe container), not the whole image; arm64 uses Debian's chromium (156) and amd64 Chrome for Testing (157 at agent-browser 0.41.2). Chrome still runs with --no-sandbox. Web Search needs a SearXNG URL or an API key credential before it returns anything.

docs/development.md (not mine to edit): mention `pnpm dev:all:agent-shell` and `pnpm dev:all:web-search` next to `dev:all:browser`; docs/reference/configuration.md: `LANDFLOW_SEARCH_SEARXNG_URL` and `LANDFLOW_SEARCH_DENY_DOMAINS` are now compose variables too; `LANDFLOW_SCAN_PORTS` default in compose is now `7101-7107,7111-7114,7201-7207,7211-7214`.

What the Browser build showed (2026-11-07, OrbStack, linux/arm64):
- First build failed at `agent-browser install --with-deps`: "Chrome for Testing does not provide Linux ARM64 builds".
- A linux/amd64 Debian probe container ran `agent-browser install --with-deps` fine (apt libraries, then Chrome 157.0.8103.38 into `$HOME/.agent-browser/browsers/chrome-<version>/chrome`); with `AGENT_BROWSER_HOME=/opt/ab` set, `/opt/ab` was never created: not honoured.
- Fixed image built; as user `node` (read-only root, tmpfs /tmp, cap-drop ALL, no-new-privileges, `LANDFLOW_BROWSER_ALLOWED_DOMAINS=host.docker.internal`): health ok; `agent-browser 0.41.2`; Chromium 156.0.8078.79; an Act on Page call against a python http.server on the host (`http://host.docker.internal:8765/`) returned title "Finish Test Page", the fenced snapshot, `results` `{heading, again}` and, with Continue On Failure and "Run the Remaining Steps", the missing `#nope` click as `ok:false` with `error` "Element not found: #nope..." and `stepsFailed: 1`. A request for `http://127.0.0.1:8765/` was refused ("127.0.0.1 is not an allowed domain", Allowed: host.docker.internal) before any browser started. So AGENT_BROWSER_ARGS=--no-sandbox is honoured in effect (Chromium started as non-root in a cap-less container).
- Not done: the whole image on amd64; the compose/k8s Browser service itself (only the image was run by hand).
