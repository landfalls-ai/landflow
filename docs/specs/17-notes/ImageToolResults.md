# Image tool results (docs/specs/18, phase 1): doc rows to merge

## Feature page text (docs/agents.md or the AI Agent page; docs/specs/18 section 3.3 steps 1 to 6)

**Images in tool results.** A tool can hand the model an image. Return `{ text, images }` (`images`: `{ mimeType, data }` with base64, or
`{ mimeType, ref }` pointing at a stored file), or let a node tool attach a PNG, JPEG, GIF or WebP to `item.binary` (the Browser node's
Screenshot, and Act on Page with Screenshot After Steps): the engine turns those into tool images (at most four per call) and the item's text
is the tool result text. Anthropic gets the text block and the image block inside the `tool_result`. Ollama and OpenAI-compatible models get
the tool message as text and then one synthetic user message with the images (their tool messages cannot carry images). Images are stored by
reference: the agent writes inline bytes to the binary store, and memory, the run record, saved approval state and the journal's `steps` hold
only references (`images: [{ mimeType, size, ref }]`); the stream's `tool` event gets the text plus a size label, for example
`[image: image/png, 12 KB]`. Just before each model call the node reads back the newest N images (AI Agent option **Tool Images to Keep**,
default 2, 0 to 10) and drops older ones, keeping their text with a note. A model that cannot see images (**Send Tool Images**: Automatic,
Always, Never; Automatic knows Claude, most OpenAI-compatible names, and Ollama vision models by name such as qwen3.8, llava, gemma3)
gets the text and a note saying so, not an error.

## Reference rows (docs/reference/ node options)

| Option (AI Agent, Options) | Default | Meaning |
|---|---|---|
| `toolImagesKept` (Tool Images to Keep) | 2 | How many of the newest tool images go to the model on each turn |
| `toolImages` (Send Tool Images) | `auto` | `auto`, `send` (for an unknown local vision model) or `text` (never) |

## limitations.md

- Run an Agent (the persona runtime, `agents/runtime.ts`) and agent teams do not show tool images to the model yet: a flow tool that returns images
  there keeps its plain result (`flowTool` unwraps `value`). Only the AI Agent node does phase 1.
- Vision is decided by model name (Ollama allow-list, OpenAI-compatible deny-list); an unknown local name needs **Send Tool Images: Always**.
- Tool images are not resized: Anthropic rejects an image over 5 MB or about 2,576 px on the long edge; the Desktop node must size its own screenshots.

## roadmap.md

Desktop agent node, phase 1 (image tool results): built. Open: the same in the persona runtime, `computer` toolset blocks, the Desktop node.

## history.md rows

| Commit | Change |
|---|---|
| (this commit) | Image tool results: `ToolResult.images`, `{ text, images }` tool output, node tools' `item.binary` images, Anthropic tool_result image blocks and a synthetic user message for Ollama/OpenAI-compatible, last-N images (default 2) read back from references, no base64 in memory or the journal, non-vision models get a note |

## Browser README

No plugin change was needed: Screenshot and Act on Page already put the PNG in `item.binary`; the engine's tool wrapper now passes it to the model.
Worth one sentence in plugins/browser/README.md: "As an agent tool, the screenshot reaches a vision model as an image."
