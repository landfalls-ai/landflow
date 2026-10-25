/**
 * Capability contracts that sub-nodes supply to root nodes over `ai_*` ports.
 * Provider-neutral on purpose: an Anthropic, Ollama or remote model sub-node
 * all implement LanguageModel; any node can become an AgentTool.
 */
import type { JsonObject } from '@landflow/protocol';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native content (e.g. Anthropic blocks incl. thinking), replayed verbatim to the same provider. */
      raw?: { provider: string; content: unknown };
    }
  | { role: 'tool'; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ModelTurn {
  text: string;
  raw?: { provider: string; content: unknown };
  toolCalls: ToolCall[];
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LanguageModel {
  readonly provider: string;
  readonly model: string;
  generate(input: {
    system?: string;
    messages: AgentMessage[];
    tools: ToolSpec[];
    signal?: AbortSignal;
    /** Ask for a JSON reply where the provider supports it (OpenAI `response_format`, Ollama `format`). */
    responseFormat?: 'text' | 'json';
  }): Promise<ModelTurn>;
}

export interface AgentTool extends ToolSpec {
  /** Node id that implements the tool (for UI highlighting). */
  nodeId?: string;
  invoke(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentMemory {
  load(sessionId: string): Promise<AgentMessage[]>;
  save(sessionId: string, messages: AgentMessage[]): Promise<void>;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every major provider. */
export function toToolName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'tool';
}
