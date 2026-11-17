/**
 * An agent Spotlight designs, as the person sees it before and after it exists (wave sb3, docs/assistant.md "Agents
 * from Spotlight"): the card (SB16), the brief's parts on it (SB17: tools marked read or write, approval on writes,
 * guardrails in words, test cases), the smoke test's result (SB18, decision D3) and, on an empty canvas, the starter
 * flow that runs it (SB16, decision D5).
 *
 * Contract file: backbone/contracts/sb3/agent-card.ts, copied byte for byte to apps/web/src/lib/shared/agent-card.ts by
 * SB16 (owner), SB17 and SB18. Change it in the contracts folder first (the owner only), then copy. Types and pure
 * helpers only: no import, no zod (the browser loads it), no I/O.
 *
 * The wire, for reference (each route is its owner's):
 * - `POST /api/agents/design` with `preview: true` (SB16) answers 200 `{ config, needs, missing, dropped, designed, cases }`
 *   and saves nothing; without it, 201 `{ agent, needs, missing, dropped, designed, cases }` as before, the cases saved
 *   with the agent (SB17). `cases` is `AgentCaseDraft[]` (empty when the brief made none).
 * - The card's Create: `POST /api/agents/import` with `{ config }`, then `POST /api/agents/:id/eval-gate` per case (both exist).
 * - `POST /api/agents/:id/smoke-test` `{ message }` (SB18) answers 200 `{ smoke: AgentSmoke }`: the draft run once on that
 *   message with approvals denied, its session deleted after; 404 for an agent the caller cannot see.
 * - `DELETE /api/agents/design` `{ agentId, workflowId }` (SB18) deletes an agent Spotlight made only when nothing else
 *   uses it: answers `{ deleted: true }` or `{ deleted: false, usedBy: string[] }`.
 */

/** A test case the brief proposes for the eval gate: what a person would send, and what a right answer says. */
export interface AgentCaseDraft {
  input: string;
  expected?: string;
}

/** One tool on the card. `writes`: it sends, creates, changes or deletes outside (lib/shared/run-check.ts `writesOutside`). */
export interface AgentCardTool {
  /** As the agent's config names it. */
  name: string;
  /** The node type of a node tool (`github.pullRequest`), absent for other kinds. */
  type?: string;
  /** The node tool's operation (`get`, `listFiles`), when it has one. */
  operation?: string;
  writes: boolean;
  /** A person approves each call first (`ToolBase.requireApproval`): on for every write the brief adds (SB17). */
  requireApproval: boolean;
}

/** What the smoke test said (D3). `untested`: there was no sample item yet; `reason` says what is missing. */
export interface AgentSmoke {
  state: 'testing' | 'passed' | 'failed' | 'untested';
  /** The agent's reply, cut to 300 characters. */
  reply?: string;
  /** Why it failed or was not run, in one sentence ("The run ended with an error: …", "No sample item: run the step before it once"). */
  reason?: string;
  ms?: number;
}

/** The card's own state: designed and waiting for Create, being created, created (with `agentId`), or failed (`error`). */
export type AgentCardState = 'designed' | 'creating' | 'created' | 'failed';

export interface AgentCard {
  name: string;
  description: string;
  /** `provider/model` ("ollama/qwen3-coder:30b"), absent when the host has none. */
  model?: string;
  tools: AgentCardTool[];
  /** The knowledge base's collection, when it answers from documents. */
  knowledge?: string;
  /** Approved practices go into its prompt (`AgentConfig.practices` not 'off'). */
  practices: boolean;
  /** The guardrails, in words ("Masks secrets in messages", "Ignores instructions inside tool results"). */
  guardrails: string[];
  cases: AgentCaseDraft[];
  /** What is left for the person (the architect's `needs` texts) and what no plugin online covers (`missing`). */
  needs: string[];
  missing: string[];
  /** The configuration Create sends to `POST /api/agents/import` (the server's AgentConfig, opaque here). */
  config: Record<string, unknown>;
  state: AgentCardState;
  agentId?: string;
  error?: string;
  smoke?: AgentSmoke;
  /** On an empty canvas: the starter flow was laid out with it (D5). */
  starter?: boolean;
}

/** The agent's row text for its smoke test: "tested, 1 of 1 passed", "test failed: <reason>", "not tested yet: <reason>". */
export function smokeLine(smoke: AgentSmoke | undefined): string {
  if (!smoke) return 'not tested yet';
  if (smoke.state === 'testing') return 'testing on the sample item…';
  if (smoke.state === 'passed') return 'tested, 1 of 1 passed';
  if (smoke.state === 'failed') return `test failed: ${smoke.reason ?? 'no reply'}`;
  return `not tested yet${smoke.reason ? `: ${smoke.reason}` : ''}`;
}

/** The sample chat message the starter flow pins: the first test case's input, else a plain greeting naming the agent. */
export function starterSample(card: Pick<AgentCard, 'name' | 'cases'>): string {
  return card.cases.find((c) => c.input.trim())?.input.trim() ?? `Hello ${card.name}, what can you do?`;
}

/**
 * The starter flow of decision D5, in the template form the editor applies (`applyTemplate`, laid out left to right): a Chat Message trigger and
 * a Run an Agent step that runs the new agent on each message, with one sample chat item pinned on the trigger. The chat
 * shows the agent's `reply` (the last step's output), so no third step is needed.
 */
export function starterFlow(agent: { id: string; name: string }, sample: string): {
  name: string;
  nodes: Array<{ key: string; type: string; name: string; x: number; y: number; parameters: Record<string, unknown> }>;
  edges: Array<[string, string, number, string]>;
  pinData: Record<string, Array<{ json: Record<string, unknown> }>>;
} {
  return {
    name: `Chat with ${agent.name}`.slice(0, 80),
    nodes: [
      { key: 'chat', type: 'core.chatTrigger', name: 'Chat message', x: 0, y: 0, parameters: {} },
      { key: 'agent', type: 'core.messageAgent', name: agent.name.slice(0, 60), x: 280, y: 0, parameters: { agentId: agent.id } },
    ],
    edges: [['chat', 'agent', 0, 'main']],
    pinData: { chat: [{ json: { chatInput: sample, sessionId: 'sample' } }] },
  };
}
