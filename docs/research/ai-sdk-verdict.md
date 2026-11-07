# AI SDK multi-provider node and OpenTelemetry spans: verdict (W5b)

**Verdict: keep as a flag (an opt-in plugin, off by default). Do not replace the models node, and do not adopt it into the
engine.** One caveat blocks the part the spec most wanted: the spans do not reach Run Trace today (see below).

Prototype: `plugins/ai-sdk` (`@landflow/plugin-ai-sdk`, HTTP 7115, gRPC 7215, `pnpm plugin:ai-sdk`), one node,
**Generate with AI SDK**. Tests (`pnpm --filter @landflow/plugin-ai-sdk test`, 10 tests) run against fake OpenAI-compatible,
Anthropic and Google servers on loopback and assert the spans with an in-memory exporter. No real model API was called;
the local Ollama had only an embedding model, so there was no live check.

## What was checked on npm (2026-11-07)

The OpenTelemetry integration is the package **`@ai-sdk/otel`** (AI SDK 7: `registerTelemetry(new OpenTelemetry())`, or per
call `telemetry: { integrations: [new OpenTelemetry()] }`). In AI SDK 7 the older `experimental_telemetry` option is
deprecated in favour of `telemetry`. Pinned, all published 2026-10-22 or earlier (at least two weeks old):

| Package | Pinned | Why not newer |
|---|---|---|
| `ai` | 7.0.149 | `@ai-sdk/otel` pins `ai` exactly, so the pair must match |
| `@ai-sdk/otel` | 1.0.149 | latest is 1.0.164 (2026-11-06) |
| `@ai-sdk/openai-compatible` | 3.0.77 | latest 3.0.86; covers Ollama (`/v1`) and OpenAI |
| `@ai-sdk/anthropic` | 4.0.87 | latest 4.0.98 |
| `@ai-sdk/google` | 4.0.104 | latest 4.0.113 |
| `@opentelemetry/api` | 1.9.1 | what `@ai-sdk/otel` pins; the SDK's own `^1.10.0` is a separate copy (see risks) |
| `zod` | 4.6.7 | already in the lockfile; peer of `ai` |

Releases come about daily across all packages and `ai` is on major 7 with 5 and 6 still patched, so any pin goes stale
quickly. No `ollama-ai-provider-v2` was added: Ollama's OpenAI-compatible `/v1` API works through
`@ai-sdk/openai-compatible`, one dependency fewer.

## How a span reaches the trace

1. `serve()` builds the plugin's telemetry (`createTelemetry`, `packages/sdk/src/telemetry.ts`) and registers its
   TracerProvider as the **OpenTelemetry global**. The node passes no tracer to `OpenTelemetry()`, so the AI SDK's spans use
   that global provider and the **active context**.
2. The host calls the plugin with a W3C `traceparent`; the SDK opens the node's own span from it, and the node wraps the call
   in `ctx.span('ai-sdk.generate')`. The AI SDK's spans become children: `ai-sdk.generate` > `invoke_agent <model>` >
   `step 1` > `chat <model>`. The test asserts one trace id for all four, the parent link, and that the node's output
   `traceId` equals it.
3. The spans carry GenAI semantic-convention attributes (`gen_ai.operation.name`, `gen_ai.request.model`,
   `gen_ai.response.model`, `gen_ai.usage.*`, finish reasons). They go through the plugin's span processors (redaction,
   `span.end` log lines, OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set).

**Do they appear in Run Trace? Not yet.** Run Trace is built from the engine's events by the journal translator
(`apps/web/src/lib/server/journal/translator.ts`); it never reads a plugin's spans. What exists today:

- With an OTLP backend set for the host and the plugin, the plugin's spans and the host's spans (and the Run Trace OTLP
  export, which reuses the run's OTel trace id) are **one trace in that backend**. That is the "next to Run Trace data" view.
- Inside Landflow, the node's output carries `usage` and `model`, so a flow can show tokens, but a Run Trace `model` span for
  this node is **not** created. Closing that gap needs host work outside this prototype: either the translator maps a node
  result's `usage`/`model` to a `model` span, or the node reports it through `node.record` (as the GitHub plugin does). Not
  built.

## Findings from the prototype

- **A bug in the SDK's redaction hides the token counts.** `SECRET_KEY` in `packages/sdk/src/redact.ts` matches "token", so
  the redaction processor replaces `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` with `[REDACTED]` on every
  AI SDK span. Fix: exempt `gen_ai.usage.*` (or keys ending `_tokens`). The test accepts both values until then. Out of this
  task's paths, so unfixed.
- Prompts and answers are **not** in spans by default (`recordInputs`/`recordOutputs` false); an option turns it on.
- Structured output works through `Output.object({ schema: jsonSchema(...) })`; Ollama and OpenAI-compatible servers get
  `response_format: json_schema`.
- `ctx.getCredentials` supplies every key; the descriptor has no key parameter (asserted).

## Compared with the existing models node

| | `apps/web/.../nodes/models.ts` (chat model sub-nodes) | AI SDK plugin node |
|---|---|---|
| Providers | Anthropic, Ollama, OpenAI-compatible | those plus Google (Gemini), and anything else with an AI SDK provider package |
| Role | Sub-node an agent, chain or classifier calls; tools, attachments, streaming, effort, fallback | A standalone action: prompt in, text, usage and model out |
| Governance | Counts in `landflow.ai.*` metrics, the AI usage caps and credential-id attribution; `gen_ai.chat` span in the run's trace | None of those: a plugin call is outside the usage caps and the per-credential counters |
| Run Trace | Yes (model spans, usage, Agent connections) | No (spans only in OTLP) |
| Tool calling, multi-step | Yes | Not exposed (single `generateText` step) |

The AI SDK gain is real but small for Landflow today: **Google/Gemini, plus a long tail of providers** (Mistral, Groq,
Bedrock, Vertex, OpenRouter) for the price of one more dependency each. The models node already covers the three
providers in use, with the governance and Run Trace integration the plugin lacks. Replacing it would lose those and rewrite
~870 lines plus tool, attachment and streaming handling that the AI SDK would have to be bent to match.

## Maintenance cost

- Two majors (5, 6) still receive patches beside 7, daily releases, a new `@ai-sdk/*` package per provider, and exact version
  coupling between `ai`, `@ai-sdk/otel` and `@ai-sdk/provider`. Expect a pin bump (and a test run) every few weeks.
- Two copies of `@opentelemetry/api` (1.9.1 under `@ai-sdk/otel`, 1.10 in the SDK) share one global through the API's
  version-compatible registration; the test shows the spans nest correctly. A future AI SDK that needs a newer API than the
  SDK registers would silently produce no spans. Keep one test that asserts spans exist.
- Telemetry is `@ai-sdk/otel` 1.x, young, and its attribute set follows the evolving GenAI conventions.

## Recommendation

1. **Keep as a flag:** ship the plugin off by default (not in `dev:all`), for Google and other providers a user wants in a
   flow without a models-node change. Document it in `docs/` once the integrator picks it up.
2. **Before any wider adoption**, in this order: fix the redaction of `gen_ai.usage.*` in the SDK; make the node report
   `usage` and `model` to the host (a `model` span in Run Trace) and count them against the AI usage caps; decide whether
   Google belongs in the models node natively (a small adapter) instead.
3. **Drop** the idea of replacing the models node with the AI SDK.
