/**
 * The second brain on the instance MCP server (docs/second-brain.md#the-brain-over-mcp): a coding agent asks what Landflow
 * has learned without a hand-built MCP Server Trigger workflow. `brain_search_facts`, `brain_list_suggestions`,
 * `brain_workflow_knowledge`, `brain_usage_report`, `check_overlap` and `brain_suggest`. Registered by instanceServer
 * (./instance-tools.ts), which hands over its access checks.
 *
 * Every tool sees what the caller sees: a user's workflows and agents (scopeForActor), cut down to the project when the
 * server is scoped to one; the instance access token sees everything. `check_overlap` is the one that looks past the
 * walls, and only as the projection of ../brain/similar.ts. `brain_suggest` writes, so it needs edit access to what the
 * suggestion is about, like POST /api/proposals.
 */
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { FACT_KINDS, FACT_SUBJECTS, SIMILAR_KINDS, USAGE_KINDS, isDetectorId, type FactKind, type FactSubject, type ProposalStatus, type UsageGroup, type UsageKind } from '../../shared/brain';
import { agentStore } from '../agents/store';
import { getProfile, listFacts, searchFacts } from '../brain/facts';
import { listProposals, proposeFrom, ProposalError } from '../brain/proposals';
import { canProposal, covers, projectsOf, scopeForActor } from '../brain/scope';
import { findSimilar } from '../brain/similar';
import { vectorFactHits } from '../brain/study';
import { homeProjectId } from '../projects/store';
import type { Actor } from '../projects/access';
import { store } from '../store';
import { usageReport } from '../usage/query';
import type { UsageScope } from '../usage/query';
import type { McpScope } from './project-servers';
import { inScope } from './project-servers';

export interface BrainContext {
  actor?: Actor;
  scope?: McpScope;
  /** The refusal for the workflow and action, or undefined when allowed. */
  denied: (workflowId: string, action: 'read' | 'run') => CallToolResult | undefined;
  json: (value: unknown) => CallToolResult;
  failure: (message: string) => CallToolResult;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const DAY_MS = 86_400_000;

/** What the caller sees of the brain: their access, cut down to the project the server is scoped to. Undefined: everything. */
export function brainScope(actor: Actor | undefined, scope: McpScope | undefined): UsageScope | undefined {
  const own = actor ? scopeForActor(actor) : undefined;
  if (!scope) return own;
  const workflows = new Set(store.listWorkflows().map((w) => w.id).filter((id) => inScope(scope, id) && (!own || own.workflows?.has(id))));
  const agents = new Set(agentStore.list().map((a) => a.id).filter((id) => homeProjectId('agent', id) === scope.projectId && (!own || own.agents?.has(id))));
  return { workflows, agents, teams: new Set() };
}

export function registerBrainTools(server: McpServer, ctx: BrainContext) {
  const { actor, json, failure } = ctx;
  const scope = brainScope(actor, ctx.scope);

  server.registerTool(
    'brain_search_facts',
    {
      title: 'Search what the brain learned',
      description: 'Facts the second brain learned about workflows and agents you can open (purpose, health, cost, failures, dependencies…), best match first: keywords, and meaning when embeddings are on.',
      inputSchema: z.object({
        query: z.string().min(1).describe('What to look for, in words'),
        subjectType: z.enum(FACT_SUBJECTS).optional(),
        kind: z.enum(FACT_KINDS).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, subjectType, kind, limit }) => {
      const vectorHits = await vectorFactHits(query, projectsOf(scope));
      const facts = searchFacts(query, { scope, limit: 500, vectorHits }).filter((f) => (!subjectType || f.subjectType === (subjectType as FactSubject)) && (!kind || f.kind === (kind as FactKind)));
      return json({ facts: facts.slice(0, limit ?? 20) });
    },
  );

  server.registerTool(
    'brain_list_suggestions',
    {
      title: 'List the brain’s suggestions',
      description: 'The Suggestions inbox for what you can open, highest score first. Filter by status (default open), workflow, or the detector that made it (a built-in id such as failure-hotspot, or flow:<workflowId>).',
      inputSchema: z.object({
        status: z.enum(['open', 'applied', 'dismissed', 'snoozed', 'expired', 'all']).optional(),
        workflowId: z.string().optional(),
        detector: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      }),
      annotations: READ_ONLY,
    },
    async ({ status, workflowId, detector, limit }) => {
      if (workflowId && !covers(scope, { workflowId })) return failure(`Workflow ${workflowId} not found`);
      if (detector && !isDetectorId(detector)) return failure(`Unknown detector ${detector}`);
      const list = listProposals({ status: (status ?? 'open') as ProposalStatus | 'all', workflowId, ...(detector && isDetectorId(detector) && { detector }), scope, limit: limit ?? 50 });
      return json({ proposals: list.filter((p) => !actor || canProposal(actor, p, 'read')) });
    },
  );

  server.registerTool(
    'brain_workflow_knowledge',
    {
      title: 'What the brain knows about a workflow',
      description: 'A workflow’s profile (purpose, runs, failure rate, cost, what it depends on), the facts about it and its open suggestions.',
      inputSchema: z.object({ workflowId: z.string() }),
      annotations: READ_ONLY,
    },
    async ({ workflowId }) => {
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) return failure(`Workflow ${workflowId} not found`);
      const refused = ctx.denied(workflowId, 'read');
      if (refused) return refused;
      return json({
        workflowId,
        name: workflow.name,
        profile: getProfile('workflow', workflowId) ?? null,
        facts: listFacts({ subjectType: 'workflow', subjectId: workflowId, limit: 50 }),
        proposals: listProposals({ workflowId, status: 'open', limit: 20 }),
      });
    },
  );

  server.registerTool(
    'brain_usage_report',
    {
      title: 'Usage report',
      description: 'Counts, failures, durations, tokens and cost of the workflows and agents you can open over the last days, grouped by day, kind, workflow, nodeType, signature, agent or model.',
      inputSchema: z.object({
        groupBy: z.enum(['day', 'kind', 'workflow', 'nodeType', 'signature', 'agent', 'model']).optional().describe('Default workflow'),
        kinds: z.array(z.enum(USAGE_KINDS)).optional().describe('Event kinds, e.g. node.failed, ai.call; empty: all'),
        days: z.number().int().min(1).max(400).optional().describe('Default 7'),
        workflowId: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
      }),
      annotations: READ_ONLY,
    },
    async ({ groupBy, kinds, days, workflowId, limit }) => {
      if (workflowId && !covers(scope, { workflowId })) return failure(`Workflow ${workflowId} not found`);
      const group = (groupBy ?? 'workflow') as UsageGroup;
      const from = new Date(Date.now() - (days ?? 7) * DAY_MS).toISOString();
      const labels = (g: UsageGroup, key: string) => (g === 'workflow' ? store.getWorkflow(key)?.name : g === 'agent' ? agentStore.get(key)?.name : undefined);
      return json(usageReport({ kinds: (kinds ?? []) as UsageKind[], from, workflowId }, group, { scope, limit: limit ?? 50, labels }));
    },
  );

  server.registerTool(
    'check_overlap',
    {
      title: 'Is anyone already doing this?',
      description:
        'Describe what you are about to build (a title and a goal) and get the nearest workflows, agents and facts, best first. Matches in projects you can open carry their id and detail ("yours": true). Matches in projects you can\'t open (when includeOthers, the default) carry only type, title, owner, goal, project and score, so you can ask the owner instead of building a duplicate.',
      inputSchema: z.object({
        text: z.string().min(1).describe('A title and a goal, e.g. "Remind customers of unpaid invoices"'),
        what: z.array(z.enum(SIMILAR_KINDS)).optional().describe('workflow, agent, fact; default all'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 10'),
        minScore: z.number().min(0).max(1).optional().describe('Default 0.15'),
        includeOthers: z.boolean().optional().describe('Also lookalikes in projects you can\'t open, as projections (default true)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ text, what, limit, minScore, includeOthers }) => json({ matches: await findSimilar(text, { scope, kinds: what, limit, minScore, includeOthers: includeOthers ?? true }) }),
  );

  server.registerTool(
    'brain_suggest',
    {
      title: 'Post a suggestion',
      description:
        'Put a suggestion in the Suggestions inbox (source analyst): a change to a workflow (ops, checked against it), advice, or a note about an agent. Needs edit access to the workflow or agent it is about. Nothing changes until a person applies it.',
      inputSchema: z.object({
        title: z.string().min(1).max(160),
        why: z.string().min(1).max(2000).describe('The reason and the evidence people see'),
        workflowId: z.string().optional(),
        agentId: z.string().optional(),
        nodeName: z.string().optional(),
        label: z.string().max(80).optional(),
        effect: z.string().max(300).optional(),
        ops: z.array(z.unknown()).max(50).optional().describe('Edit operations on the workflow (addNode, setParameters, connect, setNodeSettings…)'),
        risk: z.enum(['low', 'medium', 'high']).optional(),
        confidence: z.number().min(0).max(1).optional(),
        fingerprint: z.string().max(64).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      if (input.workflowId && !store.getWorkflow(input.workflowId)) return failure(`Workflow ${input.workflowId} not found`);
      if (input.agentId && !agentStore.get(input.agentId)) return failure(`Agent ${input.agentId} not found`);
      // A server scoped to a project only suggests about what is in it, and not about the instance.
      if (ctx.scope && !covers(scope, input.workflowId ? { workflowId: input.workflowId } : { agentId: input.agentId })) return failure(input.workflowId || input.agentId ? 'Not found in this project' : 'This server is scoped to a project: say which workflow or agent the suggestion is about');
      const target = input.workflowId ? { type: 'workflow' as const, id: input.workflowId } : input.agentId ? { type: 'agent' as const, id: input.agentId } : { type: 'instance' as const };
      if (actor && !canProposal(actor, { target }, 'update')) return failure(target.type === 'workflow' ? `Workflow ${input.workflowId} not found` : 'You can’t make suggestions about this');
      try {
        const proposal = proposeFrom(input as Parameters<typeof proposeFrom>[0], 'analyst');
        return json(proposal ? { saved: true, proposal } : { saved: false, reason: 'held back: the same advice is already open for this node, it was dismissed or applied recently, or the weekly cap is full' });
      } catch (caught) {
        if (caught instanceof ProposalError) return failure(caught.message);
        throw caught;
      }
    },
  );
}
