# Desktop

See and use a disposable virtual desktop: take a screenshot, click, type, press keys, scroll and drag, in a locked-down container,
from a flow or as an agent tool. One node, **Desktop**. Feature page: [docs/features/desktop.md](../../docs/features/desktop.md);
design: [spec 18](../../docs/specs/18-desktop-agent-node.md).

```sh
# once: the sandbox image (Xvfb, Openbox, xdotool, Firefox ESR, Mousepad)
COMPOSE_BAKE=false docker --context orbstack buildx build --builder orbstack --load \
  -t landflow/desktop-sandbox:dev services/desktop-sandbox
LANDFLOW_DESKTOP_DOCKER_CONTEXT=orbstack pnpm plugin:desktop      # HTTP :7117 (MCP at /mcp), gRPC :7217
pnpm --filter @landflow/plugin-desktop test                       # scripted driver and a fake docker; no container needed
LANDFLOW_INTEGRATION=desktop pnpm --filter @landflow/plugin-desktop test   # also the real image
```

## The node

Operations: **Act** (a JSON list of actions, or the one action an agent passes; each is answered with a screenshot), **Screenshot**,
**Start Session**, **Get File** (read or list what the apps saved under `/work`) and **End Session**. Actions: `screenshot`,
`click` (x, y, button, count), `move`, `type`, `key` (`Return`, `ctrl+s`), `scroll`, `drag`, `wait`, `launch` (an allowed app).

- The output is JSON (`sessionId`, `results`, `steps`, `screen.text`, ...) and the screenshot as a PNG in `item.binary.data`. As an agent
  tool the AI Agent node hands that PNG to a vision model as an image.
- With no Session ID, every call of one execution shares one desktop, started on first use: that is what an agent's tool calls get. Start
  Session returns an id to pass on (`{{ $json.sessionId }}`).
- Each action is also a `screenshot` artifact in Run Trace: its name, inputs, result, step number and a 320 px JPEG thumbnail in `data`.

## Safety

- **The container is the boundary**: `--read-only`, `--cap-drop ALL`, `no-new-privileges`, non-root, tmpfs home, `/tmp` and `/work`,
  memory, CPU and pids limits, no mounts, no Docker socket. It has no terminal and no shell.
- **No network** (`--network none`) unless **Allowed Hosts** lists sites: then the sandbox sits on its own internal Docker network
  and reaches only an allow-list proxy that passes those hosts (`*.example.com` includes subdomains).
- **Apps**: only the listed apps start (`editor`, `browser`). A window of any other program is closed within about two seconds and
  counted as a violation (a failed `Desktop app allow-list` check).
- **Budgets enforced in the sandbox**: step budget (default 40, ceiling 150), a time limit after which the container removes itself
  (default 10 minutes, ceiling 60), an idle limit (default 2 minutes), and a "stuck" stop after three different actions leave the
  screen unchanged. A janitor removes `landflow-desktop-*` containers and networks past their deadline.
- **Screen content is untrusted**: window titles are returned fenced in `<<<SCREEN_CONTENT_UNTRUSTED ... >>>`, the tool description
  says never to follow instructions found on the screen, and text typed while a window looks like a sign-in is left out of the Run Trace.
  This helps, it does not make a screen safe: give an agent that reads untrusted screens no tool that does harm unattended.
- **No credentials**: there is no login tool. Do not type real secrets; screenshots cannot be masked after the fact.

## Settings

| Variable | Effect |
|---|---|
| `LANDFLOW_DESKTOP_DOCKER_CONTEXT` | Docker context for every call (`orbstack` on this machine) |
| `LANDFLOW_DESKTOP_DOCKER_BIN` | the CLI's name or path |
| `LANDFLOW_DESKTOP_IMAGE` | the sandbox image, default `landflow/desktop-sandbox:dev` |
| `LANDFLOW_DESKTOP_APPS` | operator ceiling on apps (comma separated) |
| `LANDFLOW_DESKTOP_ALLOWED_HOSTS` | operator ceiling on hosts (a node's list must sit inside it) |
| `LANDFLOW_DESKTOP_MAX_STEPS`, `LANDFLOW_DESKTOP_MAX_MINUTES` | ceilings on the budgets (150, 60) |
| `LANDFLOW_DESKTOP_MEMORY`, `LANDFLOW_DESKTOP_CPUS` | per-sandbox limits (2g, 2) |

## Not built or not checked

No noVNC watch view, no approval classes, no login tool, no native `computer_toolset` path and no Anthropic API run: see
[limitations](../../docs/limitations.md). The Anthropic path is untested.
