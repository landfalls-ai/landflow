/**
 * Runbooks from closed Landfall rooms (docs/runbooks.md). Deterministic: a room (its incident, timeline and
 * optionally the "Room outcomes" row) is folded into reviewable steps (`draftFromRoom`), and the reviewed steps become
 * an ordinary workflow (`runbookWorkflow`): a form wait per step, and before a risky or production-changing step a
 * form wait that asks for approval, an If and a No Operation that ends the run on a rejection. The workflow carries the tags
 * `runbook` and `alert-kind:<slug>`, which is how `findRunbooks` matches an alert of the same kind. No model is used.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import type { StickyNote, Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import { store } from './store';

export const RUNBOOK_TAG = 'runbook';
const KIND_PREFIX = 'alert-kind:';
const ROOM_PREFIX = 'room:';

export interface RunbookStep {
  title: string;
  /** Needs a person's approval before it runs. */
  approval: boolean;
  /** Why: what the responders marked, or the word that matched. */
  reason?: string;
  /** What the responders said around this step, oldest first. */
  notes: string[];
  /** Where it came from: the timeline seq of the applied record, or the outcome row. */
  source?: { seq?: number; remediationId?: string; from: 'remediation' | 'outcome' };
}

export interface RunbookDraft {
  name: string;
  alertKind: string;
  description: string;
  room?: string;
  steps: RunbookStep[];
  /** Records that were left out and why (a repeat of an earlier step). */
  skipped: string[];
  /** Cause, fix and lessons from the Room outcomes row, shown on the runbook's first note. */
  background: { cause?: string; fix?: string; lessons?: string };
}

const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const roomSchema = z.object({
  incident: z
    .object({
      id: z.string().optional(),
      displayId: z.string().optional(),
      number: z.number().optional(),
      title: z.string().default(''),
      severity: z.string().optional(),
      category: z.string().optional(),
      alertSource: z.string().optional(),
    })
    .passthrough(),
  events: z.array(z.object({ seq: z.number(), type: z.string(), payload: z.record(z.string(), z.unknown()).optional(), actorType: z.string().optional() }).passthrough()).max(20_000).default([]),
  outcome: z
    .object({
      real_incident: z.boolean().optional(),
      realIncident: z.boolean().optional(),
      cause: z.string().optional(),
      fix: z.string().optional(),
      lessons: z.string().optional(),
      runbook_steps: z.array(z.string()).optional(),
      runbookSteps: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
});
export type Room = z.infer<typeof roomSchema>;

/**
 * The alert kind: lower-case words joined with hyphens. CamelCase splits (`HighErrorRate` is `high-error-rate`),
 * ids, numbers and brackets are dropped, so a room's title and the alert that opened it usually agree.
 */
export function alertKindSlug(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b(sev[1-4]|p[0-4]|inc[-_ ]?\d+|\d{4}-\d{2}-\d{2}\S*|[0-9a-f]{8,})\b/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/** The kind of a canonical alert (plugins/triage): its alertname label, else its title. A string is slugged as is. */
export function alertKindOf(alert: unknown): string {
  if (typeof alert === 'string') return alertKindSlug(alert);
  const a = (alert && typeof alert === 'object' ? alert : {}) as { labels?: Record<string, unknown>; title?: unknown };
  return alertKindSlug(a.labels?.alertname) || alertKindSlug(a.title);
}

const APPLIED = ['remediation.applied-externally', 'remediation.applied', 'edge.action.applied', 'edge.action.executed'];
const PROPOSED = ['remediation.proposed', 'edge.action.proposed'];
const ACTION_KEYS = ['action', 'description', 'title', 'summary', 'command', 'text'];
/** Words in an action that mean it changes something that is running. */
const CHANGES = /\b(restart|reboot|rollback|roll back|revert|redeploy|deploy|delete|drop|truncate|purge|flush|kill|terminate|scale|failover|fail over|disable|enable|block|drain|cordon|evict|patch|migrate|rotate|revoke|reset|update|apply|set|increase|decrease|resize|swap|promote)\b/i;
const falsy = (v: unknown) => v === false || /^(low|none|safe|no|false)$/i.test(String(v ?? '').trim());

function actionText(...payloads: Array<Record<string, unknown> | undefined>): string {
  for (const payload of payloads) for (const key of ACTION_KEYS) if (text(payload?.[key])) return text(payload?.[key]);
  return '';
}

/** Whether a step needs approval, and why: the responders' own marks win, then production, then a changing word. */
export function approvalFor(title: string, ...payloads: Array<Record<string, unknown> | undefined>): { approval: boolean; reason?: string } {
  const marks = payloads.filter(Boolean) as Array<Record<string, unknown>>;
  const field = (...keys: string[]) => marks.map((p) => keys.map((k) => p[k]).find((v) => v !== undefined)).find((v) => v !== undefined);
  const risk = field('risky', 'risk', 'destructive', 'requiresApproval');
  if (risk !== undefined && falsy(risk)) return { approval: false };
  if (risk !== undefined) return { approval: true, reason: 'The responders marked it risky' };
  const env = text(field('environment', 'env'), 60);
  if (/^prod/i.test(env)) return { approval: true, reason: 'It changes production' };
  const match = CHANGES.exec(title);
  if (match) return { approval: true, reason: `It changes a running system (“${match[1].toLowerCase()}”)` };
  return { approval: false };
}

const chatLine = (payload: Record<string, unknown> | undefined) => {
  const body = text(payload?.text);
  return body ? `${text(payload?.displayName, 60) ? `${text(payload?.displayName, 60)}: ` : ''}${body}` : '';
};

/** Fold a room into steps: one per applied remediation, in order, with the chat around it as notes. */
export function draftFromRoom(room: Room, options: { alertKind?: string; name?: string } = {}): RunbookDraft {
  const events = [...room.events].sort((a, b) => a.seq - b.seq);
  const proposals = new Map<number, Record<string, unknown>>();
  for (const e of events) if (PROPOSED.includes(e.type)) proposals.set(e.seq, e.payload ?? {});
  const steps: RunbookStep[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let previous = -1;
  for (const e of events) {
    if (!APPLIED.includes(e.type)) continue;
    const payload = e.payload ?? {};
    const proposal = typeof payload.sourceSeq === 'number' ? proposals.get(payload.sourceSeq) : undefined;
    const title = actionText(payload, proposal);
    if (!title) {
      skipped.push(`#${e.seq} ${e.type}: no action text`);
      continue;
    }
    const key = title.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) {
      skipped.push(`#${e.seq}: “${title}” repeats an earlier step`);
      continue;
    }
    seen.add(key);
    const notes = [
      ...(text(payload.note) ? [text(payload.note)] : []),
      ...events.filter((c) => c.type === 'chat.message' && c.seq > previous && c.seq < e.seq).map((c) => chatLine(c.payload)).filter(Boolean),
    ].slice(-5);
    previous = e.seq;
    const remediationId = text(payload.remediationId ?? proposal?.remediationId, 80);
    steps.push({ title, ...approvalFor(title, payload, proposal), notes, source: { seq: e.seq, ...(remediationId && { remediationId }), from: 'remediation' } });
  }
  const outcome = room.outcome;
  if (!steps.length) {
    // No remediation records: the outcome row's suggested steps (written by the lessons flow), in order.
    for (const raw of outcome?.runbookSteps ?? outcome?.runbook_steps ?? []) {
      const title = text(raw);
      if (title) steps.push({ title, ...approvalFor(title), notes: [], source: { from: 'outcome' } });
    }
  }
  const incident = room.incident;
  const label = text(incident.displayId, 40) || (incident.number !== undefined ? `#${incident.number}` : '') || text(incident.id, 40);
  const alertKind = alertKindSlug(options.alertKind) || alertKindSlug(incident.category && incident.category !== 'unknown' ? incident.category : '') || alertKindSlug(incident.title) || 'incident';
  const background = { cause: text(outcome?.cause, 600), fix: text(outcome?.fix, 600), lessons: text(outcome?.lessons, 600) };
  return {
    name: text(options.name, 120) || `Runbook: ${text(incident.title, 100) || alertKind}`,
    alertKind,
    description: `Draft from the Landfall room ${label || 'that closed'}${incident.title ? ` “${text(incident.title, 120)}”` : ''}. Review the steps, then publish.`,
    ...(label && { room: label }),
    steps,
    skipped,
    background: Object.fromEntries(Object.entries(background).filter(([, v]) => v)) as RunbookDraft['background'],
  };
}

export const stepSchema = z.object({
  title: z.string().trim().min(1).max(300),
  approval: z.boolean().default(false),
  reason: z.string().max(300).optional(),
  notes: z.array(z.string().max(600)).max(10).default([]),
  source: z.object({ seq: z.number().optional(), remediationId: z.string().optional(), from: z.enum(['remediation', 'outcome']) }).optional(),
});

const X = 280;
const form = (id: string, name: string, x: number, parameters: JsonObject, notes?: string): WorkflowNode => ({ id, name, type: 'core.wait', typeVersion: 2, position: [x, 0], parameters: { resume: 'form', ...parameters }, ...(notes && { notes }) });

/** The workflow for reviewed steps. Not active; a person reviews and publishes it. */
export function runbookWorkflow(input: { name: string; alertKind: string; description?: string; room?: string; steps: RunbookStep[]; background?: RunbookDraft['background'] }): Workflow {
  const kind = alertKindSlug(input.alertKind) || 'incident';
  const nodes: WorkflowNode[] = [];
  const connections: WorkflowConnection[] = [];
  const link = (source: string, target: string, sourceIndex = 0) => connections.push({ id: `c_${nanoid(8)}`, type: 'main', source, sourceIndex, target, targetIndex: 0 });
  nodes.push({ id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} });
  nodes.push({ id: 'called', name: 'When Called by a Workflow or Agent', type: 'core.workflowTrigger', typeVersion: 1, position: [0, 160], parameters: { inputSource: 'passthrough' }, notes: 'The triage flow starts the runbook from here with the alert.' });
  let tail = '';
  let x = X;
  const attach = (id: string) => {
    if (!tail) {
      link('start', id);
      link('called', id);
    } else link(tail, id);
  };
  const total = input.steps.length;
  input.steps.forEach((step, k) => {
    const n = k + 1;
    const notes = step.notes.length ? step.notes.map((line) => `- ${line}`).join('\n') : undefined;
    if (step.approval) {
      const ask = form(`approve_${n}`, `Approve step ${n}`, x, {
        formTitle: `Approve step ${n} of ${total}: ${step.title}`.slice(0, 200),
        formDescription: [step.reason, notes].filter(Boolean).join('\n'),
        formFields: { values: [{ fieldLabel: 'Decision', fieldName: 'decision', fieldType: 'radio', fieldOptions: 'Approve\nReject', requiredField: true }, { fieldLabel: 'Reason', fieldName: 'reason', fieldType: 'textarea' }] },
        buttonLabel: 'Decide',
      }, step.reason);
      attach(ask.id);
      const gate: WorkflowNode = { id: `gate_${n}`, name: `Approved ${n}?`, type: 'core.if', typeVersion: 1, position: [x + X, 0], parameters: { conditions: { condition: [{ left: '{{ $json.decision }}', operator: 'equals', right: 'Approve' }] }, combinator: 'and' } };
      const stop: WorkflowNode = { id: `reject_${n}`, name: `Rejected ${n}: stop here`, type: 'core.noOp', typeVersion: 1, position: [x + X, 160], parameters: {}, notes: `Step ${n} was rejected, so the runbook stops here: ${step.title.slice(0, 120)}` };
      nodes.push(ask, gate, stop);
      link(ask.id, gate.id);
      link(gate.id, stop.id, 1);
      tail = gate.id;
      x += X * 2;
    }
    const run = form(`step_${n}`, `Step ${n}: ${step.title}`.slice(0, 80), x, {
      formTitle: `Step ${n} of ${total}: ${step.title}`.slice(0, 200),
      formDescription: notes ?? '',
      formFields: { values: [{ fieldLabel: 'Outcome', fieldName: 'outcome', fieldType: 'radio', fieldOptions: 'Done\nSkipped', requiredField: true }, { fieldLabel: 'What happened', fieldName: 'result', fieldType: 'textarea' }] },
      buttonLabel: 'Next',
    }, notes);
    nodes.push(run);
    attach(run.id);
    tail = run.id;
    x += X;
  });
  const about = [`# ${input.name}`, input.description, input.background?.cause && `**Cause.** ${input.background.cause}`, input.background?.fix && `**Fix.** ${input.background.fix}`, input.background?.lessons && `**Lessons.** ${input.background.lessons}`, `Alert kind: \`${kind}\``].filter(Boolean).join('\n\n');
  const sticky: StickyNote = { id: `sticky_${nanoid(6)}`, content: about, position: [0, -260], width: 520, height: 220 };
  return {
    id: `wf_${nanoid(10)}`,
    name: input.name,
    description: input.description ?? '',
    nodes,
    connections,
    active: false,
    stickyNotes: [sticky],
    tags: [RUNBOOK_TAG, `${KIND_PREFIX}${kind}`, ...(input.room ? [`${ROOM_PREFIX}${input.room}`.slice(0, 60)] : [])],
  };
}

export interface RunbookView {
  id: string;
  name: string;
  alertKind: string;
  room?: string;
  steps: number;
  approvals: number;
  published: boolean;
  updatedAt: string;
  /** The editor page. */
  url: string;
}

const kindOf = (tags: string[] = []) => tags.find((t) => t.startsWith(KIND_PREFIX))?.slice(KIND_PREFIX.length) ?? '';

export function runbookView(workflow: Workflow): RunbookView {
  const room = workflow.tags?.find((t) => t.startsWith(ROOM_PREFIX))?.slice(ROOM_PREFIX.length);
  return {
    id: workflow.id,
    name: workflow.name,
    alertKind: kindOf(workflow.tags),
    ...(room && { room }),
    steps: workflow.nodes.filter((n) => n.id.startsWith('step_')).length,
    approvals: workflow.nodes.filter((n) => n.id.startsWith('approve_')).length,
    published: Boolean(workflow.active),
    updatedAt: workflow.updatedAt ?? workflow.createdAt ?? '',
    url: `/workflows/${workflow.id}`,
  };
}

export const isRunbook = (workflow: Pick<Workflow, 'tags'>) => Boolean(workflow.tags?.includes(RUNBOOK_TAG));

/** Words of a kind, for a looser match when no runbook has exactly this kind. */
const words = (kind: string) => kind.split('-').filter((w) => w.length > 2);
const similar = (a: string, b: string) => {
  const [x, y] = [words(a), words(b)];
  if (x.length < 2 || y.length < 2) return false;
  const shared = x.filter((w) => y.includes(w)).length;
  return shared >= Math.min(x.length, y.length) && shared >= 2;
};

/**
 * Runbooks for an alert kind, best first: exact kind before a similar one (the shorter name's words all appear in the
 * other), published before draft, newest first. `kind` empty lists them all. `among` limits the workflows looked at.
 */
export function findRunbooks(kind: string, among: Workflow[] = store.listWorkflows()): Array<RunbookView & { match: 'exact' | 'similar' | 'all' }> {
  const wanted = alertKindSlug(kind);
  const rank = { exact: 0, similar: 1, all: 2 } as const;
  return among
    .filter(isRunbook)
    .map((w) => ({ w, view: runbookView(w) }))
    .flatMap(({ w, view }) => {
      const match = !wanted ? 'all' : view.alertKind === wanted ? 'exact' : similar(view.alertKind, wanted) ? 'similar' : undefined;
      return match ? [{ ...view, match: match as 'exact' | 'similar' | 'all', _w: w }] : [];
    })
    .sort((a, b) => rank[a.match] - rank[b.match] || Number(b.published) - Number(a.published) || b.updatedAt.localeCompare(a.updatedAt))
    .map(({ _w, ...view }) => view);
}
