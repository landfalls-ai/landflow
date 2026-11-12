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

/**
 * A run as one row of the ledger: *Run 3 · “Post to Slack” · No Bearer Auth credential selected*. The reason is the
 * error's first clause; the whole summary goes in the row's title.
 */
export function runRow(run: { round: number; state: 'running' | 'passed' | 'failed'; summary?: string }): { node?: string; reason: string } {
  if (run.state === 'running') return { reason: 'running…' };
  if (run.state === 'passed') return { reason: run.summary ? `passed · ${run.summary}` : 'passed' };
  const node = failedAt(run.summary);
  const rest = (run.summary ?? '').replace(/^failed at “[^”]+”:?\s*/, '').replace(/^failed:?\s*/, '');
  // "Expression error — Parameter …" keeps its kind; "No Bearer Auth credential selected — choose one …" its first clause.
  // No lookbehind: Safari before 16.4 can't parse one, and this runs in the browser.
  const dash = rest.split(/\s+—\s+/)[0] ?? '';
  const clause = /^(.*?[a-z0-9)])\.\s/.exec(dash)?.[1] ?? dash;
  const reason = clause.length > 90 ? `${clause.slice(0, 88).trimEnd()}…` : clause;
  return { ...(node && { node }), reason: reason || 'failed' };
}

/** The next run's number: runs count on through the conversation, so "Run 4" is never two runs. */
export function nextRound(items: ChatItem[]): number {
  let last = 0;
  for (const item of items) if (item.role === 'assistant') for (const p of item.parts) if (p.kind === 'run') last = Math.max(last, p.run.round);
  return last + 1;
}

export interface SessionFold {
  testId: string;
  runs: number;
  fixes: number;
  state: 'passed' | 'failed';
}

/**
 * A finished test-and-fix session folded to a line: *Tested 3× · 2 fixes · stopped*. The session's items are the ones
 * with its `testId`; the outcome said after it stays out. Undefined while it is running (or has no run).
 */
export function sessionFold(items: ChatItem[], testId: string, running: boolean): SessionFold | undefined {
  if (running) return undefined;
  const mine = items.filter((item) => item.testId === testId && item.role === 'assistant');
  const runs = mine.flatMap((item) => (item.role === 'assistant' ? item.parts.flatMap((p) => (p.kind === 'run' ? [p.run] : [])) : []));
  if (!runs.length || runs.some((r) => r.state === 'running')) return undefined;
  const fixes = mine.reduce((n, item) => n + (item.role === 'assistant' ? item.parts.filter((p) => p.kind === 'proposal' && p.proposal.state === 'applied').length : 0), 0);
  // A pass the review said no to ends in an outcome card ("It runs, but doesn't do all you asked"): stopped, not passed.
  const last = items.findLastIndex((item) => item.testId === testId);
  const after = items.slice(last + 1);
  const end = after.findIndex((item) => item.role === 'user' && !item.auto);
  const stopped = (end < 0 ? after : after.slice(0, end)).some((item) => item.role === 'assistant' && !item.testId && item.parts.some((p) => p.kind === 'outcome' || p.kind === 'needs'));
  return { testId, runs: runs.length, fixes, state: runs.at(-1)!.state === 'passed' && !stopped ? 'passed' : 'failed' };
}

/** The outcome card since the person last asked for something: how the last session stopped, if it did. */
export function lastOutcomeOf(items: ChatItem[]): import('./assistant').Outcome | undefined {
  const start = items.findLastIndex((item) => item.role === 'user' && !item.auto);
  for (const item of items.slice(start + 1).reverse()) {
    if (item.role !== 'assistant') continue;
    if (item.parts.some((p) => p.kind === 'run')) return undefined;
    const part = item.parts.find((p) => p.kind === 'outcome');
    if (part?.kind === 'outcome') return part.outcome;
  }
  return undefined;
}

export const foldLine = (fold: SessionFold) =>
  `Tested ${fold.runs}×${fold.fixes ? ` · ${fold.fixes} fix${fold.fixes === 1 ? '' : 'es'}` : ''} · ${fold.state === 'passed' ? 'passed' : 'stopped'}`;

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
        text: (({ node, reason }) => `Run ${run.round} · ${node ? `“${node}” · ` : ''}${reason}`)(runRow(run)),
        ...(run.state === 'failed' && failedAt(run.summary) && { nodeName: failedAt(run.summary) }),
      });
    }
    if (!runs.length) {
      const proposals = item.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : []));
      for (const proposal of proposals) steps.push({ id: key(proposal.id), kind: 'fix', icon: 'fix', text: `${proposal.state === 'applied' ? (item.testId ? 'Fixed' : 'Done') : proposal.state === 'dismissed' ? 'Not applied' : proposal.state === 'undone' ? 'Undone' : 'Proposed'} · ${opsTitle(proposal.ops)}` });
      const ended = item.parts.find((p) => p.kind === 'outcome');
      if (ended?.kind === 'outcome') steps.push({ id: key('outcome'), kind: 'outcome', icon: 'note', text: `Stopped · ${ended.outcome.text}`, ...(ended.outcome.node && { nodeName: ended.outcome.node }) });
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
