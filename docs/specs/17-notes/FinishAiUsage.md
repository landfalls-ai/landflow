# Finishing the AI SDK usage items (notes for the integrator)

This change edited none of history, roadmap, limitations or README. Rows and corrections below.

## What was built

- **Cost on the model span.** `AiUsageMeter.price(call)` (`ai-usage/index.ts`) prices like `cost` and also says whether the model has a price. The journal translator (`modelRecord`) puts `costUsd` on the span's usage. A model without a price (every local one, Ollama included) is $0 and the span's attributes carry `costNote: "No price for this model: counted as $0"`. Pricing never fails the trace (try/catch, cost left out).
- **A capped call keeps its span.** `withAiUsage` (`ai-usage/plugin.ts`): when a reported call trips a cap, the wrapper hands the response's `model` records to `extras.onRecord` (the engine's `node.record` path) before it throws, so the translator still makes the span under the failed node. Without a cap error nothing is sent twice (the engine emits the response's records itself).
- **Go SDK** (`sdks/go`): `ExecuteContext.Model(ModelCall{...})`, `NodeDescriptor.MeterAiUsage`, `Record` gained the model fields (token counts are pointers so a zero is still sent; `name` is now omitempty). Credential values masked in text fields; negative counts sent as zero.
- **Python SDK** (`sdks/python`): `ctx.model(model, provider, input_tokens, output_tokens, *, name, cache_read_tokens, cache_write_tokens, duration_ms, finish_reason, prompt, answer)`; `meterAiUsage` goes through in the description dict.
- **Tests.** `apps/web/test/plugin-ai-usage.test.ts` (priced span, unknown model at zero with the note, records handed over on a cap and not otherwise); `sdks/go/records_test.go` `TestModelRecords` (wire, clamping, omitted keys, protobuf round trip, descriptor); `sdks/python/tests/test_records.py` (record shape, clamping, JSON and gRPC round trip).

## The "cached: 16 read" oddity: correct, not a bug

Ollama's OpenAI-compatible endpoint does report prompt-cache reuse: `usage.prompt_tokens_details.cached_tokens` (its KV prefix cache). Checked directly: the same request twice returned `cached_tokens: 0` then `19`. The AI SDK's openai-compatible provider maps it to `usage.inputTokenDetails.cacheReadTokens`, the plugin sends it as `cacheReadTokens`, and `afterModelCall` clamps it to the prompt size and stores it. Reproduced live: the 4th run of the same prompt gave "cached: 16 read" on the Insights AI card (327 tokens, 4 model calls); runs 1 to 3 had none. So an Ollama model does have caching, the card is right, and a local model is $0 either way. (The "has no caching" assumption in the earlier notes was wrong.)

## Live check (2026-11-07, scratch host 3610, plugin 7115/7215, Ollama qwen3.8:latest)

- Uncapped run `ex_L089MMz69Xl1` (and two like it): `qwen3.8:latest` model span under Generate with AI SDK, 20 in, 48 out, `costUsd: 0`, `costNote` in details.
- Capped run `ex_TZsgkSughYsT` (`aiMaxTokensPerExecution: 50`): failed with "AI usage cap reached: this execution used 81 tokens of its 50 tokens limit", and the trace now has the `qwen3.8:latest` model span (20 in, 61 out, prompt and answer), which it did not before.
- Screenshots in the scratchpad `showcase/`: `finish-aiusage-ok-model.png`, `finish-aiusage-capped-model.png`, `finish-aiusage-capped-trace.png`, `finish-aiusage-insights.png`.
- The side panel shows tokens but no dollar figure for a $0 call (the UI hides zero); the cost is in the journal (`span.ended.usage.costUsd`) and the note in Details.

## Doc corrections

- **limitations.md** (AI SDK line): remove "the span carries no cost", "a call over a cap ... has no model span" and "The Go and Python SDKs have no ctx.model helper yet". Keep: only remote plugin nodes are wrapped; the plugin's own `@ai-sdk/otel` spans reach only OTLP.
- **protocol.md "Model records"**: add that the Go SDK has `ctx.Model(ModelCall)` and `MeterAiUsage`, the Python SDK `ctx.model(...)`; and that a call over a cap is still handed to Run Trace.
- **observability.md** (AI usage of plugin nodes) and **run-trace.md**: the model span has `costUsd` priced with the AI usage price table (overrides included); an unpriced model is $0 with `costNote`; a capped call still has its span. Ollama's cache-read tokens are real.
- **ai-sdk-verdict.md**: "Limits" about cost and capped call spans are closed; Ollama cached tokens are provider-reported.
- **roadmap.md**: the AI SDK paragraph can drop the cost and capped-span caveats.

## history.md row

| 2026-11-07 | AI usage finish: the plugin `model` span is priced (`costUsd`, unknown models $0 with a note), a call over a cap still shows its span, `ctx.model` in the Go and Python SDKs; Ollama's cached-token count checked as correct. |
