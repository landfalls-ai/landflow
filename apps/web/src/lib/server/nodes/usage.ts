/**
 * The second brain's nodes (docs/second-brain.md#6-your-own-conclusions): read the usage ledger and what the brain knows
 * (Landflow Usage), start a workflow when something happens (On Usage Event), make a workflow a detector the brain runs
 * (Detector Trigger, docs/second-brain.md#flow-detectors), and post a suggestion to the inbox next to the built-in ones
 * (Suggest Improvement). Landflow Usage and Suggest Improvement are tools too, which is how the Platform analyst agent uses them.
 *
 * A workflow sees the usage its creator could see (lib/server/brain/scope.ts).
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { customKindProblem, DETECTOR_LABELS, DETECTORS, detectorLabel, flowDetectorId, isUsageKind, parseAttrEquals, quietBar, SIMILAR_KINDS, USAGE_KINDS, type SimilarKind, type UsageGroup, type UsageKind } from '../../shared/brain';
import { agentStore as agents } from '../agents/store';
import { listKinds } from '../usage/kinds';
import { store } from '../store';

const main = [{ type: 'main' as const }];
const DAY_MS = 86_400_000;
const kindOptions = USAGE_KINDS.map((kind) => ({ name: kind, value: kind }));
/** Landflow's own kinds, then the custom kinds flows declared (Record Event). */
const anyKind = () => [...kindOptions, ...listKinds().map((k) => ({ name: k.kind, value: k.kind, ...(k.description && { description: k.description }) }))];
/** Only the declared custom kinds, for Record Event. */
const declaredKind = () => listKinds().map((k) => ({ name: k.kind, value: k.kind, ...(k.description && { description: k.description }) }));
const anyAgent = () => [{ name: 'None', value: '' }, ...agents.list().map((a) => ({ name: a.name, value: a.id })).sort((a, b) => a.name.localeCompare(b.name))];
const anyWorkflow = () => [{ name: 'Any workflow', value: '' }, ...store.listWorkflows().map((w) => ({ name: w.name, value: w.id })).sort((a, b) => a.name.localeCompare(b.name))];

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonObject;

/** The built-in detectors, then the flow detectors, for "Suggestion From". */
const anyDetector = async () => {
  const { listFlowDetectors } = await import('../brain/flow-detectors');
  return [
    { name: 'Any detector', value: '' },
    ...DETECTORS.map((id) => ({ name: DETECTOR_LABELS[id], value: id })),
    ...listFlowDetectors().map((f) => ({ name: `${f.name} (flow)`, value: f.id })),
  ];
};

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : typeof value === 'string' && value.trim() ? value.split(',').map((v) => v.trim()).filter(Boolean) : []);

export const landflowUsageNode = defineNode({
  description: {
    name: 'landflowUsage',
    displayName: 'Landflow Usage',
    description: 'Read how the platform is used: runs, failures, AI costs and edits, what the second brain knows, and its suggestions',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:brain',
    color: '#8b5cf6',
    subtitle: '{{operation}}',
    keywords: ['usage', 'analytics', 'second brain', 'insights', 'failures', 'cost', 'facts', 'suggestions', 'ledger'],
    usableAsTool: true,
    toolDescription:
      'Read Landflow usage. Arguments: `operation` (report, events, facts, workflow, proposals), `groupBy` for reports (day, kind, workflow, nodeType, signature, agent, model, attr), `groupAttr` (the attribute to group by when groupBy is attr), `kinds` (comma-separated, built-in like node.failed,ai.call or custom like work.ticket_moved), `attrEquals` (JSON object or key=value pairs an event’s attributes must have), `days`, `workflowId`, `query` for facts.',
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'report',
        noDataExpression: true,
        options: [
          { name: 'Report', value: 'report', description: 'Counts, failures, durations, tokens and cost, grouped' },
          { name: 'Events', value: 'events', description: 'The events themselves, newest first' },
          { name: 'Search Facts', value: 'facts', description: 'What the brain learned, best match first' },
          { name: 'Workflow Knowledge', value: 'workflow', description: 'A workflow’s profile, facts and open suggestions' },
          { name: 'Suggestions', value: 'proposals', description: 'Suggestions in the inbox' },
        ],
      },
      {
        name: 'groupBy',
        displayName: 'Group By',
        type: 'options',
        default: 'workflow',
        options: (['day', 'kind', 'workflow', 'nodeType', 'signature', 'agent', 'model', 'attr'] as UsageGroup[]).map((g) => ({ name: g === 'attr' ? 'attribute' : g, value: g })),
        displayOptions: { show: { operation: ['report'] } },
      },
      { name: 'groupAttr', displayName: 'Attribute', type: 'string', default: '', placeholder: 'team', description: 'The attribute to group by (reads the raw events, not the daily rollups)', displayOptions: { show: { operation: ['report'], groupBy: ['attr'] } } },
      { name: 'kinds', displayName: 'Kinds', type: 'multiOptions', default: [], options: kindOptions, typeOptions: { loadOptionsMethod: 'kinds' }, description: 'Empty: every kind. Custom kinds are listed too', displayOptions: { show: { operation: ['report', 'events'] } } },
      { name: 'attrEquals', displayName: 'Attribute Filter', type: 'json', default: '{}', description: 'Only events whose attributes equal these, for any kind: {"team": "billing"} or team=billing', displayOptions: { show: { operation: ['report', 'events'] } } },
      { name: 'days', displayName: 'Days', type: 'number', default: 7, typeOptions: { minValue: 1, maxValue: 400 }, displayOptions: { show: { operation: ['report', 'events'] } } },
      {
        name: 'workflowId',
        displayName: 'Workflow',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'workflows' },
        displayOptions: { show: { operation: ['report', 'events', 'workflow', 'proposals'] } },
      },
      { name: 'query', displayName: 'Query', type: 'string', default: '', placeholder: 'invoice failures', displayOptions: { show: { operation: ['facts'] } } },
      {
        name: 'status',
        displayName: 'Status',
        type: 'options',
        default: 'open',
        options: ['open', 'applied', 'dismissed', 'snoozed', 'expired', 'all'].map((s) => ({ name: s, value: s })),
        displayOptions: { show: { operation: ['proposals'] } },
      },
      { name: 'limit', displayName: 'Limit', type: 'number', default: 50, typeOptions: { minValue: 1, maxValue: 1000 }, displayOptions: { show: { operation: ['report', 'events', 'facts', 'proposals'] } } },
      { name: 'oneItem', displayName: 'As One Item', type: 'boolean', default: false, description: 'Output the whole answer as one item instead of one item per row', displayOptions: { show: { operation: ['report', 'events', 'facts', 'proposals'] } } },
    ],
  },
  methods: { loadOptions: { workflows: anyWorkflow, kinds: anyKind } },
  async execute(ctx) {
    const { usageReport, listUsageEvents } = await import('../usage/query');
    const { scopeForWorkflow, covers } = await import('../brain/scope');
    const { searchFacts, listFacts, getProfile } = await import('../brain/facts');
    const { listProposals } = await import('../brain/proposals');
    const { vectorFactHits } = await import('../brain/study');
    const { workflowOutline } = await import('../assistant/research');
    const { agentStore } = await import('../agents/store');
    const { projectsOf } = await import('../brain/scope');
    const scope = scopeForWorkflow(ctx.getWorkflowId());
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    const labels = (group: UsageGroup, key: string) => (group === 'workflow' ? store.getWorkflow(key)?.name : group === 'agent' ? agentStore.get(key)?.name : undefined);
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const operation = ctx.getNodeParameter<string>('operation', i);
      const workflowId = String(ctx.getNodeParameter('workflowId', i, '') ?? '').trim() || undefined;
      if (workflowId && !covers(scope, { workflowId })) throw new NodeOperationError('This workflow can’t read that workflow’s usage', { itemIndex: i });
      const days = Math.max(1, Math.min(400, Number(ctx.getNodeParameter('days', i, 7)) || 7));
      const limit = Math.max(1, Math.min(1_000, Number(ctx.getNodeParameter('limit', i, 50)) || 50));
      const oneItem = Boolean(ctx.getNodeParameter('oneItem', i, false));
      const kinds = list(ctx.getNodeParameter('kinds', i, [])).filter((k): k is UsageKind => isUsageKind(k));
      const attrEquals = parseAttrEquals(ctx.getNodeParameter('attrEquals', i, {}));
      const from = new Date(Date.now() - days * DAY_MS).toISOString();
      const filter = { kinds, from, workflowId, ...(Object.keys(attrEquals).length && { attrEquals }) };
      const rows: unknown[] = [];
      let whole: unknown;
      switch (operation) {
        case 'report': {
          const groupBy = ctx.getNodeParameter<UsageGroup>('groupBy', i);
          const attr = String(ctx.getNodeParameter('groupAttr', i, '') ?? '').trim();
          if (groupBy === 'attr' && !attr) throw new NodeOperationError('Name the attribute to group by', { itemIndex: i });
          whole = usageReport({ ...filter, ...(groupBy === 'attr' && { attr }) }, groupBy, { scope, limit, labels });
          rows.push(...(whole as { rows: unknown[] }).rows);
          break;
        }
        case 'events':
          rows.push(...listUsageEvents(filter, { limit, scope }));
          whole = { events: rows };
          break;
        case 'facts': {
          const query = String(ctx.getNodeParameter('query', i, '') ?? '');
          rows.push(...searchFacts(query, { scope, limit, vectorHits: await vectorFactHits(query, projectsOf(scope)) }));
          whole = { facts: rows };
          break;
        }
        case 'workflow': {
          if (!workflowId) throw new NodeOperationError('Choose a workflow', { itemIndex: i });
          const workflow = store.getWorkflow(workflowId);
          whole = {
            ...(workflow && { name: workflow.name, outline: workflowOutline(workflow) }),
            profile: getProfile('workflow', workflowId) ?? null,
            facts: listFacts({ subjectType: 'workflow', subjectId: workflowId }),
            proposals: listProposals({ workflowId }),
          };
          break;
        }
        case 'proposals': {
          const status = ctx.getNodeParameter<string>('status', i) as 'open';
          rows.push(...listProposals({ status, workflowId, scope, limit }).map((p) => ({ ...p, ...(p.detector && { detectorLabel: detectorLabel(p.detector, p.label) }) })));
          whole = { proposals: rows };
          break;
        }
        default:
          throw new NodeOperationError(`Unknown operation ${operation}`, { itemIndex: i });
      }
      if (operation === 'workflow' || oneItem) out.push({ json: json(whole), pairedItem: { item: i } });
      else out.push(...rows.map((row) => ({ json: json(row), pairedItem: { item: i } })));
    }
    return [out];
  },
});

export const findSimilarNode = defineNode({
  description: {
    name: 'findSimilar',
    displayName: 'Find Similar',
    description: 'Ask the second brain whether something like this already exists: the nearest workflows, agents and facts to a title and a goal',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:search-check',
    color: '#8b5cf6',
    subtitle: '{{what}}',
    keywords: ['similar', 'duplicate', 'overlap', 'already', 'second brain', 'nearest', 'search', 'is anyone doing this'],
    usableAsTool: true,
    toolDescription:
      'Check whether something like this already exists. Arguments: `text` (a title and a goal), `what` (workflow, agent, fact; comma-separated, default all), `limit`, `minScore` (0..1), `includeOthers` (also list lookalikes in projects you can\'t open: only title, owner, goal, project and score).',
    inputs: main,
    outputs: main,
    properties: [
      { name: 'text', displayName: 'Title and Goal', type: 'string', default: '', required: true, typeOptions: { rows: 3 }, placeholder: 'Remind customers of unpaid invoices', description: 'What you want to build or know about' },
      { name: 'what', displayName: 'Search In', type: 'multiOptions', default: ['workflow', 'agent', 'fact'], options: SIMILAR_KINDS.map((k) => ({ name: k === 'fact' ? 'Facts' : k === 'agent' ? 'Agents' : 'Workflows', value: k })) },
      { name: 'limit', displayName: 'Limit', type: 'number', default: 10, typeOptions: { minValue: 1, maxValue: 100 } },
      { name: 'minScore', displayName: 'Minimum Score', type: 'number', default: 0.15, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 }, description: '0 to 1: how much of the wording the two share (and, with embeddings, how close in meaning)' },
      {
        name: 'includeOthers',
        displayName: 'Include Other Projects',
        type: 'boolean',
        default: false,
        description: 'Also list lookalikes in projects this workflow’s creator can’t open. Those carry only type, title, owner, goal, project and score: no id, no facts, no evidence',
      },
    ],
  },
  async execute(ctx) {
    const { findSimilar } = await import('../brain/similar');
    const { scopeForWorkflow } = await import('../brain/scope');
    const workflowId = ctx.getWorkflowId();
    const scope = scopeForWorkflow(workflowId);
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const text = String(ctx.getNodeParameter('text', i, '') ?? '').trim();
      if (!text) throw new NodeOperationError('Say what to look for: a title and a goal', { itemIndex: i });
      const kinds = list(ctx.getNodeParameter('what', i, SIMILAR_KINDS)).filter((k): k is SimilarKind => (SIMILAR_KINDS as readonly string[]).includes(k));
      const matches = await findSimilar(text, {
        scope,
        kinds,
        limit: Number(ctx.getNodeParameter('limit', i, 10)) || 10,
        minScore: Number(ctx.getNodeParameter('minScore', i, 0.15)),
        includeOthers: Boolean(ctx.getNodeParameter('includeOthers', i, false)),
        // A workflow looking for lookalikes of itself shouldn't find itself; an agent's tools run as `agent:<id>`.
        exclude: workflowId?.startsWith('agent:') ? { agentId: workflowId.slice('agent:'.length) } : { workflowId },
      });
      out.push(...matches.map((match) => ({ json: json(match), pairedItem: { item: i } })));
    }
    return [out];
  },
});

export const usageTriggerNode = defineNode({
  description: {
    name: 'usageTrigger',
    displayName: 'On Usage Event',
    description: 'Start the workflow when something happens on the platform: a node fails, a run is slow, an AI call costs too much, or a flow records its own event…',
    version: 1,
    kind: 'trigger',
    // "Run" in the editor starts here with an example; the ledger starts it once the workflow is published.
    triggerSource: 'manual',
    categories: ['Triggers', 'AI'],
    icon: 'lucide:radar',
    color: '#8b5cf6',
    subtitle: '{{kinds}}',
    keywords: ['usage', 'event', 'failure', 'second brain', 'monitor', 'watch', 'on failure', 'cost'],
    inputs: [],
    outputs: main,
    properties: [
      { name: 'kinds', displayName: 'Kinds', type: 'multiOptions', default: ['node.failed'], options: kindOptions, typeOptions: { loadOptionsMethod: 'kinds' }, description: 'Empty: every kind. Custom kinds (Record Event) are listed too' },
      { name: 'attrEquals', displayName: 'Attribute Filter', type: 'json', default: '{}', description: 'Only events whose attributes equal these, for any kind: {"team": "billing"} or team=billing' },
      { name: 'workflowId', displayName: 'Workflow', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'workflows' }, description: 'Only events of this workflow' },
      {
        name: 'detector',
        displayName: 'Suggestion From',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'detectors' },
        description: 'For proposal.applied: only suggestions this detector made. Each item carries the whole suggestion in `proposal`',
        displayOptions: { show: { kinds: ['proposal.applied'] } },
      },
      { name: 'onlyNew', displayName: 'Only New Failures', type: 'boolean', default: false, description: 'For node.failed: only a failure signature never seen before', displayOptions: { show: { kinds: ['node.failed'] } } },
      { name: 'minCost', displayName: 'Minimum Cost (USD)', type: 'number', default: 0, typeOptions: { minValue: 0, numberPrecision: 4 }, description: 'For ai.call: only calls that cost at least this', displayOptions: { show: { kinds: ['ai.call'] } } },
      { name: 'batchSeconds', displayName: 'Batch Seconds', type: 'number', default: 10, typeOptions: { minValue: 0, maxValue: 3600 }, description: 'Events within this many seconds start one run, one item each' },
      {
        name: 'notice',
        displayName:
          'Publish the workflow to listen. Each event is an item: { kind, at, workflowId, nodeId, nodeType, agentId, executionId, signature, message, durationMs, items, tokens, cost, attrs }, and for proposal.applied the suggestion in `proposal`. Events that workflows starting from On Usage Event cause (or record with Record Event) never start one, so they can’t loop.',
        type: 'notice',
      },
    ],
  },
  methods: { loadOptions: { workflows: anyWorkflow, detectors: anyDetector, kinds: anyKind } },
  execute(ctx) {
    const items = ctx.getInputData();
    if (items.some((item) => Object.keys(item.json).length)) return [items];
    // A manual run: an example of what an event hands over.
    return [
      [
        {
          json: {
            id: 'ue_example',
            at: new Date().toISOString(),
            kind: 'node.failed',
            workflowId: 'wf_example',
            workflowName: 'Example workflow',
            nodeId: 'n1',
            nodeType: 'core.httpRequest',
            executionId: 'ex_example',
            signature: '3f2a9c1d0b7e',
            message: 'The service answered 503: Service Unavailable',
            durationMs: 30_012,
            attrs: { mode: 'trigger' },
          },
        },
      ],
    ];
  },
});

/** The attributes parameter: an object, or JSON text of one (empty is none). */
function attributesOf(value: unknown, itemIndex: number): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new NodeOperationError('Attributes must be a JSON object, such as {"team": "billing"}', { itemIndex });
    }
  }
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new NodeOperationError('Attributes must be a JSON object, such as {"team": "billing"}', { itemIndex });
  return parsed as Record<string, unknown>;
}

const optionalNumber = (value: unknown) => (value === '' || value === undefined || value === null || !Number.isFinite(Number(value)) ? undefined : Number(value));

export const recordEventNode = defineNode({
  description: {
    name: 'recordEvent',
    displayName: 'Record Event',
    description: 'Write your own event into the usage ledger, under a kind you declared (work.ticket_moved…), so On Usage Event can start flows on it and Landflow Usage can report on it',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:radio-tower',
    color: '#8b5cf6',
    subtitle: '{{kind}}',
    keywords: ['event', 'usage', 'ledger', 'record', 'log', 'metric', 'custom event', 'second brain', 'emit'],
    usableAsTool: true,
    toolDescription:
      'Record an event in the usage ledger. Arguments: `kind` (a declared custom kind, such as work.ticket_moved), `attributes` (a JSON object checked against the kind’s declared fields), optional `workflowId` or `agentId` the event is about (default: this workflow), `message`, `durationMs`, `items`, `cost`.',
    inputs: main,
    outputs: main,
    properties: [
      { name: 'kind', displayName: 'Kind', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'declaredKinds' }, description: 'A kind declared in Insights or with POST /api/usage/kinds: <namespace>.<name>' },
      { name: 'attributes', displayName: 'Attributes (JSON)', type: 'json', default: '{}', description: 'Checked against the kind’s declared fields: a missing required one or one of the wrong type fails the node; undeclared ones are dropped and listed in `dropped`' },
      { name: 'declareIfNew', displayName: 'Declare Kind If New', type: 'boolean', default: false, description: 'When the kind (set by an expression) isn’t declared yet, declare it from these attributes’ names and types, all optional' },
      { name: 'workflowId', displayName: 'About Workflow', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'workflows' }, description: 'The workflow the event is about (empty: this workflow). Only workflows this workflow’s creator can see' },
      { name: 'agentId', displayName: 'About Agent', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'agents' }, description: 'The agent the event is about, when it isn’t about a workflow' },
      { name: 'message', displayName: 'Message', type: 'string', default: '', description: 'A short text; personal details and secrets are redacted and it is clipped to 300 characters' },
      { name: 'durationMs', displayName: 'Duration (ms)', type: 'number', default: '' as unknown as number },
      { name: 'items', displayName: 'Items', type: 'number', default: '' as unknown as number },
      { name: 'cost', displayName: 'Cost (USD)', type: 'number', default: '' as unknown as number, typeOptions: { numberPrecision: 4 } },
    ],
  },
  methods: { loadOptions: { declaredKinds: declaredKind, workflows: anyWorkflow, agents: anyAgent } },
  async execute(ctx) {
    const { getKind, saveKind, inferFields, checkAttrs, KindError } = await import('../usage/kinds');
    const { recordUsage } = await import('../usage/ledger');
    const { scopeForWorkflow, covers } = await import('../brain/scope');
    const own = ctx.getWorkflowId();
    const scope = scopeForWorkflow(own);
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const kind = String(ctx.getNodeParameter('kind', i, '') ?? '').trim();
      if (!kind) throw new NodeOperationError('Choose the kind of event to record', { itemIndex: i });
      const problem = customKindProblem(kind);
      if (problem) throw new NodeOperationError(problem, { itemIndex: i });
      const given = attributesOf(ctx.getNodeParameter('attributes', i, {}), i);
      let def = getKind(kind);
      if (!def) {
        if (!ctx.getNodeParameter('declareIfNew', i, false)) {
          throw new NodeOperationError(`The kind ${kind} isn’t declared`, { itemIndex: i, description: 'Declare it first (POST /api/usage/kinds, or turn on Declare Kind If New)' });
        }
        try {
          def = saveKind({ kind, description: 'Declared by Record Event', fields: inferFields(given) });
        } catch (caught) {
          throw new NodeOperationError((caught as Error).message, { itemIndex: i });
        }
      }
      let checked: ReturnType<typeof checkAttrs>;
      try {
        checked = checkAttrs(def, given);
      } catch (caught) {
        if (caught instanceof KindError) throw new NodeOperationError(caught.message, { itemIndex: i });
        throw caught;
      }
      // About this workflow (or this agent, for a tool) unless told otherwise; a flow only writes about what its creator can see.
      let workflowId = String(ctx.getNodeParameter('workflowId', i, '') ?? '').trim() || undefined;
      let agentId = String(ctx.getNodeParameter('agentId', i, '') ?? '').trim() || undefined;
      if (workflowId) {
        if (!store.getWorkflow(workflowId)) throw new NodeOperationError(`No workflow ${workflowId}`, { itemIndex: i });
        if (!covers(scope, { workflowId })) throw new NodeOperationError('This workflow can’t record events about that workflow', { itemIndex: i });
        agentId = undefined;
      } else if (agentId) {
        if (!agents.get(agentId)) throw new NodeOperationError(`No agent ${agentId}`, { itemIndex: i });
        if (!covers(scope, { agentId })) throw new NodeOperationError('This workflow can’t record events about that agent', { itemIndex: i });
      } else if (own?.startsWith('agent:')) agentId = own.slice('agent:'.length);
      else workflowId = own;
      const event = recordUsage({
        kind: def.kind,
        ...(workflowId && { workflowId }),
        ...(agentId && { agentId }),
        executionId: ctx.getExecutionId(),
        nodeId: ctx.getNode().id,
        message: String(ctx.getNodeParameter('message', i, '') ?? '') || undefined,
        durationMs: optionalNumber(ctx.getNodeParameter('durationMs', i, '')),
        items: optionalNumber(ctx.getNodeParameter('items', i, '')),
        cost: optionalNumber(ctx.getNodeParameter('cost', i, '')),
        // recordedBy is how On Usage Event keeps a triggered flow's events from starting anything (no loops).
        attrs: { ...checked.attrs, ...(own && { recordedBy: own }) },
      });
      out.push({
        json: json({ recorded: Boolean(event), kind: def.kind, ...(event && { id: event.id, at: event.at, attrs: event.attrs ?? {} }), dropped: checked.dropped, ...(!event && { note: 'The ledger is off (LANDFLOW_BRAIN=false) or the write failed' }) }),
        pairedItem: { item: i },
      });
    }
    return [out];
  },
});

export const detectorTriggerNode = defineNode({
  description: {
    name: 'detectorTrigger',
    displayName: 'Detector Trigger',
    description: 'Make this workflow one of the second brain’s detectors: it runs on the brain’s hourly look and on Run now, and its suggestions tune, expire and are measured like the built-in ones',
    version: 1,
    kind: 'trigger',
    // "Run" in the editor starts here with this workflow's real detector values; the brain starts it once published.
    triggerSource: 'manual',
    categories: ['Triggers', 'AI'],
    icon: 'lucide:scan-search',
    color: '#8b5cf6',
    keywords: ['detector', 'second brain', 'insights', 'suggestion', 'finding', 'brain tick', 'quiet', 'overlap'],
    inputs: [],
    outputs: main,
    properties: [
      {
        name: 'notice',
        displayName:
          'Publish the workflow to make it a detector (detector id flow:<this workflow’s id>). Each run has one item: { detector, name, quiet, minConfidence, at, lastRunAt, reason }. Multiply your thresholds by `quiet` (1 is normal; it rises to 3 as people dismiss this detector’s suggestions as wrong or not relevant). Suggest Improvement nodes in this workflow post as the detector, and a suggestion under `minConfidence` is held back.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    if (items.some((item) => Object.keys(item.json).length)) return [items];
    // A run from the editor: this workflow's detector values now.
    const workflowId = ctx.getWorkflowId() ?? 'wf_example';
    const { quietOf } = await import('../brain/proposals');
    const id = flowDetectorId(workflowId);
    const quiet = quietOf(id);
    return [[{ json: { detector: id, name: store.getWorkflow(workflowId)?.name ?? 'Example detector', quiet, minConfidence: quietBar(quiet), at: new Date().toISOString(), reason: 'manual' } }]];
  },
});

const HELD_BACK = 'held back: the same advice is already open for this node, it was dismissed or applied recently, or the weekly cap is full';

export const suggestImprovementNode = defineNode({
  description: {
    name: 'suggestImprovement',
    displayName: 'Suggest Improvement',
    description: 'Post a suggestion to the Suggestions inbox, next to the second brain’s own: a change to a workflow, a new workflow, or advice',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:lightbulb',
    color: '#8b5cf6',
    subtitle: '{{label}}',
    keywords: ['suggest', 'improvement', 'proposal', 'second brain', 'recommendation', 'inbox'],
    usableAsTool: true,
    toolDescription:
      'Post a suggestion to the inbox. Arguments: `title`, `why` (with the evidence), optional `workflowId` it is about, `effect` (the expected effect), `ops` (a JSON array of edit operations on that workflow: addNode, setParameters, connect, setNodeSettings, setWorkflowSettings…).',
    inputs: main,
    outputs: main,
    properties: [
      { name: 'title', displayName: 'Title', type: 'string', default: '', required: true, placeholder: 'Retry the CRM call when it times out' },
      { name: 'why', displayName: 'Why', type: 'string', default: '', required: true, typeOptions: { rows: 3 }, description: 'The reason and the evidence people see' },
      { name: 'workflowId', displayName: 'About Workflow', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'workflows' }, description: 'The workflow it changes or is about (empty: the instance)' },
      { name: 'nodeName', displayName: 'Node', type: 'string', default: '', description: 'The node it is about, by name' },
      { name: 'label', displayName: 'Label', type: 'string', default: '', description: 'A short tag in the inbox (default: this workflow’s name)' },
      { name: 'effect', displayName: 'Expected Effect', type: 'string', default: '' },
      { name: 'ops', displayName: 'Changes (JSON)', type: 'json', default: '[]', description: 'Edit operations on the workflow, checked against it before they are kept; empty for advice' },
      {
        name: 'risk',
        displayName: 'Risk',
        type: 'options',
        default: 'medium',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'Medium', value: 'medium' },
          { name: 'High', value: 'high' },
        ],
      },
      { name: 'confidence', displayName: 'Confidence', type: 'number', default: 0.6, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 } },
      { name: 'fingerprint', displayName: 'Fingerprint', type: 'string', default: '', description: 'The same fingerprint refreshes the open suggestion instead of adding one (default: from the label, workflow and title)' },
    ],
  },
  methods: { loadOptions: { workflows: anyWorkflow } },
  async execute(ctx) {
    const { proposeFrom, ProposalError } = await import('../brain/proposals');
    const { covers, scopeForWorkflow } = await import('../brain/scope');
    const scope = scopeForWorkflow(ctx.getWorkflowId());
    const runId = ctx.getWorkflowId();
    // An agent's tools run as `agent:<id>`: its suggestions carry the agent's name.
    const { agentStore } = await import('../agents/store');
    const ownWorkflow = runId && !runId.startsWith('agent:') ? store.getWorkflow(runId) : undefined;
    const own = runId?.startsWith('agent:') ? agentStore.get(runId.slice('agent:'.length)) : ownWorkflow;
    // In a workflow with a Detector Trigger, suggestions are that detector's (docs/second-brain.md#flow-detectors).
    const { isDetectorFlow } = await import('../brain/flow-detectors');
    const detector = ownWorkflow && isDetectorFlow(ownWorkflow) ? flowDetectorId(ownWorkflow.id) : undefined;
    const { quietOf } = await import('../brain/proposals');
    const bar = detector ? quietBar(quietOf(detector)) : 0;
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const workflowId = String(ctx.getNodeParameter('workflowId', i, '') ?? '').trim() || undefined;
      if (workflowId && !covers(scope, { workflowId })) throw new NodeOperationError('This workflow can’t suggest changes to that workflow', { itemIndex: i });
      let ops: unknown = ctx.getNodeParameter('ops', i, '[]');
      if (typeof ops === 'string') {
        try {
          ops = ops.trim() ? JSON.parse(ops) : [];
        } catch {
          throw new NodeOperationError('Changes (JSON) is not valid JSON', { itemIndex: i });
        }
      }
      const confidence = Number(ctx.getNodeParameter('confidence', i, 0.6));
      try {
        const proposal = proposeFrom(
          {
            title: String(ctx.getNodeParameter('title', i) ?? ''),
            why: String(ctx.getNodeParameter('why', i) ?? ''),
            label: String(ctx.getNodeParameter('label', i, '') ?? '').trim() || own?.name,
            ...(workflowId && { workflowId }),
            nodeName: String(ctx.getNodeParameter('nodeName', i, '') ?? '').trim() || undefined,
            effect: String(ctx.getNodeParameter('effect', i, '') ?? '').trim() || undefined,
            ops,
            risk: ctx.getNodeParameter('risk', i, 'medium') as 'medium',
            confidence,
            fingerprint: String(ctx.getNodeParameter('fingerprint', i, '') ?? '').trim() || undefined,
          },
          'workflow',
          undefined,
          { detector },
        );
        const reason = detector && confidence < bar ? `held back: this detector is quieted (people dismissed most of its suggestions), so a suggestion needs a confidence of at least ${bar}` : HELD_BACK;
        out.push({ json: proposal ? json({ saved: true, proposal }) : { saved: false, reason, ...(detector && { detector }) }, pairedItem: { item: i } });
      } catch (caught) {
        if (caught instanceof ProposalError) throw new NodeOperationError(caught.message, { itemIndex: i });
        throw caught;
      }
    }
    return [out];
  },
});
