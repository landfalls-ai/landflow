/**
 * The nightly study (docs/second-brain.md#2-memory-profiles-and-facts): a profile of every workflow, agent, node type and
 * credential, built from the ledger and the definitions, and the facts that follow from it. Facts the study no longer
 * confirms go stale.
 *
 * A workflow's purpose is one sentence from the model, written once per version (its `updatedAt`), at most
 * STUDY_PURPOSES per study; without a model it is described from its trigger and steps. Everything else is counted.
 *
 * The facts are then embedded (LANDFLOW_BRAIN_EMBEDDINGS, an Ollama embeddings model, default nomic-embed-text; `off`
 * skips it) into the SQLite vector store: `landflow-brain-<project id>` per project and `landflow-brain` for the
 * instance's own, so a vector store node or an agent's knowledge base can search them too.
 */
import type { LanguageModel, Workflow } from '@landflow/engine';
import { ENTITY_LABELS, type BrainFact, type BrainProfile, type FactKind, type FactSubject, type ProfileStats, type ProposalEvidence } from '../../shared/brain';
import { agentStore } from '../agents/store';
import { agentTeamStore } from '../agent-teams/store';
import { workflowOutline } from '../assistant/research';
import { credentials } from '../credentials/vault';
import { database, type Database, type SqlValue } from '../db';
import { homeProjectId } from '../projects/store';
import { ollamaEmbeddings } from '../rag/embeddings';
import { SqliteVectorStore } from '../rag/stores';
import { registry } from '../plugins/registry';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { percentile } from '../usage/query';
import { EXECUTE_WORKFLOW } from './detectors';
import { entityKey, entityProject, listEntities, MANUAL_FACT } from './entities';
import { getProfile, listFacts, saveProfile, staleFactsBefore, upsertFact } from './facts';
import { brainModel } from './writer';
import { ollamaUrl } from '../config';

const DAY_MS = 86_400_000;
const PRODUCTION = "COALESCE(json_extract(attrs, '$.mode'), '') <> 'manual'";
const STUDY_PURPOSES = 20;
const MESSAGE_AGENT = 'core.messageAgent';
const RUN_TEAM = 'core.runTeam';
export const BRAIN_COLLECTION = 'landflow-brain';

const iso = (ms: number) => new Date(ms).toISOString();
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const money = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

export const collectionFor = (projectId?: string) => (projectId ? `${BRAIN_COLLECTION}-${projectId}` : BRAIN_COLLECTION);

function num(db: Database, sql: string, ...params: SqlValue[]): number {
  return Number(db.get<{ n: number | null }>(sql, ...params)?.n ?? 0);
}

function statsFor(db: Database, column: 'workflow_id' | 'agent_id', id: string, now: number): ProfileStats {
  const window = (from: number, to: number) => {
    const span = [iso(from), iso(to), id] as SqlValue[];
    const runs = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE at >= ? AND at < ? AND ${column} = ? AND kind = '${column === 'agent_id' ? 'agent.session' : 'run.finished'}' AND ${PRODUCTION}`, ...span);
    const failures = num(
      db,
      `SELECT COUNT(*) AS n FROM usage_events WHERE at >= ? AND at < ? AND ${column} = ? AND ${
        column === 'agent_id' ? "kind = 'agent.session' AND json_extract(attrs, '$.reason') = 'error'" : `kind = 'run.finished' AND ${PRODUCTION} AND json_extract(attrs, '$.status') = 'error'`
      }`,
      ...span,
    );
    const p95Ms = column === 'workflow_id' ? percentile(`at >= ? AND at < ? AND workflow_id = ? AND kind = 'run.finished' AND ${PRODUCTION}`, span, 0.95, db) : 0;
    const cost = num(db, `SELECT COALESCE(SUM(cost), 0) AS n FROM usage_events WHERE at >= ? AND at < ? AND ${column} = ? AND kind = 'ai.call'`, ...span);
    return { runs, failures, failureRate: runs ? failures / runs : 0, p95Ms, cost };
  };
  const current = window(now - 7 * DAY_MS, now);
  const previous = window(now - 14 * DAY_MS, now - 7 * DAY_MS);
  const span = [iso(now - 7 * DAY_MS), id] as SqlValue[];
  return {
    ...current,
    manualRuns: column === 'workflow_id' ? num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE at >= ? AND workflow_id = ? AND kind = 'run.finished' AND json_extract(attrs, '$.mode') = 'manual'`, ...span) : 0,
    tokens: num(db, `SELECT COALESCE(SUM(tokens), 0) AS n FROM usage_events WHERE at >= ? AND ${column} = ? AND kind = 'ai.call'`, ...span),
    previous: { runs: previous.runs, failureRate: previous.failureRate, p95Ms: previous.p95Ms, cost: previous.cost },
    ...(() => {
      const last = db.get<{ at: string | null }>(`SELECT MAX(at) AS at FROM usage_events WHERE ${column} = ? AND kind = '${column === 'agent_id' ? 'agent.session' : 'run.finished'}'`, id)?.at;
      return last ? { lastRunAt: last } : {};
    })(),
  };
}

/** Its trigger and steps in words, when there is no model to say what it is for. */
export function describeWorkflow(workflow: Workflow): string {
  const types = new Map(registry.nodeTypes().map((t) => [t.type, t.descriptor.displayName]));
  const label = (type: string) => types.get(type) ?? type.split('.').pop() ?? type;
  const triggers = workflow.nodes.filter((n) => /trigger|schedule|webhook|chat/i.test(n.type) && !workflow.connections.some((c) => c.target === n.id && c.type === 'main'));
  const steps = [...new Set(workflow.nodes.filter((n) => !triggers.includes(n)).map((n) => label(n.type)))].slice(0, 6);
  const start = triggers.length ? `Starts from ${[...new Set(triggers.map((t) => label(t.type)))].join(' or ')}` : 'Runs when called';
  return `${start}${steps.length ? ` and uses ${steps.join(', ')}` : ''}.`;
}

function usesOf(workflow: Workflow): BrainProfile['uses'] {
  const uses: BrainProfile['uses'] = [];
  const seen = new Set<string>();
  const add = (type: FactSubject, id: string, name?: string) => {
    if (!id || seen.has(`${type}:${id}`)) return;
    seen.add(`${type}:${id}`);
    uses.push({ type, id, ...(name && { name }) });
  };
  for (const node of workflow.nodes) {
    add('nodeType', node.type);
    for (const ref of Object.values(node.credentials ?? {})) add('credential', ref.id, ref.name);
    if (node.type === EXECUTE_WORKFLOW && typeof node.parameters?.workflowId === 'string') add('workflow', node.parameters.workflowId, store.getWorkflow(node.parameters.workflowId)?.name);
    if (node.type === MESSAGE_AGENT && typeof node.parameters?.agentId === 'string') add('agent', node.parameters.agentId, agentStore.get(node.parameters.agentId)?.name);
    // A team's Landflow agents, from the version the flow runs (published, or the draft it tries).
    if (node.type === RUN_TEAM && typeof node.parameters?.teamId === 'string') {
      const team = agentTeamStore.get(node.parameters.teamId);
      const config = node.parameters.version === 'draft' ? team?.draft : (team?.published ?? team?.draft);
      for (const member of config?.members ?? []) if (member.kind === 'agent') add('agent', member.agentId, agentStore.get(member.agentId)?.name);
    }
  }
  return uses;
}

async function purposeOf(workflow: Workflow, model: LanguageModel | undefined, budget: { left: number }): Promise<string> {
  const version = workflow.updatedAt ?? '';
  const known = getProfile('workflow', workflow.id);
  if (known?.purpose && known.version === version) return known.purpose;
  if (model && budget.left > 0) {
    budget.left--;
    try {
      const turn = await model.generate({
        system: 'You describe automation workflows in one plain sentence (at most 25 words) that says what it is for. No preamble.',
        messages: [{ role: 'user', content: workflowOutline(workflow) }],
        tools: [],
      });
      const sentence = (turn.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (sentence) return sentence;
    } catch (error) {
      logger.warn('the brain could not describe a workflow', { error, 'landflow.workflow.id': workflow.id });
    }
  }
  return describeWorkflow(workflow);
}

function trend(now: number, before: number, format: (n: number) => string): string {
  if (!before && !now) return '';
  if (!before) return ', new this week';
  const change = (now - before) / before;
  if (Math.abs(change) < 0.1) return `, about the same as the week before`;
  return `, ${change > 0 ? 'up' : 'down'} from ${format(before)}`;
}

type Fact = Omit<BrainFact, 'id' | 'firstSeen' | 'lastSeen' | 'status'>;

function workflowFacts(db: Database, workflow: Workflow, profile: BrainProfile, now: number): Fact[] {
  const s = profile.stats;
  const subject = { subjectType: 'workflow' as const, subjectId: workflow.id, subjectName: workflow.name, ...(profile.projectId && { projectId: profile.projectId }) };
  const href = `/workflows/${workflow.id}`;
  const facts: Fact[] = [];
  const fact = (kind: FactKind, statement: string, confidence: number, evidence: ProposalEvidence[] = []) => facts.push({ ...subject, kind, statement, confidence, evidence });
  if (profile.purpose) fact('purpose', profile.purpose, 0.7, [{ label: 'Workflow', value: workflow.name, href }]);
  if (s.runs || s.manualRuns) {
    fact('usage', `Ran ${s.runs} times in production this week${s.manualRuns ? ` and ${s.manualRuns} times by hand` : ''}${trend(s.runs, s.previous?.runs ?? 0, String)}${s.lastRunAt ? `; last run ${s.lastRunAt.slice(0, 10)}` : ''}.`, 0.9, [
      { label: 'Production runs (7 days)', value: s.runs },
      { label: 'Runs by hand (7 days)', value: s.manualRuns },
    ]);
  }
  if (s.runs >= 3) {
    fact('health', `Fails ${pct(s.failureRate)} of production runs${trend(s.failureRate, s.previous?.failureRate ?? 0, pct)}${s.p95Ms ? `; p95 run time ${(s.p95Ms / 1000).toFixed(1)} s` : ''}.`, Math.min(0.95, 0.5 + s.runs / 50), [
      { label: 'Failed runs (7 days)', value: s.failures },
      { label: 'Production runs (7 days)', value: s.runs },
    ]);
  }
  if (s.cost > 0 || s.tokens > 0) fact('cost', `Used ${s.tokens.toLocaleString('en-US')} tokens in AI calls this week${s.cost > 0 ? `, about ${money(s.cost)}` : ''}${trend(s.cost, s.previous?.cost ?? 0, money)}.`, 0.9);
  const since = iso(now - 7 * DAY_MS);
  const failure = db.get<{ node_id: string; message: string | null; n: number }>(
    `SELECT node_id, MAX(message) AS message, COUNT(*) AS n FROM usage_events WHERE kind = 'node.failed' AND workflow_id = ? AND at >= ? GROUP BY node_id, signature ORDER BY n DESC LIMIT 1`,
    workflow.id,
    since,
  );
  if (failure && failure.n >= 2) {
    const node = workflow.nodes.find((n) => n.id === failure.node_id);
    fact('failure', `Most common failure: “${failure.message ?? 'an error'}” on “${node?.name ?? failure.node_id}”, ${failure.n} times this week.`, 0.85, [{ label: 'Failures', value: failure.n, href: `${href}/executions` }]);
  }
  const slow = db.get<{ node_id: string; n: number }>(`SELECT node_id, COUNT(*) AS n FROM usage_events WHERE kind = 'node.slow' AND workflow_id = ? AND at >= ? GROUP BY node_id ORDER BY n DESC LIMIT 1`, workflow.id, since);
  if (slow && slow.n >= 2) {
    const node = workflow.nodes.find((n) => n.id === slow.node_id);
    const p95 = percentile(`kind = 'node.slow' AND workflow_id = ? AND node_id = ? AND at >= ?`, [workflow.id, slow.node_id, since], 0.95, db);
    fact('slow', `Slowest step: “${node?.name ?? slow.node_id}”, ${(p95 / 1000).toFixed(1)} s at p95 over ${slow.n} slow runs this week.`, 0.8);
  }
  const saves = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'workflow.saved' AND workflow_id = ? AND at >= ?`, workflow.id, since);
  const publishes = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'workflow.published' AND workflow_id = ? AND at >= ?`, workflow.id, since);
  if (saves || publishes) fact('change', `Edited ${saves} time${saves === 1 ? '' : 's'} this week${publishes ? ` and published ${publishes} time${publishes === 1 ? '' : 's'}` : ''}.`, 0.9);
  const deps = profile.uses.filter((u) => u.type !== 'nodeType');
  if (deps.length) {
    const named = (type: FactSubject) => deps.filter((d) => d.type === type).map((d) => `“${d.name ?? d.id}”`);
    const parts = [named('credential').length && `credentials ${named('credential').join(', ')}`, named('workflow').length && `sub-workflows ${named('workflow').join(', ')}`, named('agent').length && `agents ${named('agent').join(', ')}`].filter(Boolean);
    fact('dependency', `Depends on ${parts.join('; ')}.`, 1);
  }
  return facts;
}

async function studyWorkflows(db: Database, now: number, model: LanguageModel | undefined) {
  const budget = { left: STUDY_PURPOSES };
  let count = 0;
  for (const workflow of store.listWorkflows()) {
    const projectId = homeProjectId('workflow', workflow.id);
    const profile: BrainProfile = {
      subjectType: 'workflow',
      subjectId: workflow.id,
      name: workflow.name,
      ...(projectId && { projectId }),
      version: workflow.updatedAt ?? '',
      purpose: await purposeOf(workflow, model, budget),
      stats: statsFor(db, 'workflow_id', workflow.id, now),
      uses: usesOf(workflow),
      updatedAt: iso(now),
    };
    saveProfile(profile, db);
    for (const fact of workflowFacts(db, workflow, profile, now)) upsertFact(fact, db, iso(now));
    count++;
  }
  return count;
}

function studyAgents(db: Database, now: number) {
  let count = 0;
  for (const agent of agentStore.list()) {
    const projectId = homeProjectId('agent', agent.id);
    const stats = statsFor(db, 'agent_id', agent.id, now);
    const since = iso(now - 7 * DAY_MS);
    const ratings = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'feedback' AND agent_id = ? AND at >= ?`, agent.id, since);
    const down = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'feedback' AND agent_id = ? AND at >= ? AND json_extract(attrs, '$.rating') = 'down'`, agent.id, since);
    const purpose = agent.persona?.mission ?? agent.description ?? agent.persona?.role;
    const profile: BrainProfile = {
      subjectType: 'agent',
      subjectId: agent.id,
      name: agent.name,
      ...(projectId && { projectId }),
      version: String(agent.published?.version ?? 'draft'),
      ...(purpose && { purpose }),
      stats,
      uses: (agent.tools ?? []).flatMap((t): BrainProfile['uses'] =>
        t.type === 'workflow' ? [{ type: 'workflow', id: t.workflowId, name: t.name }] : t.type === 'agent' ? [{ type: 'agent', id: t.agentId }] : t.type === 'node' ? [{ type: 'nodeType', id: t.nodeType }] : [],
      ),
      updatedAt: iso(now),
    };
    saveProfile(profile, db);
    const subject = { subjectType: 'agent' as const, subjectId: agent.id, subjectName: agent.name, ...(projectId && { projectId }) };
    if (purpose) upsertFact({ ...subject, kind: 'purpose', statement: purpose, confidence: 0.8, evidence: [] }, db, iso(now));
    if (stats.runs) upsertFact({ ...subject, kind: 'usage', statement: `Had ${stats.runs} sessions this week${trend(stats.runs, stats.previous?.runs ?? 0, String)}${stats.failures ? `; ${stats.failures} ended in an error` : ''}.`, confidence: 0.9, evidence: [] }, db, iso(now));
    if (ratings) upsertFact({ ...subject, kind: 'quality', statement: `${down} of ${ratings} ratings this week were thumbs down.`, confidence: Math.min(0.95, 0.5 + ratings / 20), evidence: [{ label: 'Ratings', value: ratings }] }, db, iso(now));
    if (stats.cost > 0 || stats.tokens > 0) upsertFact({ ...subject, kind: 'cost', statement: `Used ${stats.tokens.toLocaleString('en-US')} tokens this week${stats.cost > 0 ? `, about ${money(stats.cost)}` : ''}.`, confidence: 0.9, evidence: [] }, db, iso(now));
    count++;
  }
  return count;
}

function studyNodeTypesAndCredentials(db: Database, now: number) {
  const since = iso(now - 7 * DAY_MS);
  const workflows = store.listWorkflows();
  const usedIn = new Map<string, Set<string>>();
  const credentialUse = new Map<string, Set<string>>();
  for (const w of workflows) {
    for (const n of w.nodes) {
      usedIn.set(n.type, (usedIn.get(n.type) ?? new Set()).add(w.id));
      for (const ref of Object.values(n.credentials ?? {})) credentialUse.set(ref.id, (credentialUse.get(ref.id) ?? new Set()).add(w.id));
    }
  }
  const failing = db.all<{ node_type: string; n: number; workflows: number; message: string | null }>(
    `SELECT node_type, COUNT(*) AS n, COUNT(DISTINCT workflow_id) AS workflows, MAX(message) AS message FROM usage_events WHERE kind = 'node.failed' AND at >= ? AND node_type IS NOT NULL GROUP BY node_type`,
    since,
  );
  const types = new Map(registry.nodeTypes().map((t) => [t.type, t.descriptor.displayName]));
  let count = 0;
  for (const [type, ids] of usedIn) {
    const fail = failing.find((f) => f.node_type === type);
    if (ids.size < 3 && !fail) continue;
    const name = types.get(type) ?? type;
    saveProfile(
      {
        subjectType: 'nodeType',
        subjectId: type,
        name,
        stats: { runs: 0, failures: fail?.n ?? 0, failureRate: 0, manualRuns: 0, p95Ms: 0, tokens: 0, cost: 0 },
        uses: [...ids].map((id) => ({ type: 'workflow' as const, id, name: store.getWorkflow(id)?.name })),
        updatedAt: iso(now),
      },
      db,
    );
    upsertFact(
      {
        subjectType: 'nodeType',
        subjectId: type,
        subjectName: name,
        kind: fail ? 'failure' : 'usage',
        statement: `Used in ${ids.size} workflow${ids.size === 1 ? '' : 's'}${fail ? `; failed ${fail.n} times this week in ${fail.workflows} of them (for example “${fail.message ?? 'an error'}”)` : ''}.`,
        confidence: 0.85,
        evidence: [],
      },
      db,
      iso(now),
    );
    count++;
  }
  for (const credential of credentials.list()) {
    const ids = credentialUse.get(credential.id) ?? new Set<string>();
    const last = db.get<{ at: string | null }>("SELECT MAX(at) AS at FROM usage_events WHERE kind = 'credential.used' AND json_extract(attrs, '$.credentialId') = ?", credential.id)?.at;
    saveProfile(
      {
        subjectType: 'credential',
        subjectId: credential.id,
        name: credential.name,
        stats: { runs: 0, failures: 0, failureRate: 0, manualRuns: 0, p95Ms: 0, tokens: 0, cost: 0, ...(last && { lastRunAt: last }) },
        uses: [...ids].map((id) => ({ type: 'workflow' as const, id, name: store.getWorkflow(id)?.name })),
        updatedAt: iso(now),
      },
      db,
    );
    upsertFact(
      {
        subjectType: 'credential',
        subjectId: credential.id,
        subjectName: credential.name,
        kind: 'dependency',
        statement: `${ids.size ? `Used by ${ids.size} workflow${ids.size === 1 ? '' : 's'} (${[...ids].slice(0, 5).map((id) => `“${store.getWorkflow(id)?.name ?? id}”`).join(', ')})` : 'Used by no workflow'}${last ? `; last used in a run on ${last.slice(0, 10)}` : ''}.`,
        confidence: 1,
        evidence: [],
      },
      db,
      iso(now),
    );
    count++;
  }
  return count;
}

/**
 * A profile and facts for every entity (docs/second-brain.md#entities), written from what is on file: no model needed.
 * The purpose is its description (or a sentence from its type, owner and attributes); a `usage` fact counts the statements
 * people and flows added. Those statements themselves are kept as they are (entities.ts addEntityFact).
 */
function studyEntities(db: Database, now: number) {
  let count = 0;
  for (const entity of listEntities({}, db)) {
    const ref = entityKey(entity);
    const projectId = entityProject(entity);
    const attrs = Object.entries(entity.attrs).map(([k, v]) => `${k}: ${v}`);
    const label = ENTITY_LABELS[entity.type].toLowerCase();
    const purpose = entity.description || `${ENTITY_LABELS[entity.type]} “${entity.name}”${entity.ownerName ? `, owned by ${entity.ownerName}` : ''}.`;
    const noted = listFacts({ subjectType: 'entity', subjectId: ref, limit: 5_000 }, db).filter((f) => f.id.includes(`:${MANUAL_FACT}`));
    saveProfile(
      {
        subjectType: 'entity',
        subjectId: ref,
        name: entity.name,
        ...(projectId && { projectId }),
        version: entity.updatedAt,
        purpose,
        stats: { runs: 0, failures: 0, failureRate: 0, manualRuns: 0, p95Ms: 0, tokens: 0, cost: 0 },
        uses: [],
        updatedAt: iso(now),
      },
      db,
    );
    const subject = { subjectType: 'entity' as const, subjectId: ref, subjectName: entity.name, ...(projectId && { projectId }) };
    const about = [`${label} “${entity.name}”`, entity.ownerName && `owned by ${entity.ownerName}`, entity.description, attrs.length && `(${attrs.join('; ')})`].filter(Boolean).join(' ');
    upsertFact({ ...subject, kind: 'purpose', statement: about.endsWith('.') ? about : `${about}.`, confidence: 0.9, evidence: [] }, db, iso(now));
    if (noted.length) upsertFact({ ...subject, kind: 'usage', statement: `${noted.length} statement${noted.length === 1 ? '' : 's'} on file about this ${label}.`, confidence: 1, evidence: [] }, db, iso(now));
    count++;
  }
  return count;
}

function studyInstance(db: Database, now: number) {
  const since = iso(now - 7 * DAY_MS);
  const runs = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'run.finished' AND at >= ? AND ${PRODUCTION}`, since);
  const failed = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'run.finished' AND at >= ? AND ${PRODUCTION} AND json_extract(attrs, '$.status') = 'error'`, since);
  const manual = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'run.finished' AND at >= ? AND json_extract(attrs, '$.mode') = 'manual'`, since);
  const cost = num(db, `SELECT COALESCE(SUM(cost), 0) AS n FROM usage_events WHERE kind = 'ai.call' AND at >= ?`, since);
  const asks = num(db, `SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'spotlight.asked' AND at >= ?`, since);
  upsertFact(
    {
      subjectType: 'instance',
      subjectId: 'instance',
      subjectName: 'This Landflow',
      kind: 'usage',
      statement: `This week: ${runs} production runs (${runs ? pct(failed / runs) : '0%'} failed), ${manual} runs by hand, ${money(cost)} in AI calls, ${asks} requests to Spotlight.`,
      confidence: 1,
      evidence: [],
    },
    db,
    iso(now),
  );
}

/** Embed the active facts, one collection per project. Returns how many were embedded (0 when embeddings are off or fail). */
export async function embedFacts(db: Database = database()): Promise<number> {
  const model = process.env.LANDFLOW_BRAIN_EMBEDDINGS?.trim();
  if (model?.toLowerCase() === 'off') return 0;
  const embeddings = ollamaEmbeddings({ baseUrl: ollamaUrl(), model: model || 'nomic-embed-text', documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
  const facts = listFacts({ limit: 5_000 }, db);
  const groups = new Map<string, BrainFact[]>();
  for (const fact of facts) groups.set(collectionFor(fact.projectId), [...(groups.get(collectionFor(fact.projectId)) ?? []), fact]);
  const vectors = new SqliteVectorStore();
  let embedded = 0;
  try {
    for (const name of (await vectors.collections()).map((c) => c.name).filter((n) => n === BRAIN_COLLECTION || n.startsWith(`${BRAIN_COLLECTION}-`))) {
      if (!groups.has(name)) await vectors.clear(name);
    }
    for (const [collection, list] of groups) {
      const texts = list.map((f) => `${f.subjectName ?? f.subjectId}: ${f.statement}`);
      const embedded_ = await embeddings.embedDocuments(texts);
      await vectors.clear(collection);
      await vectors.add(
        collection,
        list.map((f, i) => ({ id: f.id, pageContent: texts[i], metadata: { factId: f.id, subjectType: f.subjectType, subjectId: f.subjectId, kind: f.kind }, embedding: embedded_[i] })),
      );
      embedded += list.length;
    }
  } catch (error) {
    logger.warn('the brain could not embed its facts; search uses keywords only', { error });
  }
  return embedded;
}

/** Fact ids from a vector search of the collections `projects` may read (undefined: all of them). */
export async function vectorFactHits(query: string, projects: Set<string> | undefined, limit = 20): Promise<string[]> {
  return (await vectorFactScores(query, projects, limit)).map((hit) => hit.factId);
}

/** The facts nearest to a query with their cosine similarity (0..1), best first; [] with embeddings off or on failure. */
export async function vectorFactScores(query: string, projects: Set<string> | undefined, limit = 20): Promise<Array<{ factId: string; similarity: number }>> {
  const model = process.env.LANDFLOW_BRAIN_EMBEDDINGS?.trim();
  if (model?.toLowerCase() === 'off' || !query.trim()) return [];
  try {
    const vectors = new SqliteVectorStore();
    const names = (await vectors.collections()).map((c) => c.name).filter((n) => n === BRAIN_COLLECTION || n.startsWith(`${BRAIN_COLLECTION}-`));
    const readable = names.filter((n) => !projects || (n !== BRAIN_COLLECTION && projects.has(n.slice(BRAIN_COLLECTION.length + 1))));
    if (!readable.length) return [];
    const embeddings = ollamaEmbeddings({ baseUrl: ollamaUrl(), model: model || 'nomic-embed-text', documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
    const vector = await embeddings.embedQuery(query, AbortSignal.timeout(10_000));
    const hits = (await Promise.all(readable.map((n) => vectors.similaritySearch(n, vector, limit)))).flat();
    return hits
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      .map((d) => ({ factId: String(d.metadata?.factId ?? ''), similarity: Number(d.score ?? 0) }))
      .filter((hit) => hit.factId)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export interface StudyResult {
  workflows: number;
  agents: number;
  others: number;
  entities: number;
  stale: number;
  embedded: number;
  durationMs: number;
}

/** Study everything (see the module comment). */
export async function study(options: { model?: LanguageModel; db?: Database; now?: number; embed?: boolean } = {}): Promise<StudyResult> {
  const db = options.db ?? database();
  const now = options.now ?? Date.now();
  const started = Date.now();
  const model = brainModel(options.model);
  const workflows = await studyWorkflows(db, now, model);
  const agents = studyAgents(db, now);
  const others = studyNodeTypesAndCredentials(db, now);
  const entities = studyEntities(db, now);
  studyInstance(db, now);
  const stale = staleFactsBefore(iso(now), db);
  const embedded = options.embed === false ? 0 : await embedFacts(db);
  return { workflows, agents, others, entities, stale, embedded, durationMs: Date.now() - started };
}
