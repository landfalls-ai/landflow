/**
 * Wave ag4 (AG20): Spotlight proposes a change to an agent after a run failed inside it. The chat's `propose_agent_fix`
 * tool sends this event; the editor's test session turns it into the agent change card (`lib/shared/agent-card.ts`
 * `AgentCard.fix`, `fixLine`): Apply saves the agent's draft with its smoke test, Publish goes through the gate, and the
 * session runs again. Types only (the browser loads it); it is not part of `spotlight-wire.ts`, which is sb2's contract.
 */
import type { AgentFix } from './agent-card';

export interface AgentFixEvent {
  type: 'agent-fix';
  agentId: string;
  /** The agent's name. */
  agent: string;
  fix: AgentFix;
  /** What to change in the agent, in words (the design route's `change`). */
  change: string;
}
