/**
 * Suggestions (docs/second-brain.md#4-detectors-and-suggestions): what the detectors, workflows' Suggest Improvement nodes
 * and the Platform analyst propose. One open suggestion per fingerprint: the same finding again refreshes it. They are
 * ranked by score, capped per workflow per week, and expire when no detector confirms them for 14 days.
 *
 * Nothing changes until someone applies one: its edit operations are validated against the workflow as it is now and saved
 * through governance like an edit by hand (governedSave), a draft becomes a new workflow, and persona rules go to the
 * agent's draft. Applying records the baseline its effect is measured against (./effect.ts).
 *
 * Dismissing teaches: `intended` becomes a fact and the fingerprint is never suggested again; `wrong` and `not-relevant`
 * keep it away for 30 days and quiet the detector that made it (detectorStats).
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Workflow } from '@landflow/engine';
import type { DetectorId, DetectorStat, DismissReason, FlowDetectorId, Proposal, ProposalAction, ProposalDecision, ProposalInput, ProposalRisk, ProposalSource, ProposalStatus } from '../../shared/brain';
import { DETECTOR_LABELS, DETECTORS, flowDetectorWorkflow, isFlowDetector, MAX_PROPOSAL_ACTIONS, quietBar, RESERVED_ACTION_IDS, detectorFilter } from '../../shared/brain';
import { agentStore } from '../agents/store';
import { validateOps } from '../assistant/ops';
import { database, type Database } from '../db';
import { governedSave } from '../governance/saves';
import { approveProjectNote, NoteError } from '../notebook/approve';
import { homeProjectId } from '../projects/store';
import { workflowForCall } from '../publish';
import { store } from '../store';
import { recordUsage } from '../usage/ledger';
import type { UsageScope } from '../usage/query';
import { cleanAudience, inAudience, mirrorDecision, mirrorNew } from './audience';
import { decidedBuilders, decisionListeners, dispatchDecision } from './decision-trigger';
import { baselineFor, checkEffectAsync, settleBaseline, unsettled } from './effect';
import { getEntity, entityKey, entityProject } from './entities';
import { upsertFact } from './facts';
import { listFlowDetectors } from './flow-detectors';

const DAY_MS = 86_400_000;
export const STALE_DAYS = 14;
const QUIET_DAYS = 30;

export const weeklyCap = () => {
  const n = Number(process.env.LANDFLOW_BRAIN_WEEKLY_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
};

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const fingerprintOf = (...parts: Array<string | number | undefined>) =>
  createHash('sha1')
    .update(parts.map((p) => String(p ?? '')).join('|'))
    .digest('hex')
    .slice(0, 16);

const parse = (text: string): Proposal | undefined => {
  try {
    return JSON.parse(text) as Proposal;
  } catch {
    return undefined;
  }
};

/** Write a suggestion as it is (the Slack mirror records its message refs this way). */
export const saveProposal = (proposal: Proposal, db: Database = database()): Proposal => save(proposal, db);

function save(proposal: Proposal, db: Database = database()): Proposal {
  db.upsert('proposals', {
    id: proposal.id,
    fingerprint: proposal.fingerprint,
    source: proposal.source,
    detector: proposal.detector ?? null,
    project_id: proposal.projectId ?? null,
    workflow_id: proposal.target.type === 'workflow' ? (proposal.target.id ?? null) : null,
    status: proposal.status,
    score: proposal.score,
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
    data: JSON.stringify(proposal),
  });
  return proposal;
}

/** A snoozed suggestion whose time is up is open again. */
function awake(proposal: Proposal, now = Date.now()): Proposal {
  return proposal.status === 'snoozed' && proposal.snoozedUntil && Date.parse(proposal.snoozedUntil) <= now ? { ...proposal, status: 'open', snoozedUntil: undefined } : proposal;
}

export function getProposal(id: string, db: Database = database()): Proposal | undefined {
  const row = db.get<{ data: string }>('SELECT data FROM proposals WHERE id = ?', id);
  const proposal = row ? parse(row.data) : undefined;
  return proposal && awake(proposal);
}

function inScope(p: Proposal, scope?: UsageScope): boolean {
  if (!scope || (!scope.workflows && !scope.agents)) return true;
  if (p.target.type === 'workflow') return Boolean(p.target.id && scope.workflows?.has(p.target.id));
  if (p.target.type === 'agent') return Boolean(p.target.id && scope.agents?.has(p.target.id));
  if (p.target.type === 'team') return Boolean(p.target.id && scope.teams?.has(p.target.id));
  if (p.target.type === 'entity') return Boolean(p.target.id && scope.entities?.has(p.target.id));
  return false;
}

export function listProposals(
  filter: { status?: ProposalStatus | 'all'; workflowId?: string; agentId?: string; detector?: DetectorId; scope?: UsageScope; limit?: number; viewer?: { id: string; email?: string }; forMe?: boolean } = {},
  db: Database = database(),
): Proposal[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.workflowId) {
    where.push('workflow_id = ?');
    params.push(filter.workflowId);
  }
  if (filter.detector) {
    where.push('detector = ?');
    params.push(filter.detector);
  }
  const rows = db.all<{ data: string }>(`SELECT data FROM proposals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY score DESC, updated_at DESC`, ...params);
  const status = filter.status ?? 'open';
  return rows
    .flatMap((r) => parse(r.data) ?? [])
    .map((p) => awake(p))
    .filter((p) => (status === 'all' ? true : p.status === status))
    .filter((p) => !filter.agentId || (p.target.type === 'agent' && p.target.id === filter.agentId))
    // The people a suggestion is addressed to see it wherever it is about.
    .filter((p) => (filter.forMe ? inAudience(filter.viewer, p) : inScope(p, filter.scope) || inAudience(filter.viewer, p)))
    .slice(0, filter.limit ?? 200);
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

export type NewProposal = Omit<Proposal, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

/** Why a fingerprint isn't suggested now, if it isn't. */
function heldBack(fingerprint: string, now: number, db: Database): string | undefined {
  const rows = db.all<{ data: string }>('SELECT data FROM proposals WHERE fingerprint = ? ORDER BY updated_at DESC', fingerprint);
  for (const row of rows) {
    const p = parse(row.data);
    if (!p) continue;
    if (p.status === 'dismissed' && p.reason === 'intended') return 'dismissed as intended';
    const age = now - Date.parse(p.updatedAt);
    if (p.status === 'dismissed' && (p.reason === 'wrong' || p.reason === 'not-relevant') && age < QUIET_DAYS * DAY_MS) return `dismissed as ${p.reason}`;
    if ((p.status === 'applied' || (p.status === 'dismissed' && p.reason === 'done')) && age < STALE_DAYS * DAY_MS) return 'applied recently';
  }
  return undefined;
}

/**
 * Add a suggestion, or refresh the open one with the same fingerprint. Returns it, or undefined when it is held back (see
 * heldBack) or the target's weekly cap is full of better ones.
 */
export function upsertProposal(input: NewProposal, db: Database = database(), now = Date.now()): Proposal | undefined {
  const at = new Date(now).toISOString();
  const open = db
    .all<{ data: string }>("SELECT data FROM proposals WHERE fingerprint = ? AND status IN ('open', 'snoozed')", input.fingerprint)
    .flatMap((r) => parse(r.data) ?? [])[0];
  if (open) {
    // A refresh keeps the Slack messages already posted (they are not posted again); a member added since gets one.
    const slack = input.slack || open.slack ? { credential: (input.slack ?? open.slack)!.credential, messages: open.slack?.messages ?? [] } : undefined;
    const refreshed = save({ ...open, ...input, ...(slack && { slack }), id: open.id, status: open.status, createdAt: open.createdAt, updatedAt: at, ...(open.snoozedUntil && { snoozedUntil: open.snoozedUntil }) }, db);
    mirrorNew(refreshed);
    return refreshed;
  }
  if (heldBack(input.fingerprint, now, db)) return undefined;
  if (input.target.type === 'workflow' && input.target.id) {
    const week = db
      .all<{ data: string }>('SELECT data FROM proposals WHERE workflow_id = ? AND created_at >= ?', input.target.id, new Date(now - 7 * DAY_MS).toISOString())
      .flatMap((r) => parse(r.data) ?? []);
    if (week.length >= weeklyCap()) {
      const weakest = week.filter((p) => p.status === 'open').sort((a, b) => a.score - b.score)[0];
      if (!weakest || weakest.score >= input.score) return undefined;
      save({ ...weakest, status: 'expired', updatedAt: at, note: 'Replaced by a stronger suggestion' }, db);
    }
  }
  const added = save({ ...input, id: `pr_${nanoid(12)}`, status: 'open', createdAt: at, updatedAt: at }, db);
  mirrorNew(added);
  return added;
}

/** The buttons a flow asked for: at most 4, slug-like ids, none of the decisions' own names. Throws ProposalError when they don't fit. */
export function cleanActions(value: unknown): ProposalAction[] {
  let list = value;
  if (typeof list === 'string') {
    if (!list.trim()) return [];
    try {
      list = JSON.parse(list);
    } catch {
      throw new ProposalError('Actions is not valid JSON');
    }
  }
  // The node's fixed collection hands over { buttons: [...] }.
  if (list && typeof list === 'object' && !Array.isArray(list)) list = (list as { buttons?: unknown }).buttons;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ProposalError('Actions must be a list of { id, label }');
  const out: ProposalAction[] = [];
  for (const raw of list) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new ProposalError(`Action id “${id}” must be lowercase letters, digits, - or _ (up to 32)`);
    if (RESERVED_ACTION_IDS.includes(id)) throw new ProposalError(`Action id “${id}” is taken by a decision`);
    if (!label) throw new ProposalError(`Action ${id} needs a label`);
    if (out.some((x) => x.id === id)) throw new ProposalError(`Action id “${id}” is used twice`);
    const confirm = typeof a.confirm === 'string' ? a.confirm.trim().slice(0, 200) : '';
    out.push({ id, label: label.slice(0, 40), ...(a.style === 'primary' || a.style === 'default' ? { style: a.style } : {}), ...(confirm && { confirm }) });
  }
  if (out.length > MAX_PROPOSAL_ACTIONS) throw new ProposalError(`A suggestion can have at most ${MAX_PROPOSAL_ACTIONS} actions`);
  return out;
}

/**
 * A suggestion from a workflow (Suggest Improvement) or the analyst: its ops are checked against the target workflow.
 * `detector`: a flow detector's Suggest Improvement (./flow-detectors.ts) posts as that detector, and a finding under the
 * bar its quieting sets (quietBar) is held back.
 */
export function proposeFrom(
  input: ProposalInput,
  source: Exclude<ProposalSource, 'detector'>,
  db: Database = database(),
  options: { detector?: FlowDetectorId } = {},
): Proposal | undefined {
  const title = input.title?.trim();
  const why = input.why?.trim();
  if (!title || !why) throw new ProposalError('A suggestion needs a title and a reason (why)');
  const workflow = input.workflowId ? store.getWorkflow(input.workflowId) : undefined;
  if (input.workflowId && !workflow) throw new ProposalError(`No workflow ${input.workflowId}`, 404);
  const agent = input.agentId ? agentStore.get(input.agentId) : undefined;
  if (input.agentId && !agent) throw new ProposalError(`No agent ${input.agentId}`, 404);
  const actions = cleanActions(input.actions);
  const entity = input.entity ? getEntity(input.entity.type, input.entity.id, db) : undefined;
  if (input.entity && !entity) throw new ProposalError(`No ${input.entity.type} ${input.entity.id}`, 404);
  const audience = cleanAudience(input.audience);
  const validated = workflow && input.ops ? validateOps(workflow, input.ops) : undefined;
  const node = workflow && input.nodeName ? workflow.nodes.find((n) => n.name === input.nodeName) : undefined;
  const target: Proposal['target'] = workflow
    ? { type: 'workflow', id: workflow.id, name: workflow.name, ...(node && { nodeId: node.id, nodeName: node.name }) }
    : agent
      ? { type: 'agent', id: agent.id, name: agent.name }
      : entity
        ? { type: 'entity', id: entityKey(entity), name: entity.name }
        : { type: 'instance' };
  // A flow detector's fingerprints are its own, as a built-in detector's are (detectors.ts `base`).
  const given = input.fingerprint?.trim().slice(0, 64);
  const fingerprint = options.detector
    ? fingerprintOf(options.detector, ...(given ? [given] : [target.type, target.id, title]))
    : given || fingerprintOf(source, input.label, target.type, target.id, title);
  // Advice about a node that already has open advice is the same suggestion in other words (the same one again refreshes it).
  if (node && !validated?.ops.length && !input.draft && !input.agentChange) {
    const open = listProposals({ status: 'open', workflowId: workflow!.id }, db);
    if (open.some((p) => p.fingerprint !== fingerprint && p.target.nodeId === node.id && !p.ops.length && !p.draft && !p.agentChange)) return undefined;
  }
  const risk: ProposalRisk = input.risk ?? (validated?.ops.length ? 'medium' : 'low');
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.6));
  const detector = options.detector;
  if (detector && confidence < quietBar(quietOf(detector, db))) return undefined;
  return upsertProposal(
    {
      source: detector ? 'detector' : source,
      ...(detector && { detector }),
      ...(input.label && { label: input.label.slice(0, 80) }),
      fingerprint,
      ...((workflow || agent) && { projectId: homeProjectId(workflow ? 'workflow' : 'agent', (workflow ?? agent)!.id) }),
      ...(!workflow && !agent && entity && entityProject(entity) && { projectId: entityProject(entity) }),
      target,
      title: title.slice(0, 160),
      why: why.slice(0, 2_000),
      evidence: (input.evidence ?? []).slice(0, 12),
      ...(input.effect && { effect: input.effect.slice(0, 300) }),
      ...(actions.length && { actions }),
      ...(audience.length && { audience }),
      ...(audience.length && input.slackCredential && { slack: { credential: input.slackCredential, messages: [] } }),
      ops: validated?.ops ?? [],
      ...(validated && (validated.warnings.length || validated.dropped.length) && { warnings: [...validated.warnings, ...validated.dropped] }),
      ...(input.draft && { draft: input.draft }),
      ...(input.agentChange && agent && { agentChange: input.agentChange }),
      ...(detector && input.metricSpec && { metricSpec: input.metricSpec }),
      risk,
      confidence,
      score: confidence * (risk === 'low' ? 10 : risk === 'medium' ? 8 : 5),
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Acting on one
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  actorId?: string;
  /** The workflow making the decision, when one does (a workflow that starts from On Suggestion Decided never starts one). */
  viaWorkflowId?: string;
  /** Creates a draft's workflow in the right project (the route passes createIn). */
  createWorkflow?: (save: () => Workflow, id: string) => Workflow;
}

export interface ApplyResult {
  proposal: Proposal;
  workflow?: Workflow;
  warnings: string[];
  /** The workflows this decision starts: On Usage Event on proposal.applied (Build it) and On Suggestion Decided. */
  started?: Array<{ id: string; name: string }>;
}

/** Apply a suggestion (see the module comment). Throws ProposalError when it can't be. */
export function applyProposal(id: string, options: ApplyOptions = {}, db: Database = database()): ApplyResult {
  const proposal = getProposal(id, db);
  if (!proposal) throw new ProposalError('Suggestion not found', 404);
  if (proposal.status !== 'open' && proposal.status !== 'snoozed') throw new ProposalError(`This suggestion is ${proposal.status}`, 409);
  const warnings: string[] = [];
  let workflow: Workflow | undefined;
  let createdWorkflowId: string | undefined;

  if (proposal.draft) {
    const draftId = `wf_${nanoid(10)}`;
    const draft: Workflow = { ...proposal.draft, id: draftId, active: false };
    const create = () => governedSave(draft, undefined, (w) => store.saveWorkflow(w), { by: options.actorId, source: 'brain' }).workflow;
    workflow = options.createWorkflow ? options.createWorkflow(create, draftId) : create();
    createdWorkflowId = workflow.id;
  } else if (proposal.ops.length && proposal.target.type === 'workflow' && proposal.target.id) {
    const existing = store.getWorkflow(proposal.target.id);
    if (!existing) throw new ProposalError('The workflow is gone', 404);
    const validated = validateOps(existing, proposal.ops);
    if (!validated.ops.length) throw new ProposalError(`These changes no longer fit the workflow: ${validated.dropped.join('; ') || 'nothing to change'}`, 409);
    warnings.push(...validated.warnings, ...validated.dropped);
    workflow = governedSave(validated.workflow, existing, (w) => store.saveWorkflow(w), { by: options.actorId, source: 'brain' }).workflow;
  } else if (proposal.agentChange && proposal.target.type === 'agent' && proposal.target.id) {
    const agent = agentStore.get(proposal.target.id);
    if (!agent) throw new ProposalError('The agent is gone', 404);
    const persona = agent.persona ?? {};
    const add = (list: string[] | undefined, more: string[] | undefined) => [...new Set([...(list ?? []), ...(more ?? [])])];
    agentStore.saveDraft(agent.id, { persona: { ...persona, always: add(persona.always, proposal.agentChange.always), never: add(persona.never, proposal.agentChange.never) } });
    warnings.push('Added to the agent’s draft: publish it to use the new rules');
  } else if (proposal.notebook) {
    // A person said yes to keeping a team's note for the project (docs/team-notebook.md#promotion).
    try {
      approveProjectNote(proposal.notebook.noteId, options.actorId);
    } catch (caught) {
      if (caught instanceof NoteError) throw new ProposalError(caught.message, caught.status);
      throw caught;
    }
  } else if (proposal.detector === 'missing-tool') {
    // "Build it": a published workflow that starts from On Usage Event on proposal.applied builds the tool (an agentic
    // flow that writes the plugin, docs/second-brain.md). Applying only records the go-ahead.
    if (!builders().length) warnings.push('Nothing builds it yet: publish a workflow that starts from On Usage Event on proposal.applied (Suggestion From: Missing tool)');
  } else if (!startersFor(proposal, decisionOf('applied', options.actorId), options.viaWorkflowId).length) {
    throw new ProposalError('This suggestion is advice only: there is nothing to apply. Mark it done once you have handled it.', 400);
  }
  // Advice with a flow listening (On Suggestion Decided) falls through: applying records the go-ahead, as a missing tool does.

  const done = finishApplied(proposal, { actorId: options.actorId, createdWorkflowId, viaWorkflowId: options.viaWorkflowId }, db);
  return { proposal: done.proposal, ...(workflow && { workflow }), warnings, ...(done.started.length && { started: done.started }) };
}

/**
 * Take one of the buttons a flow put on a suggestion. It records the decision (`decision.action` is the button's id),
 * counts as applied (effect measurement and quieting see it so), and starts the flows listening. It changes nothing
 * else: what the button means is up to the flow.
 */
export function actOnProposal(
  id: string,
  action: string,
  options: { note?: string; actorId?: string; viaWorkflowId?: string } = {},
  db: Database = database(),
): ApplyResult {
  const proposal = getProposal(id, db);
  if (!proposal) throw new ProposalError('Suggestion not found', 404);
  const button = proposal.actions?.find((a) => a.id === action);
  if (!button) throw new ProposalError(`This suggestion has no action “${action}”`, 400);
  if (proposal.status !== 'open' && proposal.status !== 'snoozed') throw new ProposalError(`This suggestion is ${proposal.status}`, 409);
  const done = finishApplied(proposal, { actorId: options.actorId, viaWorkflowId: options.viaWorkflowId, action: button, note: options.note }, db);
  const warnings = done.started.length ? [] : ['No published workflow listens for this yet: publish one that starts from On Suggestion Decided'];
  return { proposal: done.proposal, warnings, ...(done.started.length && { started: done.started }) };
}

const NAMES = { applied: 'Applied', dismissed: 'Dismissed', snoozed: 'Snoozed' } as const;

function decisionOf(action: keyof typeof NAMES | ProposalAction, by?: string, extra: { note?: string; reason?: DismissReason } = {}, now = Date.now()): ProposalDecision {
  const id = typeof action === 'string' ? action : action.id;
  return {
    action: id,
    label: typeof action === 'string' ? NAMES[action] : action.label,
    ...(by && { by }),
    at: new Date(now).toISOString(),
    ...(extra.note && { note: extra.note.slice(0, 500) }),
    ...(extra.reason && { reason: extra.reason }),
  };
}

/** Everything a decision starts: On Usage Event on proposal.applied (for an apply or action) and On Suggestion Decided. */
function startersFor(proposal: Proposal, decision: ProposalDecision, via?: string): Array<{ id: string; name: string }> {
  const applies = decision.action !== 'dismissed' && decision.action !== 'snoozed';
  const found = [...(applies ? usageBuilders(proposal.detector) : []), ...decisionListeners(proposal, decision, via).map((l) => ({ id: l.workflow.id, name: l.workflow.name }))];
  return [...new Map(found.map((w) => [w.id, w])).values()];
}

/** Mark applied (a button, Apply, or the editor applying a change itself), then start the flows listening. */
export function finishApplied(
  proposal: Proposal,
  options: { actorId?: string; createdWorkflowId?: string; viaWorkflowId?: string; action?: ProposalAction; note?: string },
  db: Database,
): { proposal: Proposal; started: Array<{ id: string; name: string }> } {
  const next = markApplied(proposal, options, db);
  // markApplied returns an already-applied suggestion as it is, without a new decision.
  const decision = next.decision;
  if (!decision || next === proposal) return { proposal: next, started: [] };
  const usage = usageBuilders(proposal.detector);
  const decided = dispatchDecision(next, decision, options.viaWorkflowId);
  return { proposal: next, started: [...new Map([...usage, ...decided].map((w) => [w.id, w])).values()] };
}

/** Published workflows with On Usage Event on proposal.applied that take suggestions from this detector (unset: any). */
function usageBuilders(detector?: string): Array<{ id: string; name: string }> {
  return store
    .listWorkflows()
    .filter((saved) => saved.active)
    .map((saved) => workflowForCall(saved.id, 'trigger') ?? saved)
    .filter((w) =>
      w.nodes.some((n) => {
        if (n.type !== 'core.usageTrigger' || n.disabled) return false;
        const kinds = Array.isArray(n.parameters?.kinds) ? n.parameters.kinds : [];
        const wanted = detectorFilter(n.parameters?.detector);
        return (!kinds.length || kinds.includes('proposal.applied')) && (!wanted || wanted === detector);
      }),
    )
    .map((w) => ({ id: w.id, name: w.name }));
}

/** Published workflows that start when a missing-tool suggestion is applied: On Usage Event on proposal.applied, or On Suggestion Decided. */
export function builders(): Array<{ id: string; name: string }> {
  const found = [...usageBuilders('missing-tool'), ...decidedBuilders('missing-tool')];
  return [...new Map(found.map((w) => [w.id, w])).values()];
}

/** Record a suggestion as applied (the editor applies a workflow's ops itself, then calls this). */
export function markApplied(
  proposalOrId: Proposal | string,
  options: { actorId?: string; createdWorkflowId?: string; viaWorkflowId?: string; action?: ProposalAction; note?: string } = {},
  db: Database = database(),
  now = Date.now(),
): Proposal {
  const proposal = typeof proposalOrId === 'string' ? getProposal(proposalOrId, db) : proposalOrId;
  if (!proposal) throw new ProposalError('Suggestion not found', 404);
  if (proposal.status === 'applied') return proposal;
  if (proposal.status !== 'open' && proposal.status !== 'snoozed') throw new ProposalError(`This suggestion is ${proposal.status}`, 409);
  const baseline = baselineFor(proposal, now, db);
  const at = new Date(now).toISOString();
  const next: Proposal = {
    ...proposal,
    status: 'applied',
    appliedAt: at,
    updatedAt: at,
    ...(options.actorId && { appliedBy: options.actorId }),
    ...(options.createdWorkflowId && { createdWorkflowId: options.createdWorkflowId }),
    ...(baseline && { baseline, outcome: 'pending' as const }),
    decision: decisionOf(options.action ?? 'applied', options.actorId, { note: options.note }, now),
    snoozedUntil: undefined,
  };
  save(next, db);
  mirrorDecision(next);
  recordUsage({
    kind: 'proposal.applied',
    ...(proposal.target.type === 'workflow' && proposal.target.id && { workflowId: proposal.target.id }),
    ...(proposal.target.type === 'agent' && proposal.target.id && { agentId: proposal.target.id }),
    ...(options.actorId && { actorId: options.actorId }),
    attrs: { proposal: proposal.id, source: proposal.source, ...(proposal.detector && { detector: proposal.detector }), ...(options.action && { action: options.action.id }) },
  });
  // A declared sub-workflow metric needs a run for its baseline: it starts now and is saved when it is done, so Apply
  // doesn't wait for it (the brain's next look retries a baseline that failed).
  if (unsettled(next)) void settleBaselineOf(next.id, db).catch(() => undefined);
  return next;
}

/** Run a pending (or failed) sub-workflow baseline and save it. Returns the suggestion as saved. */
export async function settleBaselineOf(id: string, db: Database = database()): Promise<Proposal | undefined> {
  const proposal = getProposal(id, db);
  if (!proposal || !unsettled(proposal)) return proposal;
  const baseline = await settleBaseline(proposal);
  if (!baseline) return proposal;
  // Read it again: the person may have acted while the sub-workflow ran.
  const latest = getProposal(id, db) ?? proposal;
  return save({ ...latest, baseline }, db);
}

export function dismissProposal(id: string, reason: DismissReason, options: { note?: string; actorId?: string; viaWorkflowId?: string } = {}, db: Database = database()): Proposal {
  const proposal = getProposal(id, db);
  if (!proposal) throw new ProposalError('Suggestion not found', 404);
  if (proposal.status === 'applied' || proposal.status === 'dismissed') throw new ProposalError(`This suggestion is ${proposal.status}`, 409);
  const at = new Date().toISOString();
  const decision = decisionOf('dismissed', options.actorId, { note: options.note, reason });
  const next: Proposal = { ...proposal, status: 'dismissed', reason, decision, updatedAt: at, snoozedUntil: undefined, ...(options.note && { note: options.note.slice(0, 500) }) };
  save(next, db);
  mirrorDecision(next);
  if (reason === 'intended' && proposal.target.id && (proposal.target.type === 'workflow' || proposal.target.type === 'agent' || proposal.target.type === 'credential' || proposal.target.type === 'entity')) {
    upsertFact(
      {
        id: `${proposal.target.type}:${proposal.target.id}:intended:${proposal.fingerprint}`,
        subjectType: proposal.target.type,
        subjectId: proposal.target.id,
        ...(proposal.target.name && { subjectName: proposal.target.name }),
        kind: 'intended',
        statement: `Intended, not a problem: ${proposal.title}${options.note ? ` (${options.note.slice(0, 200)})` : ''}`,
        evidence: [{ label: 'Dismissed suggestion', value: proposal.title }],
        confidence: 1,
        ...(proposal.projectId && { projectId: proposal.projectId }),
      },
      db,
    );
  }
  recordUsage({
    kind: 'proposal.dismissed',
    ...(proposal.target.type === 'workflow' && proposal.target.id && { workflowId: proposal.target.id }),
    ...(proposal.target.type === 'agent' && proposal.target.id && { agentId: proposal.target.id }),
    ...(options.actorId && { actorId: options.actorId }),
    attrs: { proposal: proposal.id, reason, source: proposal.source, ...(proposal.detector && { detector: proposal.detector }) },
  });
  dispatchDecision(next, decision, options.viaWorkflowId);
  return next;
}

export function snoozeProposal(id: string, days: number, db: Database = database(), options: { actorId?: string; viaWorkflowId?: string } = {}): Proposal {
  const proposal = getProposal(id, db);
  if (!proposal) throw new ProposalError('Suggestion not found', 404);
  if (proposal.status !== 'open' && proposal.status !== 'snoozed') throw new ProposalError(`This suggestion is ${proposal.status}`, 409);
  const until = new Date(Date.now() + Math.max(1, Math.min(90, days)) * DAY_MS).toISOString();
  const decision = decisionOf('snoozed', options.actorId, { note: `${Math.max(1, Math.min(90, days))} days` });
  const next = save({ ...proposal, status: 'snoozed', snoozedUntil: until, decision, updatedAt: new Date().toISOString() }, db);
  mirrorDecision(next);
  dispatchDecision(next, decision, options.viaWorkflowId);
  return next;
}

/** Detector suggestions no detector confirmed for 14 days expire. */
export function expireStale(db: Database = database(), now = Date.now()): number {
  const before = new Date(now - STALE_DAYS * DAY_MS).toISOString();
  const rows = db.all<{ data: string }>("SELECT data FROM proposals WHERE status = 'open' AND source = 'detector' AND updated_at < ?", before);
  for (const row of rows) {
    const p = parse(row.data);
    if (p) save({ ...p, status: 'expired', updatedAt: new Date(now).toISOString() }, db);
  }
  return rows.length;
}

/**
 * Run the effect checks that are due (./effect.ts), settling baselines that still wait for their sub-workflow first.
 * Returns how many suggestions changed.
 */
export async function checkEffects(db: Database = database(), now = Date.now()): Promise<number> {
  let changed = 0;
  for (const row of db.all<{ data: string }>("SELECT data FROM proposals WHERE status = 'applied'")) {
    let p = parse(row.data);
    if (p && unsettled(p)) {
      const settled = await settleBaselineOf(p.id, db);
      if (settled && !unsettled(settled)) {
        p = settled;
        changed++;
      }
    }
    const next = p && (await checkEffectAsync(p, now, db));
    if (next) {
      save(next, db);
      changed++;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Learning from dismissals
// ---------------------------------------------------------------------------

export type { DetectorStat };

/** How a set of a detector's suggestions decides its quiet factor: 5 decided, then the share rejected. */
function statOf(rows: Array<{ status: string; data: string }>): Pick<DetectorStat, 'made' | 'applied' | 'dismissed' | 'quiet'> {
  const applied = rows.filter((r) => r.status === 'applied').length;
  const rejected = rows.filter((r) => r.status === 'dismissed' && ['wrong', 'not-relevant'].includes(parse(r.data)?.reason ?? '')).length;
  const decided = applied + rejected;
  const rate = decided ? rejected / decided : 0;
  const quiet = decided < 5 ? 1 : rate >= 0.8 ? 3 : rate >= 0.6 ? 2 : rate >= 0.4 ? 1.5 : 1;
  return { made: rows.length, applied, dismissed: rejected, quiet };
}

/** One detector's quiet factor (1 = normal). */
export function quietOf(id: DetectorId, db: Database = database()): number {
  return statOf(db.all<{ status: string; data: string }>("SELECT status, data FROM proposals WHERE source = 'detector' AND detector = ?", id)).quiet;
}

/** Every built-in detector, then every flow detector (a workflow with a Detector Trigger, or one that made suggestions). */
export function detectorStats(db: Database = database()): DetectorStat[] {
  const rows = db.all<{ detector: string; status: string; data: string }>("SELECT detector, status, data FROM proposals WHERE source = 'detector'");
  const builtin = DETECTORS.map((id) => ({ id, label: DETECTOR_LABELS[id], ...statOf(rows.filter((r) => r.detector === id)) }));
  const flows = new Map(listFlowDetectors().map((f) => [f.id, f]));
  for (const r of rows) {
    if (!isFlowDetector(r.detector) || flows.has(r.detector)) continue;
    // The workflow is gone or no longer a detector: its record stays, under the name its suggestions carry.
    flows.set(r.detector, { id: r.detector, workflowId: flowDetectorWorkflow(r.detector), name: parse(r.data)?.label ?? 'Flow detector', active: false });
  }
  const flow = [...flows.values()].map((f) => ({ id: f.id, label: f.name, workflowId: f.workflowId, active: f.active, ...statOf(rows.filter((r) => r.detector === f.id)) }));
  return [...builtin, ...flow];
}
