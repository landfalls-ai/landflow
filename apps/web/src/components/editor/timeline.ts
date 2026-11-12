/**
 * Spotlight's timeline, worked out from the conversation (docs/assistant.md#the-spotlight-panel): what the panel's header
 * says Spotlight is doing, and one step a line (runs, fixes, agents being designed, the outcome) for the collapsed pill
 * and the rows of a test-and-fix session. Pure: no React, no store, so it is tested in Node.
 */
import { opsTitle } from '@/lib/shared/assistant-ops';
import type { AgentProgress, ChatItem } from './assistant';

export interface Step {
  id: string;
  kind: 'draft' | 'run' | 'fix' | 'agent' | 'outcome' | 'note' | 'needs';
  icon: 'busy' | 'passed' | 'failed' | 'fix' | 'agent' | 'note' | 'needs';
  text: string;
  /** A run's failing node, to select on the canvas. */
  nodeName?: string;
  /** An agent's page. */
  agentId?: string;
}

/**
 * The first sentence of a reply: the rest opens on "more". Not cut after "e.g.", "i.e." or "etc.", nor inside a quoted
 * name (“Step 2. Send”).
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  let quoted = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '“') quoted++;
    else if (c === '”') quoted = Math.max(0, quoted - 1);
    else if ('.!?'.includes(c) && !quoted && /\s/.test(t[i + 1] ?? '') && !/\b(?:e\.g|i\.e|etc|vs|approx)\.$/i.test(t.slice(Math.max(0, i - 5), i + 1))) return t.slice(0, i + 1);
  }
  return t;
}

/** "failed at “Post to Slack”: …" → Post to Slack. */
const failedAt = (summary: string | undefined) => /failed at “([^”]+)”/.exec(summary ?? '')?.[1];

export function agentStep(agent: AgentProgress): Step {
  const text =
    agent.state === 'designing'
      ? `Designing the agent “${agent.name}”…`
      : agent.state === 'failed'
        ? `Couldn’t create the agent “${agent.name}”${agent.summary ? `: ${agent.summary}` : ''}`
        : `Agent “${agent.name}” ${agent.state === 'published' ? 'published' : 'saved as a draft'}${agent.summary ? ` · ${agent.summary}` : ''}`;
  return { id: `agent:${agent.nodeId}`, kind: 'agent', icon: agent.state === 'designing' ? 'busy' : agent.state === 'failed' ? 'failed' : 'agent', text, ...(agent.agentId && { agentId: agent.agentId }) };
}

/**
 * Every step since the user last asked for something, in order: the runs, the fixes, the agents designed (after the turn
 * that created them) and a note per reply that changed nothing. `live`: the last reply is still going.
 */
export function stepsOf(items: ChatItem[], options: { live?: boolean; drafting?: boolean; agents?: AgentProgress[] } = {}): { ask?: string; steps: Step[] } {
  const start = items.findLastIndex((item) => item.role === 'user' && !item.auto);
  const asked = items[start];
  const steps: Step[] = [];
  const rest = items.slice(start + 1);
  const agentsAfter = (id: string) => (options.agents ?? []).filter((a) => a.after === id).map(agentStep);
  rest.forEach((item, i) => {
    if (item.role === 'user') return;
    const key = (part: string | number) => `${item.id}:${part}`;
    if (item.error) {
      steps.push({ id: key('error'), kind: 'outcome', icon: 'failed', text: item.error });
      return;
    }
    const runs = item.parts.flatMap((p) => (p.kind === 'run' ? [p.run] : []));
    for (const run of runs) {
      steps.push({
        id: key(`run${run.round}`),
        kind: 'run',
        icon: run.state === 'running' ? 'busy' : run.state,
        text: `Run ${run.round} · ${run.state === 'running' ? 'running…' : run.state === 'passed' ? `no errors: ${run.summary}` : run.summary}`,
        ...(run.state === 'failed' && failedAt(run.summary) && { nodeName: failedAt(run.summary) }),
      });
    }
    if (!runs.length) {
      const proposals = item.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : []));
      for (const proposal of proposals) steps.push({ id: key(proposal.id), kind: 'fix', icon: 'fix', text: `${proposal.state === 'applied' ? (item.testId ? 'Fixed' : 'Done') : proposal.state === 'dismissed' ? 'Not applied' : proposal.state === 'undone' ? 'Undone' : 'Proposed'} · ${opsTitle(proposal.ops)}` });
      const need = item.parts.find((p) => p.kind === 'needs');
      if (need?.kind === 'needs' && !need.need.state) steps.push({ id: key('needs'), kind: 'needs', icon: 'needs', text: `Needs you · ${need.need.text}`, ...(need.need.node && { nodeName: need.need.node }) });
      if (options.live && i === rest.length - 1) {
        const tool = item.parts.findLast((p) => p.kind === 'tool');
        steps.push({ id: key('live'), kind: 'note', icon: 'busy', text: tool?.kind === 'tool' ? `${tool.tool.label}…` : options.drafting ? 'Drafting the flow from the node catalog…' : 'Thinking…' });
      } else {
        const text = item.parts.find((p) => p.kind === 'text');
        const outcome = item.parts.some((p) => p.kind === 'action' && p.action === 'publish');
        const drafted = item.parts.some((p) => p.kind === 'action' && p.action === 'test');
        if (!proposals.length && text?.kind === 'text') steps.push({ id: key('text'), kind: outcome ? 'outcome' : drafted ? 'draft' : 'note', icon: outcome || drafted ? 'passed' : 'note', text: firstSentence(text.text) });
      }
    }
    steps.push(...agentsAfter(item.id));
  });
  return { ask: asked?.role === 'user' ? asked.text : undefined, steps };
}

export interface PanelState {
  drafting: boolean;
  testing: boolean;
  pending: boolean;
  /** The node a fix is being asked for. */
  fixingName?: string;
  /** Agents being designed right now. */
  designing?: string;
  /** The last run's state, once a session is over. */
  lastRun?: 'passed' | 'failed';
  /** What the person has to do before Spotlight goes on (a credential, a trigger, a yes to sending). */
  needs?: 'credential' | 'agent' | 'trigger' | 'sends';
  /** The node the last session stopped at. */
  stoppedAt?: string;
  /** Anything in the conversation yet. */
  hasItems: boolean;
}

/** The panel's header: what Spotlight is doing, or how the last session ended. */
export function titleOf(state: PanelState): string {
  if (state.drafting) return 'Drafting the flow';
  if (state.designing) return `Designing “${state.designing}”`;
  if (state.testing) return state.fixingName ? `Fixing “${state.fixingName}”` : 'Testing the flow';
  if (state.pending) return 'Working on it';
  if (state.needs) return `Needs you: ${{ credential: 'pick a credential', agent: 'pick an agent', trigger: 'add a trigger', sends: 'OK to send?' }[state.needs]}`;
  if (state.lastRun === 'passed') return 'Passed';
  if (state.lastRun === 'failed') return state.stoppedAt ? `Stopped at “${state.stoppedAt}”` : 'Stopped';
  return state.hasItems ? 'Spotlight' : 'Ask Spotlight';
}

/** The last test run in the conversation, finished or not. */
export function lastRunOf(items: ChatItem[]): { state: 'running' | 'passed' | 'failed'; summary?: string } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role !== 'assistant') continue;
    const run = item.parts.findLast((p) => p.kind === 'run');
    if (run?.kind === 'run') return run.run;
  }
  return undefined;
}

/** The open "Needs you" row since the person last asked for something, if any. */
export function openNeedOf(items: ChatItem[]): import('./assistant').Need | undefined {
  const start = items.findLastIndex((item) => item.role === 'user' && !item.auto);
  for (const item of items.slice(start + 1).reverse()) {
    if (item.role !== 'assistant') continue;
    const part = item.parts.find((p) => p.kind === 'needs');
    if (part?.kind === 'needs') return part.need.state ? undefined : part.need;
  }
  return undefined;
}

/** Where the last failed run stopped: the node named in its summary. */
export const stoppedAtOf = (run: { state: string; summary?: string } | undefined) => (run?.state === 'failed' ? /failed at “([^”]+)”/.exec(run.summary ?? '')?.[1] : undefined);
