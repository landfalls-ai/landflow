/**
 * What a run did, in one line (docs/run-trace.md#what-a-run-did-in-one-line, the new look): what came in (the trigger and
 * what it carried), who did it (the agent, or the team's lead with the members who worked under it) and what came out
 * (from the run's artifacts and reply), green when done, amber when it waits for a person, red when it failed.
 */
import { teamSnapshotOf } from './agent-teams';
import type { RunActor } from './run-trace';
import { cut, preview, type RunArtifactItem, type RunModel, type RunSpan } from './run-trace-model';
import { teamLead } from './run-timeline';

export type LineTone = 'ok' | 'warn' | 'bad' | 'live';

export interface RunLine {
  /** What came in: "Pull request", "Run by you", "Chat message"; its detail: "#5 Add alerts", the message. */
  in: { label: string; detail?: string; nodeType?: string; kind: 'manual' | 'schedule' | 'webhook' | 'form' | 'chat' | 'pull_request' | 'email' | 'other' };
  /** Who did it: the lead (or the agent) and the members who worked under it. */
  by: { lead?: RunActor; members: RunActor[]; team?: string; memberCount?: number };
  /** What came out: "Pull request opened", "Review posted", "Answered"; its detail and where it opens. */
  out: { label: string; detail?: string; url?: string; kind?: string; tone: LineTone };
  status: RunModel['status'];
  ms: number;
  tokens: number;
}

const same = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** The first item's json of an output kept as items (`[[{ json }]]`, `[{ json }]`, or the json itself). */
export function firstJson(output: unknown): Record<string, unknown> | undefined {
  let value = output;
  for (let i = 0; i < 3 && Array.isArray(value); i++) value = value[0];
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  return v.json && typeof v.json === 'object' && !Array.isArray(v.json) ? (v.json as Record<string, unknown>) : v;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** What came in, from the run's first step (its trigger) and what that step put out. */
export function lineIn(model: RunModel): RunLine['in'] {
  const top = model.order.filter((s) => s.parentId === model.run?.id);
  const trigger = top.find((s) => /trigger|webhook|schedule|cron|form|chat|poll/i.test(`${s.actor.nodeType ?? ''} ${s.attrs.nodeType ?? ''}`)) ?? top[0];
  const nodeType = String(trigger?.actor.nodeType ?? trigger?.attrs.nodeType ?? '');
  const json = firstJson(trigger?.output) ?? {};
  const pr = (json.pull_request ?? (json.number && json.html_url && /\/pull\//.test(String(json.html_url)) ? json : undefined)) as Record<string, unknown> | undefined;
  if (pr) return { kind: 'pull_request', label: 'Pull request', detail: [pr.number && `#${pr.number}`, str(pr.title)].filter(Boolean).join(' '), nodeType };
  if (/manual/i.test(nodeType) || (!trigger && model.run?.caller?.type === 'human')) return { kind: 'manual', label: 'Run by you', nodeType };
  if (/schedule|cron/i.test(nodeType)) return { kind: 'schedule', label: 'On schedule', detail: trigger?.name, nodeType };
  if (/chat/i.test(nodeType)) return { kind: 'chat', label: 'Chat message', detail: preview(str(json.chatInput) ?? str(json.message) ?? str(json.text) ?? '', 60) || undefined, nodeType };
  if (/form/i.test(nodeType)) return { kind: 'form', label: 'Form sent', detail: trigger?.name, nodeType };
  if (/mail|imap|gmail/i.test(nodeType)) return { kind: 'email', label: 'Email', detail: str(json.subject), nodeType };
  if (/webhook/i.test(nodeType)) return { kind: 'webhook', label: 'Webhook', detail: trigger?.name, nodeType };
  if (trigger) return { kind: 'other', label: cut(trigger.name, 28), nodeType };
  return { kind: 'manual', label: 'Run by you' };
}

/** Artifacts in the order a person cares about: what was delivered, then pull requests and reviews, then the rest. */
const RANK: Array<[RegExp, string]> = [
  [/pull_request|^pr$/i, 'Pull request opened'],
  [/review/i, 'Review posted'],
  [/release|publish|notes/i, 'Published'],
  [/commit/i, 'Committed'],
  [/ticket|issue/i, 'Ticket filed'],
  [/document|doc|report|markdown/i, 'Document written'],
  [/row|record|table|sheet/i, 'Row written'],
  [/message|email|slack/i, 'Message sent'],
  [/file/i, 'File written'],
  [/link/i, 'Link'],
];

function bestArtifact(model: RunModel): RunArtifactItem | undefined {
  const delivered = new Set(model.order.flatMap((s) => s.delivered.map((d) => d.id)));
  const rank = (a: RunArtifactItem) => {
    const r = RANK.findIndex(([re]) => re.test(a.artifact.kind ?? a.artifact.name));
    return (delivered.has(a.id) ? 0 : 100) + (r < 0 ? RANK.length : r);
  };
  return [...model.artifacts].sort((a, b) => rank(a) - rank(b) || b.seq - a.seq)[0];
}

/** What came out: the wait for a person, the failure, the best artifact, else the reply. */
export function lineOut(model: RunModel): RunLine['out'] {
  const wait = model.needsYou.find((n) => n.kind === 'wait');
  if (wait) return { label: 'Needs you', detail: cut(wait.title, 60), tone: 'warn' };
  const failedSpan: RunSpan | undefined = model.order.filter((s) => s.status === 'error' && s.kind !== 'run').at(-1);
  if (model.status === 'error' && !model.live) return { label: 'Failed', detail: cut(failedSpan?.error ?? model.run?.error ?? failedSpan?.name ?? 'The run stopped', 60), tone: 'bad' };
  const artifact = bestArtifact(model);
  const tone: LineTone = model.live ? 'live' : 'ok';
  if (artifact) {
    const label = RANK.find(([re]) => re.test(artifact.artifact.kind ?? artifact.artifact.name))?.[1] ?? cut(artifact.artifact.name, 28);
    return { label, detail: cut(artifact.artifact.name, 48), ...(artifact.artifact.url && { url: artifact.artifact.url }), ...(artifact.artifact.kind && { kind: artifact.artifact.kind }), tone };
  }
  if (model.live) return { label: 'Working…', detail: model.working.at(-1) ? cut(`${model.working.at(-1)!.actor.name}: ${model.working.at(-1)!.name}`, 60) : undefined, tone };
  // The reply in words: what the run reported unless that is data (a flow's last output as JSON), else what an agent said
  // last, else a team node's reply.
  const words = (t: unknown) => (typeof t === 'string' && t.trim() && !/^\s*[{[]/.test(t) ? t : undefined);
  const teamReply = model.order.map((s) => (s.output && typeof s.output === 'object' ? (s.output as { reply?: unknown }).reply : undefined)).filter(Boolean).at(-1);
  const reply = words(model.outcome.reported?.text) ?? words(model.messages.at(-1)?.text) ?? words(teamReply);
  if (reply || model.outcome.reported) return { label: 'Answered', ...(reply && { detail: preview(reply, 60) }), tone };
  return { label: model.status === 'canceled' ? 'Stopped' : 'Done', tone: model.status === 'canceled' ? 'warn' : 'ok' };
}

/** Who did it: the team's lead and the members who had a turn, else the agents that worked, else nobody (the flow). */
export function lineBy(model: RunModel): RunLine['by'] {
  const team = model.order.map((s) => teamSnapshotOf(s.attrs)).find(Boolean);
  const agents = model.actors.filter((a) => a.actor.type === 'agent');
  if (team) {
    const leadMember = teamLead(team);
    const lead = agents.find((a) => same(a.actor.name, leadMember?.title))?.actor ?? (leadMember ? { id: `member:${leadMember.id}`, name: leadMember.title, type: 'agent' as const } : undefined);
    const members = agents.filter((a) => !same(a.actor.name, leadMember?.title) && team.members.some((m) => same(m.title, a.actor.name)) && (model.turns[a.actor.id]?.length ?? 0) > 0).map((a) => a.actor);
    return { ...(lead && { lead }), members, team: team.name, memberCount: team.members.length - 1 };
  }
  const [lead, ...rest] = agents.map((a) => a.actor);
  return { ...(lead && { lead }), members: rest };
}

export function runLine(model: RunModel): RunLine {
  return {
    in: lineIn(model),
    by: lineBy(model),
    out: lineOut(model),
    status: model.status,
    ms: model.t1 - model.t0,
    tokens: model.tokens.inputTokens + model.tokens.outputTokens,
  };
}
