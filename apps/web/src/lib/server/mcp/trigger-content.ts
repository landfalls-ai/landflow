/**
 * The resources and prompts an MCP Server Trigger serves besides its tools (`resources` and `prompts` parameters).
 *
 * Each is defined on the trigger: a URI or a name, a description, and where the content comes from: text written in the node
 * (an expression such as `{{ $json.arguments.language }}` makes it dynamic) or a sub-workflow (a workflow with a "When
 * Executed by Another Workflow" trigger, whose last output is the content). Listing reads these definitions and runs nothing.
 * Reading a resource or getting a prompt is served directly when its text is static, and is an execution (mode `mcp`, like a
 * tool call) when it has an expression or a sub-workflow: the trigger receives `{ resource }` or `{ prompt, arguments }`.
 */
import type { JsonObject } from '@landflow/protocol';

export interface TriggerResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  source: 'text' | 'workflow';
  text: string;
  workflowId: string;
}

export interface TriggerPromptDef {
  name: string;
  description: string;
  /** Argument names; one ending in `?` is optional. */
  arguments: Array<{ name: string; required: boolean }>;
  source: 'text' | 'workflow';
  text: string;
  workflowId: string;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '').trim();

const groupItems = (value: unknown): JsonObject[] => {
  const items = (value as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
};

/** The workflow id of a resource locator or a plain id. */
const workflowIdOf = (value: unknown) => str(value && typeof value === 'object' ? (value as { value?: unknown }).value : value);

export function resourceDefs(parameters: Record<string, unknown> | undefined): TriggerResourceDef[] {
  return groupItems(parameters?.resources)
    .map((item) => ({
      uri: str(item.uri),
      name: str(item.name) || str(item.uri),
      description: str(item.description),
      mimeType: str(item.mimeType) || 'text/plain',
      source: item.source === 'workflow' ? ('workflow' as const) : ('text' as const),
      // Not trimmed: a resource's text is content.
      text: typeof item.text === 'string' ? item.text : '',
      workflowId: workflowIdOf(item.workflowId),
    }))
    .filter((def) => def.uri);
}

export function promptDefs(parameters: Record<string, unknown> | undefined): TriggerPromptDef[] {
  return groupItems(parameters?.prompts)
    .map((item) => ({
      name: str(item.name),
      description: str(item.description),
      arguments: str(item.arguments)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => ({ name: part.replace(/\?$/, '').trim(), required: !part.endsWith('?') })),
      source: item.source === 'workflow' ? ('workflow' as const) : ('text' as const),
      text: typeof item.text === 'string' ? item.text : '',
      workflowId: workflowIdOf(item.workflowId),
    }))
    .filter((def) => def.name);
}

/** Whether serving it needs an execution (an expression in the text, or a sub-workflow) rather than the text as it is. */
export const isDynamic = (def: Pick<TriggerResourceDef, 'source' | 'text'>) => def.source === 'workflow' || def.text.includes('{{');

/** A sub-workflow's output (or a computed text) as prompt messages: `messages` as they are, else the text as one user message. */
export function promptMessages(output: JsonObject): Array<{ role: 'user' | 'assistant'; text: string }> {
  const messages = Array.isArray(output.messages) ? output.messages : undefined;
  if (messages) {
    return messages.flatMap((m) => {
      const message = m as JsonObject;
      const text = typeof message.text === 'string' ? message.text : typeof (message.content as JsonObject | undefined)?.text === 'string' ? String((message.content as JsonObject).text) : typeof message.content === 'string' ? message.content : '';
      return text ? [{ role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const), text }] : [];
    });
  }
  const text = typeof output.text === 'string' ? output.text : typeof output.prompt === 'string' ? output.prompt : JSON.stringify(output);
  return [{ role: 'user', text }];
}

/** A sub-workflow's output as a resource's text: its `text` (or `content`), else the JSON. */
export function resourceText(output: JsonObject): string {
  if (typeof output.text === 'string') return output.text;
  if (typeof output.content === 'string') return output.content;
  return JSON.stringify(output, null, 2);
}
