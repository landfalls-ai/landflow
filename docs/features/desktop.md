# Desktop

A **Desktop** node lets a flow or an agent see and use a disposable virtual desktop: screenshot, click, type, key, scroll, drag. Part of
the [Landflow docs](../README.md); plugin README: [plugins/desktop](../../plugins/desktop/README.md); design and what is still open:
[spec 18](../specs/18-desktop-agent-node.md). Built 2026-11-07 (phase 2's first slice).

## How it fits together

```
flow or AI Agent --(Desktop node, plugin :7117/:7217)--> docker exec --> container landflow-desktop-<id>
                                                                          sandbox.py  Xvfb + Openbox + xdotool + scrot
                                                                          Mousepad, Firefox ESR (allow-listed)
```

- **`services/desktop-sandbox`**: the image and `sandbox.py`. One container is one session. `sandbox.py serve` is PID 1; the plugin
  talks to it with `docker exec -i ... sandbox.py ctl` over a unix socket inside the container, so the container publishes no port and
  can have no network at all. (Spec 18 sketched an HTTP API; this transport keeps the split to a product possible, since the request
  and reply are the same JSON, but it is not HTTP yet.)
- **`plugins/desktop`**: the node, the Docker driver (`DockerDriver`), the janitor, and a `ScriptedDriver` (same contract, no container).
- Screenshots come back as `item.binary` PNGs; the AI Agent node's image tool results ([ai.md](ai.md), phase 1) hand them to a vision
  model. Each action is a `screenshot` artifact in Run Trace with a thumbnail in its `data`.

## Use it

1. Build the image (see the plugin README) and run `pnpm plugin:desktop`; the host finds it on 7117.
2. In a flow: **Desktop** (Start Session, Apps `editor`, Start App `editor`) then **Desktop** (Act, Session ID `{{ $json.sessionId }}`,
   Actions JSON) then **Get File** and **End Session**. Or a single Act node, which starts its own desktop and removes it with
   **End Session After**.
3. As an agent tool: add the Desktop node to an AI Agent. The model passes one `action` per call; all calls of the run share a desktop,
   which ends at its time or idle limit (or with an End Session node).

The checked run (2026-11-07, scratch host on :3670, headed browser): Start Desktop, Click and Type (click at 400,300, type a sentence,
`ctrl+s`, type `/work/flow-note.txt`, `Return`), Get the Saved File, End Desktop: success in 6.3 s, the PNG after the last action was the
real Save As dialog, the file came out as an artifact, and `docker ps` showed no sandbox afterwards.

## Limits and safety

See the plugin README: hardened container, no network unless Allowed Hosts (internal network + allow-list proxy; checked: a direct
connection fails, the listed host answers, any other host gets 403), app allow-list with a watcher (checked: a stray window was closed and
counted), step, time and idle budgets enforced inside the sandbox, stuck detection, fenced untrusted screen text, no credentials.

## Models

- **Claude with the computer-use toolset**: not built, and never run. The node exposes plain function-tool actions; the native
  `computer_toolset_20260801` blocks (batching, zoom, `toolset_name`) need the agent loop changes of spec 18 phase 3. No Anthropic API
  call was made while building this.
- **Local vision models**: Ollama `qwen3.8` accepts the screenshot and reads it (checked once: it named the "Save As" dialog), but its
  pixel coordinates were off (it put the Save button at x 957, the button is at x 1230). Treat local computer use as unproven: no
  benchmark was run.
- The scripted driver and the node's `Actions` list let a flow run a fixed, model-free desktop task, and are how this is tested.

## Packaging

Compose profile `desktop` (plugin image with the Docker CLI and the **Docker socket mounted**: local only, anyone who can call the plugin
can start containers; the plugin image built, the compose service was only validated with `config`, not run). Kubernetes: not provided, a pod
cannot start sandboxes on the node's engine without a different driver. See [deployment.md](../deployment.md#desktop-plugin).
