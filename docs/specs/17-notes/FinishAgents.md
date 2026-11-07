# FinishAgents notes: leftovers of tool images and chat-with-a-team

Rows for the integrator (this change edited none of the shared docs).

## What changed

1. **Run a Team delegates.** `nodes/run-team.ts` sets `usableAsTool: true`, `delegates: true`, a `toolDescription` and a `toolInputSchema` (only `message`). Used as a tool it takes `message` and a required `reason`; the chat shows "asked <Team>: <reason>". (Run a Team had no `usableAsTool` before, so it could not be attached as a tool at all.)
2. **Tool Images to Keep.** Run a Team has the option `toolImagesKept` (default 2, 0 to 10), passed as `TeamRunRequest.toolImages` to the lead. `AgentSettings.toolImagesKept` (optional, 0 to 10; Settings tab, "Tool images") is the agent's own value, used by runs that don't set one: chat, schedules and team members. Order: the node's option, else the agent's setting, else `LANDFLOW_TOOL_IMAGES_KEPT`, else 2. A Run an Agent node always passes its option (default 2), so for runs from a flow the node's value wins over the agent's setting.
3. **Run Trace shows the image.** A tool span's detail has an **Images** block: a thumbnail read from the stored reference (`/api/binary/<ref>`), tap to enlarge (full-screen, portalled), the `[image: image/png, 23 KB]` label under it, and an "Image expired" card when the file is gone. The journal holds only `{ mimeType, size, ref }` in the span output (`{ text, images }`). Sources: the AI Agent's flow tools (already listed by the engine), node tools (the translator reads `item.binary` image refs), and the persona runtime (timeline `images`, written by `agent-session.ts`). This also gives the AI Agent's Run Trace tool span the `[image: …]` label.
4. **Plain-chat images live with the session.** `binaryScopeFor` returns `session_<sessionId>` when no execution owns the run (`agents/session-images.ts`), held by a saved binary scope link so the hourly sweep keeps it, and released (files deleted) when the session is deleted, trimmed as one of an agent's oldest sessions, or its agent is deleted. In-process node tools now write under that scope too (the tool request's `executionId` is the scope).

Tests: `apps/web/test/finish-agents-team.test.ts`, `apps/web/test/finish-agents-images.test.ts`.

## docs/features/ai.md and docs/agents.md

- Run an Agent and Run a Team, used as a tool, take `message` and a required `reason`.
- Tool images: Run Trace shows a thumbnail, tap to enlarge, "Image expired" once swept; the agent builder's Settings tab has **Tool images to keep**; Run a Team has **Tool Images to Keep**.
- Chat sessions keep their images as long as the session exists.

## docs/reference

| Name | Default | Meaning |
|---|---|---|
| Run a Team, `toolImagesKept` | 2 | Newest tool images the lead's model gets each turn (0 to 10) |
| Agent settings, `toolImagesKept` | unset | The same for runs that don't set it (chat, schedules, members); unset means `LANDFLOW_TOOL_IMAGES_KEPT`, else 2 |

## docs/limitations.md

- Remove from "Images in tool results": "the Run a Team node and team members use the default (2) or `LANDFLOW_TOOL_IMAGES_KEPT`; there is no per-node setting", "Run Trace shows a label ..., not a thumbnail", and "Chat sessions (no execution) keep images under a run scope the hourly sweep deletes ...".
- Remove from "Chat with agents": "Run a Team has no `reason` argument when used as a tool ... until its descriptor sets `delegates: true`".
- Add: Run Trace shows images only while the stored file exists (an execution's images go with the execution, a chat's with its session); a run from a flow uses the node's **Tool Images to Keep** over the agent's setting; a Run a Team's members use their own agent's setting, not the node's.

## docs/roadmap.md

Desktop agent node, phase 1: the thumbnail in Run Trace and the AgentSettings entry are built. Still open: `computer` toolset blocks and the Desktop node.

## docs/history.md row

| Commit | Change |
|---|---|
| (this commit) | Run a Team delegates (usable as a tool, required `reason`), Tool Images to Keep on Run a Team and in AgentSettings, tool images in Run Trace (thumbnail, enlarge, expired state, label for the AI Agent), plain-chat images kept with the session |

## Live check

Scratch host on port 3600 (own data dir), Browser plugin on 7112, a local page on 3601: an AI Agent on qwen3.8 with a Browser Screenshot tool read "LANDFLOW RED PANDA" and "MANGO" from the image. Run Trace's tool span showed the thumbnail, the enlarged picture and, after the file was deleted, the expired card. Screenshots: `scratchpad/showcase/finish-agents-{trace-tool,enlarged,expired}.png`.
