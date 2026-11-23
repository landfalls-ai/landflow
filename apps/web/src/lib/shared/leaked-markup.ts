/**
 * Tool-call markup a local model leaves in its text (docs/assistant.md#streaming): a `<function=…>` call with its body
 * up to its end (or the end of the text when it isn't closed), `<tool_call>` and `<think>` blocks, and stray tags. The
 * server's guard cleans the checked text with it; a chat cleans the provisional `text.delta` words with
 * `provisionalText`, so half a tag never shows while it streams. No zod here: the browser loads this module.
 */
export function withoutLeakedMarkup(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<function=[\s\S]*?(?:<\/function>|$)/g, '')
    .replace(/<\/?(?:tool_call|function|parameter)\b[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** The start of a tag that may still become one of the above: `<`, `<thi`, `<tool_c`, `<function`, `</para`… */
const PARTIAL_TAG = /<\/?(?:t(?:h(?:i(?:nk?)?)?|o(?:o(?:l(?:_(?:c(?:a(?:ll?)?)?)?)?)?)?)?|f(?:u(?:n(?:c(?:t(?:i(?:on?)?)?)?)?)?)?|p(?:a(?:r(?:a(?:m(?:e(?:t(?:er?)?)?)?)?)?)?)?)?$/;

/** Streamed words as they may be shown: leaked markup removed, and a tag still arriving at the end held back. */
export function provisionalText(text: string): string {
  return withoutLeakedMarkup(text.replace(PARTIAL_TAG, ''));
}
