# Tool images, part 2 (persona runtime, limits): doc rows to merge

## Feature page text

**Tool images in agents.** Run an Agent, Run a Team and agent team members (the persona runtime) show tool images to the model like the AI Agent
node: a node tool's screenshot (`item.binary`, up to four per call) or a flow tool's `{ text, images }` is stored by reference (with the execution,
else under the run), the newest N go to a model that sees (by name, as for the AI Agent; others get a note), older ones are dropped with a note.
The transcript, memory and journal hold references; the timeline and Run Trace show a label, `[image: image/png, 74 KB]`, no thumbnail yet.
How many to keep: Run an Agent option **Tool Images to Keep** (default 2), else `LANDFLOW_TOOL_IMAGES_KEPT`, else 2.
**Image limits.** Before a provider call every image is capped at 1568 px on the long side and 4 MB: PNG, JPEG, WebP and GIF are scaled down with
sharp (a large PNG falls back to JPEG); if it still doesn't fit, or sharp can't load, the image is skipped with a note in the tool result.
Remote plugin node tools now get `binaryAccess`, so a screenshot over 64 KiB comes back as a stored reference.

## Reference rows

| Name | Default | Meaning |
|---|---|---|
| Run an Agent, `toolImagesKept` | 2 | Newest tool images sent to the model each turn (0 to 10) |
| `LANDFLOW_TOOL_IMAGES_KEPT` | 2 | The same for every other agent run (chat, schedules, team members) |

## limitations.md

- Remove the persona-runtime and "not resized" lines of ImageToolResults.md. Open: Run Team node and team members use the default or the env value (no
  per-node setting, `agent-teams/runtime.ts` does not pass `toolImages`); Run Trace shows a label, not a thumbnail; chat sessions (no execution) keep images
  under a run scope the hourly sweep deletes, so images older than an hour can't be shown again.
- sharp (0.35.5, exact, already in the lockfile as Next's dependency, now a direct dependency of apps/web) is native; where it can't load, only the 4 MB
  limit applies.

## roadmap.md

Desktop agent node, phase 1: persona runtime and limits built. Open: `computer` toolset blocks, the Desktop node, a thumbnail in Run Trace, a setting in AgentSettings.

## history.md rows

| Commit | Change |
|---|---|
| (this commit) | Tool images in the persona runtime (Run an Agent, teams, members), 1568 px / 4 MB limits with sharp, `LANDFLOW_TOOL_IMAGES_KEPT`, binaryAccess for node tools, live check on local qwen3.8 |
