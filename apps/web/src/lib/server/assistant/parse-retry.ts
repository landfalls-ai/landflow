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
export const PARSE_ERROR = /XML syntax error|unexpected end/i;

/**
 * A parse error: its words in the message or the detail Ollama sent (models.ts puts the body in `description`), or a
 * bare "Ollama error 500" with no detail at all. A 500 that says what it was (out of memory) is not retried.
 */
export function isParseError(caught: unknown): boolean {
  const { message, description } = errorTexts(caught);
  return PARSE_ERROR.test(`${message} ${description}`) || (/^Ollama error 500$/i.test(message.trim()) && !description.trim());
}

function errorTexts(caught: unknown) {
  return { message: String((caught as Error)?.message ?? caught), description: String((caught as { description?: unknown })?.description ?? '') };
}

export function withParseRetry(model: LanguageModel): LanguageModel {
  return {
    ...model,
    async generate(input) {
      try {
        return await model.generate(input);
      } catch (caught) {
        if (input.signal?.aborted || isUsageCapError(caught) || !isParseError(caught)) throw caught;
        const { message, description } = errorTexts(caught);
        trace.getActiveSpan()?.addEvent('assistant.retry', { 'landflow.reason': `${message} ${description}`.trim().slice(0, 200) });
        return model.generate(input);
      }
    },
  };
}
