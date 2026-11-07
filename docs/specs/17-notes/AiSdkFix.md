# AI SDK plugin fix: usage, caps and Run Trace (notes for the integrator)

This change edited none of the shared docs (history, roadmap, limitations, README, the verdict page). Rows and corrections below.

## What was built

- **Protocol (additive).** A `model` variant of `NodeRecord` (`ExecuteResponse.records`; gRPC already carries records as dynamic JSON, so no proto change): `model`, `provider`, `inputTokens`, `outputTokens`, optional `cacheReadTokens`, `cacheWriteTokens`, `durationMs`, `finishReason`, `prompt`, `answer`, `name`. A node descriptor field `meterAiUsage` (optional boolean). JSON schemas regenerated. Older hosts ignore both; older plugins are unaffected.
- **SDK.** `ctx.model(call)` beside `ctx.artifact` and `ctx.check` (credential values masked in the text fields).
- **Host usage and caps.** `apps/web/src/lib/server/ai-usage/plugin.ts`, `withAiUsage`, wraps every resolved node type in the registry. For a `model` record it calls the same `afterModelCall` the built-in models node reaches through `traceChat`: priced, one `ai_usage` row (Insights, `ExecutionRecord.aiUsage`, per-credential and per-user caps through the credential tag on the request, `ai.call` ledger event), `landflow.ai.tokens` metric. A call over a cap throws the same `UsageCapError`, so the node and run fail with "AI usage cap reached: this execution used ...". A node with `meterAiUsage` is also refused before it runs once a cap is reached (`beforeModelCall`). Several records in one response are all counted before the error is thrown.
- **Run Trace.** The journal translator (`journal/translator.ts`, `modelRecord`) turns a `model` record into a `model` span under the node's step: named by the model, tokens (and model) as usage, duration, `provider` and `finishReason` as attributes. The prompt is the span's `input` and the answer its `output`, so `traceContent` (`journal/content.ts`) cuts them (`summaries`) or drops them (`off`) like other content; nothing of the prompt is in attributes. The fold takes the child's tokens off the node's own `usage` (the node's output still has `usage`), so nothing counts twice. The OpenTelemetry spans are unchanged: prompts in them still need the node's "Record Prompts and Answers in Spans" option.
- **Plugin.** `plugins/ai-sdk` declares `meterAiUsage: true` and reports one `ctx.model` per successful call.

## Limits of this fix

- Cost is priced for the usage ledger and caps, but the Run Trace `model` span carries no `costUsd` (the translator does not price). Local models are free anyway.
- A call that goes over a cap throws before the engine emits its records, so that one call is in Insights and the caps but has no `model` span.
- Only remote plugin nodes are wrapped for records; an in-process node's `ctx.model` goes through `onRecord` and is shown in Run Trace but not metered (none exists).
- The plugin's own OTel spans still reach only an OTLP backend, as before.
- Go and Python SDKs have no `ctx.model` helper yet (they can return the record by hand).
- Ollama run reported `cached: 16 read` on the Insights card from the capped run (the provider's cached-prompt count); not investigated further.

## Live check (2026-11-07, scratch host on 3210, plugin on 7115/7215, local Ollama `qwen3.8:latest`)

- Run `ex_U6JcqwyH5Irx`: 20 in, 60 out, answer "The sea stretches endlessly toward the horizon."; `ExecutionRecord.aiUsage` and `GET /api/insights/ai-usage` show ollama/qwen3.8:latest, 1 call, $0. Run Trace: `Generate with AI SDK` step with a child `qwen3.8:latest · 20 in · 60 out` (model), asked/came back/details panel with prompt, answer, `finishReason: stop`, `durationMs: 7536`.
- Capped workflow (`aiMaxTokensPerExecution: 50`): node and run failed with "AI usage cap reached: this execution used 101 tokens of its 50 tokens limit (Workflow settings → AI usage limits)"; the Insights AI card then showed 181 tokens, 2 model calls.
- Screenshots in the session scratchpad `shots/`: `aisdk-run-trace.png`, `aisdk-run-trace-model.png`, `aisdk-insights.png`.

## docs/research/ai-sdk-verdict.md: what must change

- Header caveat ("the spans do not reach Run Trace today"): replace with "the node reports each call to the host (`ctx.model`), which shows it as a `model` span in Run Trace and counts it in AI usage and caps; the AI SDK's own OTel spans still go to OTLP only."
- "Do they appear in Run Trace? Not yet": rewrite to the path above (record -> journal translator), not the `node.record` option for artifacts.
- "Findings": the redaction bug is fixed (b209b6e); delete it. "No real model API was called ... no live check": replace with the live check above.
- Verdict stays "keep as a flag"; the blockers (Run Trace entry, caps) are closed.

## docs/limitations.md

Remove: "The AI SDK plugin's spans are in OTLP only ... its calls do not count against the AI usage caps", and the `SECRET_KEY` redaction line. Add: the model span has no cost in Run Trace; a capped call has no model span; in-process nodes' model records are not metered.

## docs/roadmap.md

In the Vercel paragraph: drop "Still open: a model span in Run Trace for this node, the AI usage caps, and the redaction fix". Say the node reports usage (`ctx.model`, `meterAiUsage`), counts against the caps and shows a `model` span.

## docs/protocol.md, docs/reference, docs/observability.md, docs/run-trace.md

Document the `model` record, `meterAiUsage`, `ctx.model`, and "AI usage of plugin nodes" (observability), and the plugin-node `model` span (run-trace, next to the landflow-harness paragraph).

## docs/history.md

| 2026-11-07 | AI SDK fix: `model` node record, `ctx.model`, `meterAiUsage`; the host counts plugin-reported model calls in AI usage and caps (`ai-usage/plugin.ts`) and Run Trace shows a `model` span for Generate with AI SDK; checked live on Ollama qwen3.8. |
