/**
 * AG22: the pieces of an autonomous test-and-fix session that are not the loop itself (docs/assistant.md "Autonomous mode" and
 * "Test and fix"): which autonomy a fix session takes, the destinations given to it, what it has fixed so far (and so never
 * undoes), what the review reads of the agent's reply, and the lines it says. The rules are `@/lib/shared/fix-autonomy` (the
 * contract): the words come from there, not from here. No zod object, no server import: the browser loads this.
 */
import type { AssistantOp } from '@/lib/shared/assistant-ops';
import { fixAutonomyFor, keptOwnFixLine, normalDestination, type FixAutonomy, type SessionFix } from '@/lib/shared/fix-autonomy';
import { dropRepeatedAgentWork, type AgentBrief } from '@/lib/shared/agent-brief';
import { heldLine as gateHeldLine } from '@/lib/shared/agent-eval';
import { needsAClick, useAutonomyFacts, type ChangeGraph, type ChangeOp } from './spotlight-autonomy';

/** What a test-and-fix session takes when nothing names it: the switch alone (decision of 2026-11-18); never `autonomyOf`. */
export const fixAutonomyNow = (): FixAutonomy => fixAutonomyFor({ switchOn: useAutonomyFacts.getState().switchOn });

/** A fix the session made, with what it changed (JSON text) so a later proposal that sets it back is seen. */
export interface OwnFix extends SessionFix {
  from?: string;
  to?: string;
}

/** The URLs and e-mail addresses a person's words name: destinations the person gave (lesson 21). */
export function destinationsInText(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set([...urls, ...emails].map((d) => normalDestination(d.replace(/[.,;:!?]+$/, ''))))];
}

/** The flow's own parameters one op set, keyed by node and parameter, with the value before (JSON) and after. */
export function fixesOf(ops: readonly AssistantOp[], nodes: ReadonlyArray<{ id: string; name: string; parameters: Record<string, unknown> }>): OwnFix[] {
  const find = (ref: string) => nodes.find((n) => n.name === ref || n.id === ref);
  const out: OwnFix[] = [];
  for (const op of ops) {
    if (op.op === 'setParameters') {
      const node = find(op.node);
      for (const [key, value] of Object.entries(op.parameters)) out.push({ kind: 'flow', node: node?.name ?? op.node, parameter: key, from: JSON.stringify(node?.parameters[key] ?? null), to: JSON.stringify(value ?? null), summary: `“${node?.name ?? op.node}”: ${key} set` });
    } else if (op.op === 'addNode') out.push({ kind: 'flow', node: op.name ?? op.type, summary: `added “${op.name ?? op.type}”` });
  }
  return out;
}

/** The fix of this session a proposal's ops would undo: a parameter set back to its old value, or a step the session added removed. */
export function undoneBy(ops: readonly AssistantOp[], fixes: readonly OwnFix[], options: { ownRemovalOk?: boolean } = {}): OwnFix | undefined {
  for (const op of ops) {
    if (op.op === 'removeNode') {
      if (options.ownRemovalOk) continue; // the person's decision of 2026-11-18: an autonomous session may remove a step it added itself
      const added = fixes.find((f) => f.kind === 'flow' && f.parameter === undefined && f.node === op.node);
      if (added) return added;
    } else if (op.op === 'setParameters') {
      for (const [key, value] of Object.entries(op.parameters)) {
        const back = fixes.find((f) => f.kind === 'flow' && f.node === op.node && f.parameter === key && f.from !== undefined && f.from === JSON.stringify(value ?? null) && f.from !== f.to);
        if (back) return back;
      }
    }
  }
  return undefined;
}

/** Whether every parameter these ops set is already a fix of this session (the same fix twice). */
export function sameFixTwice(ops: readonly AssistantOp[], fixes: readonly OwnFix[]): boolean {
  const sets = ops.flatMap((op) => (op.op === 'setParameters' ? Object.entries(op.parameters).map(([k, v]) => ({ node: op.node, k, v: JSON.stringify(v ?? null) })) : []));
  return sets.length > 0 && ops.every((op) => op.op === 'setParameters') && sets.every((s) => fixes.some((f) => f.kind === 'flow' && f.node === s.node && f.parameter === s.k && f.to === s.v));
}

const toolNames = (config: Record<string, unknown> | undefined): string[] => (Array.isArray(config?.tools) ? (config!.tools as Array<Record<string, unknown>>).map((t) => String(t.name ?? t.type ?? '')).filter(Boolean) : []);

/** The tools a design adds to an agent's draft (names). */
export const toolsAdded = (before: Record<string, unknown> | undefined, after: Record<string, unknown>): string[] => {
  const had = new Set(toolNames(before));
  return toolNames(after).filter((n) => !had.has(n));
};

/** The earlier fix whose tool a designed change removes (the agent change would undo it). */
export function agentUndoneBy(agentId: string, config: Record<string, unknown>, fixes: readonly OwnFix[]): OwnFix | undefined {
  const names = new Set(toolNames(config));
  return fixes.find((f) => f.kind === 'agent' && f.agentId === agentId && f.toolsAdded?.some((t) => !names.has(t)));
}

/** The tools this session added to an agent so far: what the design route keeps (`keep`). */
export const keptTools = (agentId: string, fixes: readonly OwnFix[]): string[] => [...new Set(fixes.flatMap((f) => (f.kind === 'agent' && f.agentId === agentId ? (f.toolsAdded ?? []) : [])))];

export const KEEP_REASON = 'These tools were added earlier in this test-and-fix session; a later round does not undo them.';

/** The timeline's line for a proposal dropped because it would undo the session's own fix. */
export const droppedLine = (fix: OwnFix): string => keptOwnFixLine(fix);

/** The line for the flow proposals dropped when a reply also holds an agent fix (C3). */
export const leftForNextRound = (summaries: readonly string[]): string => `Left for the next round: ${summaries.slice(0, 3).join('; ')}${summaries.length > 3 ? ` and ${summaries.length - 3} more` : ''}.`;

/** The agent step's reply for the review: its output text clipped like `outputOf` clips, and the tool calls its output lists. */
export function agentReplyText(steps: ReadonlyArray<{ name: string; sample: unknown }>): string {
  const lines = steps.flatMap(({ name, sample }) => {
    if (sample === undefined || sample === null) return [];
    const json = JSON.stringify(sample);
    const first = Array.isArray(sample) ? sample[0] : sample;
    const calls =
      first && typeof first === 'object'
        ? ['toolCalls', 'tool_calls', 'tools', 'toolsUsed', 'steps'].flatMap((k) => {
            const v = (first as Record<string, unknown>)[k];
            return Array.isArray(v) ? v.map((c) => (typeof c === 'string' ? c : String((c as { name?: unknown; tool?: unknown } | null)?.name ?? (c as { tool?: unknown } | null)?.tool ?? ''))).filter(Boolean) : [];
          })
        : [];
    return [` The agent step “${name}” replied: ${json.length > 1200 ? `${json.slice(0, 1200)}…` : json}.${calls.length ? ` Tool calls it made: ${[...new Set(calls)].join(', ')}.` : ' Its tool calls are in the run log (get_run_log).'}`];
  });
  return lines.join('');
}

/** The request that asks for one more agent fix after the gate held: the lowest cases with the judge's reasons. */
export function heldRequest(agent: string, line: string, lowCases: ReadonlyArray<{ input: string; reason?: string }>): string {
  const rows = lowCases.map((c) => `a case with the input “${c.input}” scored low${c.reason ? `: ${c.reason}` : ''}`);
  return `${line} Change “${agent}” so these cases pass without removing what it already does: ${rows.length ? rows.join('; ') : 'the cases that scored lowest'}.`;
}

/** The session's line for a held verdict: the shared wording (`heldLine` of lib/shared/agent-eval.ts, also the publish card's and the agent card's) with the agent named, so every place says it the same way. */
export function heldLine(agent: string, held: { average?: number; basis?: string; shared?: number; reason?: string } | undefined, fallback?: string): string {
  if (held?.average === undefined) return `The eval gate held “${agent}”${held?.reason ?? fallback ? `: ${held?.reason ?? fallback}` : ''}.`;
  return `“${agent}”: ${gateHeldLine({ average: held.average, basis: held.basis as 'threshold' | 'same-cases' | undefined, shared: held.shared, reason: held.reason ?? '' })}`;
}

/**
 * The steps of a flow that plainly duplicate what the Run an Agent step before them does (the person's decision of 2026-11-18:
 * an autonomous fix session removes them without a click): node id to the agent's name. It is `dropRepeatedAgentWork`'s own rule
 * (a Send Email after an agent whose Send Email tool does not ask first, to the same or no address), never a looser copy.
 */
export function duplicatedSteps(
  workflow: { nodes: ReadonlyArray<{ id: string; type: string; name: string; parameters?: Record<string, unknown> }>; connections: ReadonlyArray<{ source: string; target: string; type: 'main' | string; sourceIndex?: number }> },
  briefs: readonly AgentBrief[],
): Map<string, string> {
  const nodes = workflow.nodes.map((n) => ({ key: n.id, type: n.type, name: n.name, parameters: n.parameters }));
  const edges = workflow.connections.map((c): [string, string, number, never] => [c.source, c.target, c.sourceIndex ?? 0, c.type as never]);
  return new Map(dropRepeatedAgentWork(nodes, edges, briefs).by.map((d) => [d.key, d.agent]));
}

/** Headers a trigger's last event keeps out of a test run: what authenticates the caller or signs the call is not test data. */
export const SECRET_HEADERS = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-webhook-secret|x-hub-signature.*|.*-signature|.*token.*|.*secret.*)$/i;
/** Query parameters that look like a secret (a token, key, signature, password or auth value). */
export const SECRET_PARAMS = /token|secret|signature|password|passwd|api[-_]?key|\bkey$|^sig$|auth/i;

/** A trigger event's JSON without the secrets of the call: its signature, token and secret headers and its secret-looking query parameters. */
export function withoutSecrets(item: Record<string, unknown>): Record<string, unknown> {
  const pick = (value: unknown, secret: (key: string) => boolean) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !secret(key))) : undefined;
  const headers = pick(item.headers, (k) => SECRET_HEADERS.test(k));
  const query = pick(item.query, (k) => SECRET_PARAMS.test(k));
  return { ...item, ...(headers && { headers }), ...(query && { query }) };
}

/**
 * The removals an autonomous fix session may make without a click (the person's decision of 2026-11-18): a step the session
 * itself added (`own`, node ids) and a step that plainly duplicates what the bound agent does (`duplicates`: node id to the
 * agent's name, from `duplicatedSteps`). Anything else, a step the person built included, still waits. sb1's `needsAClick` is not
 * edited: this wraps it and takes the allowed removals out of what it reads.
 */
export interface RemovalsAllowed {
  own?: ReadonlySet<string>;
  duplicates?: ReadonlyMap<string, string>;
}

/** The steps these ops remove that `allowed` lets go without a click, by node id, with the timeline's line (*Removed “X”: why*). */
function allowedGone(ops: readonly ChangeOp[], before: ChangeGraph, allowed: RemovalsAllowed | undefined): Map<string, string> {
  const gone = new Map<string, string>();
  if (!allowed) return gone;
  for (const op of ops) {
    if (op.op !== 'removeNode') continue;
    const node = op.node ? before.nodes.find((n) => n.name === op.node || n.id === op.node) : undefined;
    if (!node) continue;
    if (allowed.own?.has(node.id)) gone.set(node.id, `Removed “${node.name}”: this session added it`);
    else if (allowed.duplicates?.has(node.id)) gone.set(node.id, `Removed “${node.name}”: “${allowed.duplicates.get(node.id)}” does it itself`);
  }
  return gone;
}

/** The timeline's line for each removal that went through without a click, with its reason. */
export function removedWithoutClick(ops: readonly ChangeOp[], before: ChangeGraph, allowed: RemovalsAllowed | undefined): string[] {
  return [...allowedGone(ops, before, allowed).values()];
}

/** `needsAClick` for an autonomous fix session: the same rule, minus the allowed removals (and the disconnects that only leave a step going or the session's own without input). */
export function fixNeedsAClick(ops: readonly ChangeOp[], before: ChangeGraph, allowed: RemovalsAllowed | undefined): string[] {
  const gone = allowedGone(ops, before, allowed);
  if (!gone.size && !allowed?.own?.size) return needsAClick(ops, before);
  const find = (ref: string | undefined) => (ref ? before.nodes.find((n) => n.name === ref || n.id === ref) : undefined);
  const rest = ops.filter((op) => {
    if (op.op === 'removeNode') return !(find(op.node) && gone.has(find(op.node)!.id));
    if (op.op === 'disconnect') {
      const target = find(op.to);
      return !(target && (gone.has(target.id) || allowed?.own?.has(target.id)));
    }
    return true;
  });
  return needsAClick(rest, before);
}
