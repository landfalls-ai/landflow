/**
 * SB05: Ollama answers 500 when it can't parse the tool call a local model wrote ("XML syntax error on line 1: unexpected
 * EOF"). The adapter retries only while nothing was shown; after streamed text the error would end the reply with no card.
 * `withParseRetry` asks once more with the same request: the retried step's text replaces what was streamed, because the
 * chat sends each step's checked text as its own `text` event.
 */
import { trace } from '@opentelemetry/api';
import type { LanguageModel } from '@landflow/engine';
import { isUsageCapError } from '../ai-usage';

/** The error Ollama gives for a tool call it could not parse. Narrower than the architect's loop: no bare "tool call", which hosted models' errors also say. */
export const PARSE_ERROR = /XML syntax error|unexpected end|Ollama error 500/i;

export function withParseRetry(model: LanguageModel): LanguageModel {
  return {
    ...model,
    async generate(input) {
      try {
        return await model.generate(input);
      } catch (caught) {
        if (input.signal?.aborted || isUsageCapError(caught) || !PARSE_ERROR.test(String((caught as Error)?.message ?? caught))) throw caught;
        trace.getActiveSpan()?.addEvent('assistant.retry', { 'landflow.reason': String((caught as Error)?.message ?? caught).slice(0, 200) });
        return model.generate(input);
      }
    },
  };
}
