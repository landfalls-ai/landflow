/**
 * Prompt drafts: the prompt as Landflow builds it, split into parts, handed to `withCallNote({ draft })` so the meter's
 * listener can write the split (parts.ts). In memory only; never stored or logged (constitution note 17).
 */
import type { AgentMessage, ToolSpec } from '@landflow/engine';
import type { PromptPart } from '../../shared/ai-call-parts';
import type { DraftSegment, PromptDraft } from './call-context';

export interface SystemSegment {
  part: PromptPart;
  text: string;
}

const toolText = (tool: ToolSpec): string => JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema });

/** The messages as segments: the latest user message is `userMessage`; earlier turns are `history`; tool results `toolResults`. */
function messageSegments(messages: AgentMessage[]): { segments: DraftSegment[]; images: number } {
  const segments: DraftSegment[] = [];
  let images = 0;
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      segments.push({ part: i === lastUser ? 'userMessage' : 'history', where: 'messages', text: m.content });
      images += (m.attachments ?? []).filter((a) => a.kind === 'image').length;
    } else if (m.role === 'assistant') {
      segments.push({ part: 'history', where: 'messages', text: m.toolCalls.length ? `${m.text}${JSON.stringify(m.toolCalls.map((c) => ({ name: c.name, input: c.input })))}` : m.text });
    } else {
      for (const r of m.results) {
        segments.push({ part: 'toolResults', where: 'messages', text: r.content });
        images += r.images?.length ?? 0;
      }
    }
  });
  return { segments, images };
}

/**
 * An agent's call: the tools (a breakpoint after the last one when `cache` is set, as the Anthropic adapter does), the
 * system prompt's segments in order (a breakpoint after the last), then the messages.
 */
export function agentDraft(input: { systemSegments: SystemSegment[]; tools: ToolSpec[]; messages: AgentMessage[]; cache?: boolean }): PromptDraft {
  const tools: DraftSegment[] = input.tools.map((t, i) => ({ part: 'toolDefinitions', where: 'tools', text: toolText(t), ...(input.cache && i === input.tools.length - 1 && { breakpoint: true }) }));
  const system: DraftSegment[] = input.systemSegments.map((s, i) => ({ part: s.part, where: 'system', text: s.text, ...(input.cache && i === input.systemSegments.length - 1 && { breakpoint: true }) }));
  const { segments, images } = messageSegments(input.messages);
  return { segments: [...tools, ...system, ...segments], ...(images > 0 && { images }), ...(input.tools.length && { toolNames: input.tools.map((t) => t.name) }) };
}

/** A call built outside the agent runtime: one system string (all `instructions`), tools, messages; no breakpoints. */
export function plainDraft(input: { system?: string; tools?: ToolSpec[]; messages: AgentMessage[] }): PromptDraft {
  const tools = input.tools ?? [];
  const segments: DraftSegment[] = [
    ...tools.map((t): DraftSegment => ({ part: 'toolDefinitions', where: 'tools', text: toolText(t) })),
    ...(input.system ? [{ part: 'instructions', where: 'system', text: input.system } satisfies DraftSegment] : []),
  ];
  const messages = messageSegments(input.messages);
  return { segments: [...segments, ...messages.segments], ...(messages.images > 0 && { images: messages.images }), ...(tools.length && { toolNames: tools.map((t) => t.name) }) };
}
