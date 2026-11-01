/**
 * The Agent architect (docs/agents.md#agent-architect): a chat that designs an agent with the user. It reads what this
 * instance has (every node plugin online, workflows, agents, credentials, persona templates) and proposes a whole agent
 * as a draft the user reviews and creates. The route is POST /api/assistant/agent; its reply streams as SSE.
 */
import type { AgentConfig } from './agents';
import type { AgentFace } from './faces';

/** The architect's own face and colour, for its chat. */
export const ARCHITECT = {
  name: 'Agent architect',
  color: '#6366f1',
  face: { skin: '#c98b5f', hair: 'bun', hairColor: '#1f1a17', eyes: 'happy', brows: 'raised', mouth: 'grin', beard: 'none', glasses: 'square', extra: 'none' } satisfies AgentFace,
} as const;

export interface ArchitectTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** POST /api/assistant/agent */
export interface ArchitectRequest {
  messages: ArchitectTurn[];
  /** The draft proposed so far: the next proposal builds on it. */
  draft?: Partial<AgentConfig>;
  /** As for the editor assistant: a bare Ollama model name, `anthropic/<model>` or `openai/<model>`. */
  model?: string;
}

/** A part of the job no node online can do: recorded for the second brain, which suggests building the tool. */
export interface ArchitectMissing {
  /** What the agent would do with it: "Read firing Grafana alerts". */
  capability: string;
  /** The app or service: "Grafana". */
  system?: string;
}

/** Models copy the format's own words: "App: read firing alerts" names no app. */
const PLACEHOLDER_SYSTEM = /^(an? )?(app|application|system|service|tool|plugin|platform|api|n\/?a|none|unknown)$/i;
const NOT_A_SYSTEM = /^(API|HTTP|HTTPS|URL|JSON|REST|SQL|I|A|An|The)$/;

/**
 * The app a missing capability is for: the name the model gave, unless it is a placeholder ("App"), else the first
 * capitalised word after the verb ("Read Grafana alerts from a webhook" → Grafana).
 */
export function missingSystem(capability: string, named?: string | null): string | undefined {
  const given = named?.trim();
  if (given && !PLACEHOLDER_SYSTEM.test(given)) return given;
  for (const word of capability.split(/\s+/).slice(1)) {
    const bare = word.replace(/^[("“']+|[,.;:)"”']+$/g, '');
    if (/^[A-Z][A-Za-z0-9.]+$/.test(bare) && !NOT_A_SYSTEM.test(bare)) return bare;
  }
  return undefined;
}

/** Something only the user can finish before a tool works: a credential to pick, a value to fill in, a plugin to start. */
export interface ArchitectNeed {
  /** The tool's name in the draft. */
  tool: string;
  kind: 'credential' | 'parameter';
  text: string;
}

export type ArchitectEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; label: string; ok: boolean }
  /** A whole agent: it replaces the earlier draft. Tools carry fresh ids and no credentials. */
  | { type: 'draft'; id: string; summary: string; config: Partial<AgentConfig>; needs: ArchitectNeed[]; dropped: string[]; missing: ArchitectMissing[] }
  | { type: 'done'; model: string; durationMs: number; steps: number; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string };
