/**
 * When Spotlight acts alone while it tests and fixes (wave ag5; docs/assistant.md#autonomous-mode).
 *
 * Contract file: backbone/contracts/ag5/fix-autonomy.ts, copied byte for byte to apps/web/src/lib/shared/fix-autonomy.ts by
 * AG22 (owner), AG23 and AG24. Change it in the contracts folder first; the integrator `cmp`s every copy.
 *
 * The person's decision of 2026-11-18, verbatim: "We can let Spotlight approve automatically when he's fixing. It doesn't
 * have to wait for permission in autonomous mode."
 *
 * It replaces sb1's rule D1 ("autonomy only on a brand-new draft", components/editor/spotlight-autonomy.ts `autonomyFor`)
 * for test-and-fix sessions only. A build, a typed change outside a session and a question keep `autonomyFor` as it is.
 * In a session with the switch on Autonomous, on any workflow (a brand-new draft, a saved one, a published one), Spotlight
 * does by itself what `AUTO_FIX_DOES` lists; what `AUTO_FIX_NEVER` lists stays in force. With the switch on Asks first,
 * nothing changes (`fixAutonomyFor` answers 'asks-first' and the session waits for every click, as before).
 *
 * Browser-safe: no zod object, no server import. AG23 reads `SPOTLIGHT_APPROVALS` and `spotlightMayApprove` on the server.
 */

export type FixAutonomy = 'auto' | 'asks-first';

export interface FixAutonomyFacts {
  /** The person's switch (Autonomous / Asks first), as components/editor/autonomous.ts keeps it. */
  switchOn: boolean;
}

/** The rule for a test-and-fix session: the switch alone decides; a saved or published workflow no longer forces asks-first. */
export function fixAutonomyFor(facts: FixAutonomyFacts): FixAutonomy {
  return facts.switchOn ? 'auto' : 'asks-first';
}

/** What an autonomous fix session does by itself, in this order of a session; the docs and the explainer use these words. */
export const AUTO_FIX_DOES = [
  'applies its own fixes to the flow, saved and published flows too',
  'applies its own fixes to agents, saved ones too: the draft is saved and smoke-tested',
  'runs tests for real to a destination the flow already sent to, or that you gave',
  'approves its test runs’ tool calls to a destination the agent, the flow or you already gave',
  'picks the credential when exactly one fits (with several, it asks)',
  'publishes each agent it changed through the smoke test and the eval gate, then the workflow',
] as const;

/** What stays in force, also in an autonomous fix session. */
export const AUTO_FIX_NEVER = [
  'the smoke test and the eval gate always run',
  'never “Publish anyway”, never a skipped eval: a held gate is a finding Spotlight fixes or reports',
  'secrets are typed by you, in the credential dialog',
  'a change that removes, turns off or disconnects a step waits for your click',
  'a destination nobody gave waits for your yes',
  'a value you gave (a URL, an address, an id, your text) is never rewritten',
  'with four-eyes publishing on, its publish is a request for an approver',
] as const;

/** The run request's `approvals` value that lets Spotlight approve its own test run's tool calls (AG22 sends it, AG23 reads it). */
export const SPOTLIGHT_APPROVALS = 'spotlight' as const;

/** What a session's test run sends beside the editor's run body (POST /api/workflows/:id/run), only in an autonomous fix session. */
export interface SpotlightRunApprovals {
  approvals: typeof SPOTLIGHT_APPROVALS;
  /** The test-and-fix session (its `testId`), recorded with each approval it makes. */
  sessionId: string;
  /** Destinations the person gave in this session (`withScheme` form, or a lower-cased email address); the server adds the agent's and the flow's own. */
  destinations: string[];
}

/** Who decided a tool call's approval, as the Run Trace, the agent session and the session's timeline say it. */
export type ApprovalBy = { kind: 'person'; userId: string } | { kind: 'spotlight'; userId: string; sessionId: string };

export function approvedByLine(by: ApprovalBy, approved: boolean): string {
  if (by.kind === 'spotlight') return approved ? 'Approved by Spotlight (autonomous fix session)' : 'Left for you by Spotlight: a destination nobody gave';
  return approved ? 'Approved by you' : 'Denied by you';
}

/** One destination in one form: an email address lower-cased; a URL as scheme://host:port (default ports written out). */
export function normalDestination(destination: string): string {
  const d = destination.trim();
  if (/^[^\s@/]+@[^\s@/]+$/.test(d)) return d.toLowerCase();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(d) ? d : `http://${d}`);
    const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
    return `${url.protocol}//${url.hostname.toLowerCase()}${port ? `:${port}` : ''}`;
  } catch {
    return d.toLowerCase();
  }
}

/**
 * Spotlight may approve a tool call only when every destination it reaches is one already given: the agent's saved config
 * (a fixed parameter such as Send Email's To), the flow as it was when the session started, or the person's words. A call
 * with no outside destination (a read) is approved. Anything else waits for the person (lesson 21).
 */
export function spotlightMayApprove(call: { destinations: readonly string[] }, given: readonly string[]): boolean {
  const known = new Set(given.map(normalDestination));
  return call.destinations.every((d) => known.has(normalDestination(d)));
}

/** A credential Spotlight picks by itself: the only one that fits. Several, or none, are the person's (undefined). */
export function pickAlone<C extends { id: string; name: string }>(fitting: readonly C[]): C | undefined {
  return fitting.length === 1 ? fitting[0] : undefined;
}

export function pickedAloneLine(credential: string, tool: string): string {
  return `Picked “${credential}” for “${tool}”: the only credential you have that fits.`;
}

/**
 * What a session has fixed so far, which no later round of the same session undoes (item 2 of wave ag5). AG22 keeps it;
 * AG24's design route takes `keep` and never proposes removing a kept tool or reverting a kept instruction line.
 */
export interface SessionFix {
  kind: 'flow' | 'agent';
  /** A flow fix: the node and the parameter it set. */
  node?: string;
  parameter?: string;
  /** An agent fix: the agent and the tools it added (tool names as saved on the agent). */
  agentId?: string;
  toolsAdded?: string[];
  /** One line, as the timeline's "Fixed · …" row says it. */
  summary: string;
}

/** The design route's input field (POST /api/agents/design, a change of an existing agent). */
export interface DesignKeep {
  keep?: { tools: string[]; reason: string };
}

/** The line for a proposal a session drops because it would undo its own earlier fix. */
export function keptOwnFixLine(fix: Pick<SessionFix, 'summary'>): string {
  return `Kept: this session already fixed it (${fix.summary}); I won’t undo my own fix.`;
}

/** The session's last line after an autonomous publish: the versions production now runs. */
export function publishedLine(workflowVersion: number, agents: ReadonlyArray<{ name: string; version: number }>): string {
  const pins = agents.map((a) => `${a.name} v${a.version}`).join(' · ');
  return `Published: workflow v${workflowVersion}${pins ? ` · ${pins}` : ''}. Production runs it from its next trigger.`;
}

/** The line for an asks-first tool that a trigger run of the published version will refuse (AG23; ag4's owed decision). */
export function unattendedLine(tool: string, trigger: string): string {
  return `In production nobody approves “${tool}”: a ${trigger} run refuses it. Tell me where production approvals should go, or keep it refusing.`;
}
