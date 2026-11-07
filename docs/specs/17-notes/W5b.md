# W5b notes: AI SDK multi-provider node and OpenTelemetry spans

Rows for the integrator (this change edited none of the shared docs). Verdict: keep as a flag, see [research/ai-sdk-verdict.md](../../research/ai-sdk-verdict.md).

## docs/roadmap.md (the Vercel open source paragraph)

Replace "an AI SDK model node with `@ai-sdk/otel`" in **Still open** with: an opt-in **AI SDK** plugin (`plugins/ai-sdk`, `pnpm plugin:ai-sdk`, HTTP 7115, gRPC 7215) with one node, Generate with AI SDK: Ollama, an OpenAI-compatible endpoint, Anthropic or Google (keys from saved credentials), text, usage and model out, optional JSON-schema output, not usable as a tool. The AI SDK's spans (`@ai-sdk/otel`) go through the plugin's telemetry as children of the node span, in the host's trace, and reach an OTLP backend; they do **not** yet reach Run Trace. Still open: a `model` span in Run Trace for this node, the AI usage caps, and the redaction fix below.

## docs/limitations.md

- The AI SDK plugin's spans are in OTLP only, not Run Trace, and its calls do not count against the AI usage caps or per-credential counters (the models node's do).
- The SDK's span redaction (`packages/sdk/src/redact.ts`, `SECRET_KEY`) matches "token", so `gen_ai.usage.input_tokens` and `output_tokens` become `[REDACTED]` on every AI SDK span.

## docs/reference/configuration.md

No new variable. The plugin uses the usual `LANDFLOW_HOST`, `LANDFLOW_ADVERTISE_HOST` and `OTEL_*` variables. Credential types: `aiSdkOllamaApi`, `aiSdkOpenAiCompatibleApi`, `aiSdkAnthropicApi`, `aiSdkGoogleApi`.

## docs/history.md

| Date | Change |
|---|---|
| 2026-11-07 | W5b: `plugins/ai-sdk`, a Generate with AI SDK node (Ollama, OpenAI-compatible, Anthropic, Google) with `@ai-sdk/otel` spans through the plugin's telemetry; `ai` 7.0.149, `@ai-sdk/otel` 1.0.149; tested on fake provider servers with an in-memory span exporter; verdict: keep as a flag. |

## docs/README.md

Add `research/ai-sdk-verdict.md` to the research list, and `plugin:ai-sdk` (7115/7215) where the plugin ports are listed (and `docs/development.md` if it lists plugin scripts).

## Decisions

- Versions: `ai` 7.0.149 and `@ai-sdk/otel` 1.0.149 (exact pair, 2026-10-22); the providers the newest at least two weeks old (openai-compatible 3.0.77, anthropic 4.0.87, google 4.0.104). All exact.
- No separate Ollama provider package: Ollama's `/v1` API goes through `@ai-sdk/openai-compatible`.
- `@opentelemetry/api` is pinned 1.9.1 (what `@ai-sdk/otel` pins) so the package has no unmet peer; the lockfile change is additions only, no existing entry changed. The test package also avoids a dev dependency on `@opentelemetry/sdk-trace` by using a small in-memory exporter.
- The node passes no tracer: the integration reads the global provider `serve()` registers, so the spans share the node span's trace. The test registers the same global through `createTelemetry({ registerGlobal: true })`.
- Prompts and answers stay out of spans unless the node's "Record Prompts and Answers in Spans" option is on.
- Not run: a live Ollama check (the local Ollama has only `nomic-embed-text`, and no model may be pulled).
