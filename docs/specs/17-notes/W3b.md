# W3b notes (for the integrator)

history.md row: `| W3b | Browser plugin packaged: plugins/browser/Dockerfile (Debian, Chrome and agent-browser, headless), compose service in profile browser plus scan host and ports 7112/7212, k8s component components/browser, pnpm dev:all:browser, docs/deployment.md "Browser plugin" | not built or run: validated with docker compose config and kubectl dry-run only |`

roadmap.md: tick the Browser packaging item (W3b).

limitations.md: the Browser image has never been built here; Chrome runs with --no-sandbox inside the container; headed mode is desktop only; an empty LANDFLOW_BROWSER_ALLOWED_DOMAINS leaves each node to its own list.

docs/development.md (not mine to edit): line 15 could mention `pnpm dev:all:browser`.
