import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { Landledger } from '../client';
import {
  amountParameter,
  dayParameter,
  DEFAULT_BASE_URL,
  fromMicros,
  mapItems,
  monthParameter,
  objectParameter,
  optionalString,
  requireString,
  toMicros,
  unsupported,
  type ApiContext,
  type LandledgerCredentials,
  type LandledgerRelayCredentials,
} from '../shared';

const ICON = 'file:landledger.svg';
export const COLOR = '#2F7D5B';
const DOCS = 'https://github.com/landfalls-ai/landflow/blob/main/plugins/landledger/README.md';

const baseUrlProperty = {
  name: 'baseUrl',
  displayName: 'Base URL',
  type: 'string' as const,
  required: true,
  default: DEFAULT_BASE_URL,
  placeholder: 'http://127.0.0.1:4810',
  description: 'Landledger\'s API. On the OrbStack cluster the default; on this machine http://127.0.0.1:4810',
};

/** Scopes no flow key needs beside decisions:relay (Landledger refuses a relay key with requests:write or admin). */
const NOT_WITH_RELAY = ['requests:write', 'reservations:write', 'webhooks:write', 'ingest', 'admin'];

/** `GET /api/health` and `GET /api/auth/me`: the version, the key's name and id, its scopes. */
async function whoIs(ctx: { http: ApiContext['http'] }, data: LandledgerCredentials | LandledgerRelayCredentials) {
  const client = new Landledger({ http: ctx.http }, data);
  const health = await client.health();
  const me = await client.me();
  const scopes = Array.isArray(me.scopes) ? me.scopes.map(String) : [];
  const who = `Landledger${health.version ? ` ${health.version}` : ''} as ${me.user?.name ?? me.kind}${me.kind === 'key' && me.user?.id ? ` (key ${me.user.id})` : ''}`;
  return { scopes, who };
}

/**
 * The key for everything but relays: `read` and `requests:write` for the Landledger node (`reservations:write` to
 * reserve), `webhooks:write` for a Landledger Trigger to subscribe itself. Give the trigger its own credential with a
 * `webhooks:write` key, and relays their own (Landledger Relay Key).
 */
export const landledgerApi = defineCredentialType<LandledgerCredentials>({
  name: 'landledgerApi',
  displayName: 'Landledger API (ll_…)',
  icon: ICON,
  documentationUrl: DOCS,
  properties: [
    baseUrlProperty,
    {
      name: 'apiKey',
      displayName: 'API Key',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      default: '',
      placeholder: 'll_…',
      description:
        'A Landledger API key (ll_…). For the Landledger node: read, and requests:write to raise requests (reservations:write to reserve and release). For a Landledger Trigger, a key of its own with only webhooks:write, so it subscribes itself on publish. Never decisions:relay: relays take a Landledger Relay Key credential',
    },
    {
      name: 'webhookSecret',
      displayName: 'Webhook Signing Secret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      placeholder: 'whsec_…',
      description:
        'Optional. The secret of a webhook subscription a Landledger admin made for the Landledger Trigger\'s URL. Set, the trigger registers nothing and checks deliveries with it; empty, the trigger subscribes itself on publish (the key needs webhooks:write) and keeps the secret Landledger returns, never shown',
    },
  ],
  async test(data, ctx) {
    try {
      const { scopes, who } = await whoIs(ctx, data);
      const warnings: string[] = [];
      if (scopes.includes('decisions:relay')) warnings.push('this key also holds decisions:relay: relays take their own key (a Landledger Relay Key credential), so the key that raises a request never carries its approval');
      if (scopes.includes('admin')) warnings.push('admin is more than a flow needs (read and requests:write for the node, webhooks:write for a trigger)');
      return { ok: true, message: `Connected to ${who}: ${scopes.join(', ') || 'no scopes'}${warnings.map((w) => `. Warning: ${w}`).join('')}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

/**
 * The relay key: `decisions:relay` only. Decision → Relay carries a person's signed Slack press to Landledger, which
 * verifies it and decides as the person who linked that Slack user; the key never names who decided.
 */
export const landledgerRelayApi = defineCredentialType<LandledgerRelayCredentials>({
  name: 'landledgerRelayApi',
  displayName: 'Landledger Relay Key (decisions:relay)',
  icon: ICON,
  documentationUrl: DOCS,
  properties: [
    baseUrlProperty,
    {
      name: 'apiKey',
      displayName: 'Relay Key',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      default: '',
      placeholder: 'll_…',
      description: 'A Landledger API key with decisions:relay and nothing else (Landledger refuses a relay key with requests:write or admin; this test refuses any other write scope)',
    },
  ],
  async test(data, ctx) {
    try {
      const { scopes, who } = await whoIs(ctx, data);
      const list = scopes.join(', ') || 'no scopes';
      if (!scopes.includes('decisions:relay')) return { ok: false, message: `Connected to ${who}, but the key has no decisions:relay (${list}): it can't relay a press` };
      const extra = scopes.filter((s) => NOT_WITH_RELAY.includes(s));
      if (extra.length) {
        return { ok: false, message: `Connected to ${who}, but a relay key must hold decisions:relay only; this one also holds ${extra.join(', ')}. Ask a Landledger admin for a key with decisions:relay alone` };
      }
      const others = scopes.filter((s) => s !== 'decisions:relay');
      return { ok: true, message: `Connected to ${who}: ${list}${others.length ? `. Warning: a relay needs only decisions:relay; this key also holds ${others.join(', ')}` : ''}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

const show = (resource: string, operation: string[], extra: Record<string, unknown[]> = {}) => ({ show: { resource: [resource], operation, ...extra } });

/** Landledger's spend dimensions (its libs/contracts Dimension). */
const DIMENSIONS: Array<[string, string]> = [
  ['costCenter', 'Cost Center'],
  ['team', 'Team'],
  ['product', 'Product'],
  ['service', 'Service'],
  ['namespace', 'Namespace'],
  ['agent', 'Agent'],
  ['model', 'Model'],
  ['provider', 'Provider'],
  ['plClass', 'P&L Class'],
  ['category', 'Category'],
  ['resource', 'Resource'],
  ['workflow', 'Workflow'],
];

const REQUEST_KINDS = [
  { name: 'Infrastructure Change', value: 'infra_change' },
  { name: 'AI Budget', value: 'ai_budget' },
  { name: 'Tool or Seat', value: 'tool_or_seat' },
  { name: 'Other', value: 'other' },
];

const EVIDENCE_HELP =
  'Any JSON object (≤ 64 kB) shown beside the request. Keys Landledger\'s console shows: lines ([{ label, amount }], the cost change), basis (how it was sized), links ([{ label, url }]), match (which real cost consumes the reservation: namespace, workload, service, agent, workflow, provider, model…, * wildcards)';

const personHint = 'Their Landbright email (or `sub`); Landledger finds the person and asks them to confirm the request in their own session';

const requestId = (resource: string, operation: string[]): PropertyDescriptor => ({
  name: 'requestId',
  displayName: 'Request ID',
  type: 'string',
  required: true,
  default: '',
  displayOptions: show(resource, operation),
  description: 'The request\'s id (req_…)',
});

export const LandledgerNode = defineNode({
  description: {
    name: 'landledger',
    displayName: 'Landledger',
    description: 'Check a cost center\'s budget, query spend, raise and read spend requests, reserve and release budget, read a month\'s status, and relay a person\'s signed Slack approval to Landledger',
    version: 1,
    kind: 'action',
    categories: ['Finance', 'Productivity'],
    icon: ICON,
    color: COLOR,
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: DOCS,
    keywords: ['landledger', 'finance', 'budget', 'cost', 'spend', 'approval', 'request', 'reservation', 'finops', 'ledger'],
    usableAsTool: true,
    // Writes are at most once over a broker; reads opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Landledger, the cost ledger: check what a cost center has left this month after actuals and reservations (and whether a planned amount fits), query spend grouped by cost center, team, service, agent, model…, raise a spend request (an agent always names its sponsor, the accountable person) and read its status and evidence, reserve or release budget for an approved request, and read whether a month is open, closing or locked. Agents request; people decide: no tool here approves or rejects.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    // Relays take their own key (decisions:relay only); everything else the flow's key.
    credentials: [
      { name: 'landledgerApi', required: true, displayOptions: { hide: { resource: ['decision'] } } },
      { name: 'landledgerRelayApi', required: true, displayOptions: { show: { resource: ['decision'] } } },
    ],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'budget',
        options: [
          { name: 'Budget', value: 'budget' },
          { name: 'Cost', value: 'cost' },
          // A person's decision, carried by a flow (Slack, Teams, email). Never a tool: not for agents or MCP.
          { name: 'Decision', value: 'decision', mcp: false },
          { name: 'Key', value: 'key' },
          { name: 'Period', value: 'period' },
          { name: 'Request', value: 'request' },
          { name: 'Reservation', value: 'reservation' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'check',
        displayOptions: { show: { resource: ['budget'] } },
        options: [
          {
            name: 'Check',
            value: 'check',
            description: 'What a cost center has left in a month after actuals and reservations, and whether a planned amount fits',
            action: 'Check a budget',
            idempotent: true,
            toolAnnotations: { readOnlyHint: true },
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'query',
        displayOptions: { show: { resource: ['cost'] } },
        options: [
          {
            name: 'Query',
            value: 'query',
            description: 'Spend over a month or a range of days, grouped by a dimension (spend_by)',
            action: 'Query spend',
            idempotent: true,
            toolAnnotations: { readOnlyHint: true },
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'create',
        displayOptions: { show: { resource: ['request'] } },
        options: [
          { name: 'Create', value: 'create', description: 'Raise a spend request (infra change, AI budget, tool or seat, other) for people to approve', action: 'Create a request' },
          { name: 'Get', value: 'get', description: 'A request with its steps, decisions, reservations, Landledger\'s evidence and the evidence hash', action: 'Get a request', idempotent: true },
          { name: 'List', value: 'list', description: 'Requests, newest first: waiting, mine, decided, open or all', action: 'List requests', idempotent: true },
          { name: 'Mark Applied', value: 'markApplied', description: 'Tell Landledger an approved change is in place (approved → applied)', action: 'Mark a request applied' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'create',
        displayOptions: { show: { resource: ['reservation'] } },
        options: [
          { name: 'Create', value: 'create', description: 'Reserve another month of an approved request\'s window (idempotent per month)', action: 'Reserve budget' },
          { name: 'Release', value: 'release', description: 'Release a reservation (reserved → released)', action: 'Release a reservation' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getStatus',
        displayOptions: { show: { resource: ['period'] } },
        options: [{ name: 'Status', value: 'getStatus', description: 'Whether a month is open, closing or locked, and who moved it', action: 'Get a period\'s status', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'me',
        displayOptions: { show: { resource: ['key'] } },
        options: [
          {
            name: 'Who Am I',
            value: 'me',
            description: 'The key this node uses: its id (what a request\'s createdBy.id names when this key raised it), name and scopes',
            action: 'Get the key\'s identity',
            idempotent: true,
            toolAnnotations: { readOnlyHint: true },
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'relay',
        displayOptions: { show: { resource: ['decision'] } },
        options: [
          {
            name: 'Relay',
            value: 'relay',
            description: 'Carry a person\'s signed Slack press to Landledger as Slack sent it; Landledger verifies it and decides as the person who linked that Slack user. For flows only: refused when an agent or an MCP client calls it',
            action: 'Relay a decision',
            mcp: false,
          },
        ],
      },
      {
        name: 'notice',
        displayName:
          'Decision → Relay carries a press exactly as Slack sent it (the Slack Trigger\'s Button Pressed rawBody and headers) with a key that holds only decisions:relay. Landledger checks Slack\'s signature with the relay channel\'s signing secret, the team and the app, finds the person who linked that Slack user from their own session, and decides as them only on the budget owner\'s step of an infra change, AI budget, tool or seat, or other request. The flow never names who decided. An agent never decides: this operation is refused when the node runs as an AI tool or over MCP.',
        type: 'notice',
        default: '',
        displayOptions: { show: { resource: ['decision'] } },
      },

      // ---- Budget → Check
      { name: 'costCenter', displayName: 'Cost Center', type: 'string', required: true, default: '', placeholder: 'ENG-AGENTS', displayOptions: show('budget', ['check']), description: 'The cost center\'s code' },
      { name: 'month', displayName: 'Month', type: 'string', default: '', placeholder: '2026-11', displayOptions: show('budget', ['check']), description: 'YYYY-MM. Empty: this month (UTC)' },
      {
        name: 'plannedAmount',
        displayName: 'Planned Amount',
        type: 'string',
        default: '',
        placeholder: '1840.00',
        displayOptions: show('budget', ['check']),
        description: 'Optional, in the ledger\'s currency: the output says whether it fits in what is left (`fits`) and what would be left after it',
      },

      // ---- Cost → Query
      { name: 'by', displayName: 'Group By', type: 'options', default: 'costCenter', options: DIMENSIONS.map(([value, name]) => ({ name, value })), displayOptions: show('cost', ['query']) },
      {
        name: 'window',
        displayName: 'Window',
        type: 'options',
        default: 'month',
        options: [
          { name: 'A Month', value: 'month', description: 'Every record booked in the month (a locked month never changes)' },
          { name: 'A Range of Days', value: 'range', description: 'Records by the day they were charged' },
        ],
        displayOptions: show('cost', ['query']),
      },
      { name: 'month', displayName: 'Month', type: 'string', default: '', placeholder: '2026-11', displayOptions: show('cost', ['query'], { window: ['month'] }), description: 'YYYY-MM. Empty: this month (UTC)' },
      { name: 'from', displayName: 'From', type: 'dateTime', default: '', displayOptions: show('cost', ['query'], { window: ['range'] }), description: 'First day (UTC)' },
      { name: 'to', displayName: 'To', type: 'dateTime', default: '', displayOptions: show('cost', ['query'], { window: ['range'] }), description: 'Last day, inclusive (UTC)' },
      {
        name: 'filter',
        displayName: 'Filter',
        type: 'string',
        default: '',
        placeholder: 'costCenter:ENG-PLATFORM,service:landflow-host',
        displayOptions: show('cost', ['query']),
        description: 'dimension:value pairs, comma-separated. Empty: everything',
      },
      {
        name: 'layer',
        displayName: 'Layer',
        type: 'options',
        default: 'direct',
        options: [
          { name: 'Direct (the Books\' View)', value: 'direct', description: 'The shared pool on its own line' },
          { name: 'Spread', value: 'spread', description: 'The shared pool shared out by the allocation rules' },
        ],
        displayOptions: show('cost', ['query']),
      },
      { name: 'provisional', displayName: 'Include Today', type: 'boolean', default: true, displayOptions: show('cost', ['query']), description: 'Whether today\'s provisional figures count' },
      {
        name: 'output',
        displayName: 'Output',
        type: 'options',
        default: 'summary',
        options: [
          { name: 'One Item: Total and Groups', value: 'summary' },
          { name: 'One Item per Group', value: 'groups' },
          { name: 'One Item: Everything (with Daily Series)', value: 'full' },
        ],
        displayOptions: show('cost', ['query']),
      },

      // ---- Request → Create
      { name: 'kind', displayName: 'Kind', type: 'options', default: 'infra_change', options: REQUEST_KINDS, displayOptions: show('request', ['create']) },
      { name: 'title', displayName: 'Title', type: 'string', required: true, default: '', placeholder: 'Add a second Postgres replica', displayOptions: show('request', ['create']), description: '3-200 characters' },
      { name: 'costCenter', displayName: 'Cost Center', type: 'string', required: true, default: '', placeholder: 'ENG-PLATFORM', displayOptions: show('request', ['create']), description: 'The cost center that pays' },
      { name: 'amount', displayName: 'Amount', type: 'string', required: true, default: '', placeholder: '1840.00', displayOptions: show('request', ['create']), description: 'A decimal amount, at most six decimals: per month for a monthly request, else the one-off amount' },
      { name: 'currency', displayName: 'Currency', type: 'string', default: 'USD', displayOptions: show('request', ['create']), description: 'ISO 4217 code' },
      {
        name: 'recurrence',
        displayName: 'Recurrence',
        type: 'options',
        default: 'monthly',
        options: [
          { name: 'Monthly', value: 'monthly', description: 'A recurring amount per month from the start (to the end, or open-ended)' },
          { name: 'Once', value: 'once', description: 'A one-off amount' },
        ],
        displayOptions: show('request', ['create']),
      },
      {
        name: 'requestedBy',
        displayName: 'Requested By',
        type: 'options',
        default: 'person',
        options: [
          { name: 'A Person', value: 'person', description: 'Someone asked through this flow (a form, a pull request author)' },
          { name: 'An Agent, With Its Sponsor', value: 'agent', description: 'An agent asks; its sponsor is the person who answers for it (required when an agent calls this tool)' },
        ],
        displayOptions: show('request', ['create']),
      },
      { name: 'requester', displayName: 'Requester', type: 'string', required: true, default: '', placeholder: 'eden.tzur@landbright.test', displayOptions: show('request', ['create'], { requestedBy: ['person'] }), description: personHint },
      { name: 'agentId', displayName: 'Agent ID', type: 'string', required: true, default: '', displayOptions: show('request', ['create'], { requestedBy: ['agent'] }), description: 'The agent\'s id where it runs (a Landflow agent id, a kagent name)' },
      { name: 'agentName', displayName: 'Agent Name', type: 'string', required: true, default: '', displayOptions: show('request', ['create'], { requestedBy: ['agent'] }) },
      { name: 'agentSystem', displayName: 'Agent Runs In', type: 'string', default: 'landflow', displayOptions: show('request', ['create'], { requestedBy: ['agent'] }), description: 'landflow, kagent, claude, …' },
      { name: 'sponsor', displayName: 'Sponsor', type: 'string', required: true, default: '', placeholder: 'amit.gal@landbright.test', displayOptions: show('request', ['create'], { requestedBy: ['agent'] }), description: `The person accountable for the agent. ${personHint}` },
      { name: 'note', displayName: 'Note', type: 'string', default: '', typeOptions: { rows: 3 }, displayOptions: show('request', ['create']), description: 'Why, in the requester\'s words (≤ 4,000 characters)' },
      { name: 'evidence', displayName: 'Evidence', type: 'json', default: '{}', displayOptions: show('request', ['create']), description: EVIDENCE_HELP },
      {
        name: 'requestFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add field',
        displayOptions: show('request', ['create']),
        values: [
          { name: 'start', displayName: 'Start', type: 'dateTime', default: '', description: 'First day the spend applies (default: today)' },
          { name: 'end', displayName: 'End', type: 'dateTime', default: '', description: 'Last day, inclusive. Empty: open-ended (monthly) or the start day (once)' },
          { name: 'pullRequestUrl', displayName: 'Pull Request URL', type: 'string', default: '', description: 'The pull request the change is in (kept as a related source)' },
          { name: 'runUrl', displayName: 'Run URL', type: 'string', default: '', description: 'A link back to this run, for Landledger\'s console' },
          { name: 'originTitle', displayName: 'Origin Title', type: 'string', default: '', description: 'What the run is, in words' },
          { name: 'submit', displayName: 'Submit', type: 'boolean', default: true, description: 'Whether to submit it now (pending, or approved at once below the policy\'s threshold); off keeps a draft' },
          {
            name: 'idempotencyKey',
            displayName: 'Idempotency Key',
            type: 'string',
            default: '',
            description: 'Retries with the same key return the first request. Empty: this step of this run (a retried step raises nothing twice)',
          },
        ],
      },

      // ---- Request → Get, Mark Applied
      requestId('request', ['get', 'markApplied']),
      { name: 'appliedNote', displayName: 'Note', type: 'string', default: '', displayOptions: show('request', ['markApplied']), description: 'What was done (≤ 2,000 characters)' },
      { name: 'links', displayName: 'Links', type: 'json', default: '[]', displayOptions: show('request', ['markApplied']), description: 'Up to 10 links to what was done: [{ "label": "PR #42", "url": "https://…" }]' },

      // ---- Request → List
      {
        name: 'box',
        displayName: 'Box',
        type: 'options',
        default: 'all',
        options: [
          { name: 'All', value: 'all' },
          { name: 'Decided', value: 'decided', description: 'No longer pending' },
          { name: 'Mine', value: 'mine', description: 'Raised or sponsored by the key\'s person' },
          { name: 'Open', value: 'open', description: 'Pending' },
          { name: 'Waiting', value: 'waiting', description: 'A step pending on the caller' },
        ],
        displayOptions: show('request', ['list']),
      },
      {
        name: 'listFilters',
        displayName: 'Filters',
        type: 'collection',
        default: {},
        placeholder: 'Add filter',
        displayOptions: show('request', ['list']),
        values: [
          {
            name: 'status',
            displayName: 'Status',
            type: 'options',
            default: 'pending',
            options: ['draft', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'applied'].map((s) => ({ name: s[0].toUpperCase() + s.slice(1), value: s })),
          },
          { name: 'kind', displayName: 'Kind', type: 'options', default: 'infra_change', options: REQUEST_KINDS },
          { name: 'costCenter', displayName: 'Cost Center', type: 'string', default: '' },
        ],
      },
      { name: 'limit', displayName: 'Limit', type: 'number', default: 50, typeOptions: { minValue: 1, maxValue: 200, numberPrecision: 0 }, displayOptions: show('request', ['list']) },

      // ---- Reservation
      requestId('reservation', ['create']),
      { name: 'month', displayName: 'Month', type: 'string', default: '', placeholder: '2026-12', displayOptions: show('reservation', ['create']), description: 'YYYY-MM. Empty: Landledger picks the next month of the request\'s window' },
      { name: 'reserveAmount', displayName: 'Amount', type: 'string', default: '', displayOptions: show('reservation', ['create']), description: 'At most the request\'s monthly (or one-off) amount. Empty: all of it' },
      { name: 'reservationId', displayName: 'Reservation ID', type: 'string', required: true, default: '', displayOptions: show('reservation', ['release']), description: 'The reservation\'s id' },
      { name: 'reason', displayName: 'Reason', type: 'string', default: '', displayOptions: show('reservation', ['release']) },

      // ---- Period → Status
      { name: 'month', displayName: 'Month', type: 'string', default: '', placeholder: '2026-11', displayOptions: show('period', ['getStatus']), description: 'YYYY-MM. Empty: this month (UTC)' },

      // ---- Decision → Relay
      {
        name: 'channel',
        displayName: 'Channel',
        type: 'options',
        default: 'slack',
        options: [{ name: 'Slack', value: 'slack', description: 'A Block Kit button press (block_actions) on a Landledger card' }],
        displayOptions: show('decision', ['relay']),
        description: 'Where the person pressed. Only Slack is a relay channel in Landledger so far',
      },
      {
        name: 'slackBody',
        displayName: 'Slack Request Body',
        type: 'string',
        required: true,
        default: '{{ $json.rawBody }}',
        displayOptions: show('decision', ['relay']),
        description: 'The interaction exactly as Slack sent it (form-encoded payload=…): the Slack Trigger\'s Button Pressed rawBody. Never rebuilt: Landledger checks Slack\'s signature over these bytes',
      },
      {
        name: 'slackSignature',
        displayName: 'X-Slack-Signature',
        type: 'string',
        required: true,
        default: "{{ $json.headers['x-slack-signature'] }}",
        displayOptions: show('decision', ['relay']),
      },
      {
        name: 'slackTimestamp',
        displayName: 'X-Slack-Request-Timestamp',
        type: 'string',
        required: true,
        default: "{{ $json.headers['x-slack-request-timestamp'] }}",
        displayOptions: show('decision', ['relay']),
        description: 'Landledger refuses a press older than 5 minutes',
      },
      {
        name: 'relayChannelId',
        displayName: 'Relay Channel ID',
        type: 'string',
        default: '',
        displayOptions: show('decision', ['relay']),
        description: 'The relay channel registered in Landledger (Settings → Relay channels). Empty: the one whose team and app match the press',
      },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    // The flow's key, read only when an operation needs it (a relay node has the relay key instead).
    let flowClient: Landledger | undefined;
    const client = () => (flowClient ??= new Landledger(api, ctx.getCredentials<LandledgerCredentials>('landledgerApi')));
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      switch (resource) {
        case 'budget':
          if (operation !== 'check') break;
          return checkBudget(ctx, client(), i);
        case 'cost':
          if (operation !== 'query') break;
          return querySpend(ctx, client(), i);
        case 'request':
          return requestOperation(ctx, client(), operation, i);
        case 'reservation':
          return reservationOperation(ctx, client(), operation, i);
        case 'period':
          if (operation !== 'getStatus') break;
          return periodStatus(ctx, client(), i);
        case 'decision':
          if (operation !== 'relay') break;
          return relayDecision(ctx, api, i);
        case 'key':
          if (operation !== 'me') break;
          return whoAmI(client());
      }
      throw unsupported(resource, operation);
    });
  },
});

/** `jane@x.test` → `{ email }`, anything else → `{ sub }` (Landbright's subject). */
export function personRef(value: string): JsonObject {
  const text = value.trim();
  return text.includes('@') ? { email: text.toLowerCase() } : { sub: text };
}

/** Called by an agent (an AI tool) or an MCP client rather than a flow's own step. */
const byAgent = (ctx: IExecuteContext) => ctx.getMode() === 'tool' || ctx.getMode() === 'mcp';

async function checkBudget(ctx: IExecuteContext, client: Landledger, i: number): Promise<JsonObject> {
  const code = requireString(ctx, 'costCenter', 'Cost Center', i);
  const month = monthParameter(ctx.getNodeParameter('month', i, ''), i);
  const planned = optionalString(ctx, 'plannedAmount', i);
  const plannedMicros = planned ? toMicros(planned) : undefined;
  if (planned && (plannedMicros === undefined || plannedMicros < 0n)) throw new NodeOperationError('Planned Amount must be a non-negative amount', { itemIndex: i });
  const view = await client.budgets(month);
  const row = (view.rows ?? []).find((r) => String(r.code).toLowerCase() === code.toLowerCase());
  if (!row) {
    throw new NodeOperationError(`Landledger has no cost center ${code} in ${view.month ?? month}`, {
      itemIndex: i,
      description: `Cost centers that month: ${(view.rows ?? []).map((r) => r.code).join(', ') || 'none'}`,
    });
  }
  const budget = toMicros(row.budget);
  const actual = toMicros(row.monthToDate) ?? 0n;
  const reserved = toMicros(row.reserved) ?? 0n;
  const remaining = budget === undefined ? undefined : budget - actual - reserved;
  const out: JsonObject = {
    costCenter: String(row.code),
    name: (row.name as string) ?? null,
    owner: (row.owner as string) ?? null,
    month: String(view.month ?? month),
    currency: String(view.currency ?? 'USD'),
    budget: budget === undefined ? null : fromMicros(budget),
    actual: fromMicros(actual),
    reserved: fromMicros(reserved),
    remaining: remaining === undefined ? null : fromMicros(remaining),
    forecast: (row.forecast as string) ?? null,
    state: (row.state as string) ?? 'none',
  };
  if (plannedMicros !== undefined) {
    out.plannedAmount = fromMicros(plannedMicros);
    out.remainingAfter = remaining === undefined ? null : fromMicros(remaining - plannedMicros);
    // No budget: nothing to fit in, so it does not "fit" (an approval decides).
    out.fits = remaining !== undefined && remaining - plannedMicros >= 0n;
  }
  return out;
}

async function querySpend(ctx: IExecuteContext, client: Landledger, i: number): Promise<JsonObject | JsonObject[]> {
  const by = String(ctx.getNodeParameter('by', i, 'costCenter'));
  const window = String(ctx.getNodeParameter('window', i, 'month'));
  const range: { month?: string; from?: string; to?: string } = {};
  if (window === 'range') {
    const from = dayParameter(ctx.getNodeParameter('from', i, ''), 'From', i);
    const to = dayParameter(ctx.getNodeParameter('to', i, ''), 'To', i);
    if (!from || !to) throw new NodeOperationError('A range of days needs From and To', { itemIndex: i });
    if (from > to) throw new NodeOperationError('From must be on or before To', { itemIndex: i });
    Object.assign(range, { from, to });
  } else {
    range.month = monthParameter(ctx.getNodeParameter('month', i, ''), i);
  }
  const filter = optionalString(ctx, 'filter', i)
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  for (const f of filter) if (!/^[a-zA-Z]+:.+$/.test(f)) throw new NodeOperationError(`Filter "${f}" is not dimension:value`, { itemIndex: i });
  const result = await client.spend({
    by,
    ...range,
    ...(filter.length && { filter: filter.join(',') }),
    layer: String(ctx.getNodeParameter('layer', i, 'direct')),
    provisional: ctx.getNodeParameter<unknown>('provisional', i, true) === false ? 'false' : 'true',
  });
  const output = String(ctx.getNodeParameter('output', i, 'summary'));
  const groups = (Array.isArray(result.groups) ? result.groups : []) as JsonObject[];
  if (output === 'groups') return groups.map((g) => ({ ...g, by, from: result.from ?? null, to: result.to ?? null, currency: result.currency ?? 'USD' }));
  if (output === 'full') return result;
  const { daily: _daily, ...summary } = result;
  return summary as JsonObject;
}

async function requestOperation(ctx: IExecuteContext, client: Landledger, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  switch (operation) {
    case 'create':
      return client.createRequest(createBody(ctx, i));
    case 'get':
      return client.request(requireString(ctx, 'requestId', 'Request ID', i));
    case 'list': {
      const filters = (ctx.getNodeParameter<JsonObject>('listFilters', i, {}) ?? {}) as JsonObject;
      const text = (key: string) => (typeof filters[key] === 'string' && (filters[key] as string).trim() ? (filters[key] as string).trim() : undefined);
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(ctx.getNodeParameter('limit', i, 50)) || 50)));
      const answer = await client.requests({ box: String(ctx.getNodeParameter('box', i, 'all')), status: text('status'), kind: text('kind'), costCenter: text('costCenter'), limit });
      return answer.requests ?? [];
    }
    case 'markApplied': {
      const id = requireString(ctx, 'requestId', 'Request ID', i);
      const links = ctx.getNodeParameter<unknown>('links', i, '[]');
      const parsed = typeof links === 'string' ? (links.trim() ? JSON.parse(links) : []) : (links ?? []);
      if (!Array.isArray(parsed)) throw new NodeOperationError('Links must be a JSON array of { label, url }', { itemIndex: i });
      return client.markApplied(id, {
        note: optionalString(ctx, 'appliedNote', i),
        links: parsed.slice(0, 10).map((l: { label?: unknown; url?: unknown }) => ({ label: String(l?.label ?? l?.url ?? ''), url: String(l?.url ?? '') })),
      });
    }
  }
  throw unsupported('request', operation);
}

/** The `POST /api/requests` body (Landledger's CreateRequestInput) from the node's parameters. */
export function createBody(ctx: IExecuteContext, i: number): JsonObject {
  const kind = String(ctx.getNodeParameter('kind', i, 'infra_change'));
  const title = requireString(ctx, 'title', 'Title', i);
  if (title.length < 3 || title.length > 200) throw new NodeOperationError('Title must be 3-200 characters', { itemIndex: i });
  const currency = (optionalString(ctx, 'currency', i) || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new NodeOperationError(`Currency "${currency}" is not an ISO 4217 code`, { itemIndex: i });
  const fields = (ctx.getNodeParameter<JsonObject>('requestFields', i, {}) ?? {}) as JsonObject;
  const text = (key: string) => (fields[key] === undefined || fields[key] === null ? '' : String(fields[key]).trim());

  const requestedBy = String(ctx.getNodeParameter('requestedBy', i, 'person'));
  // Agents request with a sponsor: an agent (a tool call, MCP) can't raise a request in a person's own name.
  if (byAgent(ctx) && requestedBy !== 'agent') {
    throw new NodeOperationError('An agent raises a request as itself, with a sponsor', { itemIndex: i, description: 'Set Requested By to "An Agent, With Its Sponsor" in this tool.' });
  }
  const requester: JsonObject =
    requestedBy === 'agent'
      ? {
          kind: 'agent',
          agent: { id: requireString(ctx, 'agentId', 'Agent ID', i), name: requireString(ctx, 'agentName', 'Agent Name', i), system: optionalString(ctx, 'agentSystem', i) || 'landflow' },
          sponsor: personRef(requireString(ctx, 'sponsor', 'Sponsor', i)),
        }
      : { kind: 'person', person: personRef(requireString(ctx, 'requester', 'Requester', i)) };

  const workflowId = ctx.getWorkflowId();
  // The origin is how a flow finds its own requests again (and what a key bound to the workflow vouches for): an
  // unsaved workflow has no id to give, so it raises nothing rather than a made-up one.
  if (!workflowId || workflowId === 'unsaved') {
    throw new NodeOperationError('Save the workflow before it raises a Landledger request', {
      itemIndex: i,
      description: 'Landledger keeps the workflow and the run as the request\'s origin; an unsaved workflow has no id yet.',
    });
  }
  const origin: JsonObject = {
    type: 'landflow_run',
    workflowId,
    executionId: ctx.getExecutionId(),
    ...(text('runUrl') && { url: text('runUrl') }),
    ...(text('originTitle') && { title: text('originTitle').slice(0, 300) }),
  };
  const start = dayParameter(fields.start, 'Start', i);
  const end = dayParameter(fields.end, 'End', i);
  if (start && end && end < start) throw new NodeOperationError('End must be on or after Start', { itemIndex: i });
  const key = text('idempotencyKey') || (ctx.getIdempotencyKey() ? `${ctx.getIdempotencyKey()}:${i}` : '');
  return {
    kind,
    title,
    note: optionalString(ctx, 'note', i).slice(0, 4000),
    costCenter: requireString(ctx, 'costCenter', 'Cost Center', i),
    amount: { amount: amountParameter(ctx.getNodeParameter('amount', i, ''), 'Amount', i), currency },
    recurrence: String(ctx.getNodeParameter('recurrence', i, 'monthly')),
    ...(start && { start }),
    ...(end && { end }),
    evidence: objectParameter(ctx.getNodeParameter('evidence', i, '{}'), 'Evidence', i),
    origin,
    related: text('pullRequestUrl') ? [{ type: 'pull_request', url: text('pullRequestUrl') }] : [],
    requester,
    submit: fields.submit !== false,
    ...(key && { idempotencyKey: key.slice(0, 200) }),
  };
}

async function reservationOperation(ctx: IExecuteContext, client: Landledger, operation: string, i: number): Promise<JsonObject> {
  if (operation === 'create') {
    const month = optionalString(ctx, 'month', i);
    const amount = optionalString(ctx, 'reserveAmount', i);
    return client.reserve({
      requestId: requireString(ctx, 'requestId', 'Request ID', i),
      ...(month && { month: monthParameter(month, i) }),
      ...(amount && { amount: amountParameter(amount, 'Amount', i) }),
    });
  }
  if (operation === 'release') return client.release(requireString(ctx, 'reservationId', 'Reservation ID', i), optionalString(ctx, 'reason', i).slice(0, 1000));
  throw unsupported('reservation', operation);
}

async function periodStatus(ctx: IExecuteContext, client: Landledger, i: number): Promise<JsonObject> {
  const month = monthParameter(ctx.getNodeParameter('month', i, ''), i);
  const { periods } = await client.periods();
  const period = (periods ?? []).find((p) => p.month === month);
  // A month the ledger hasn't seen yet is open (nothing has moved it).
  return period ? { ...period, known: true } : { month, status: 'open', known: false, openedAt: null, closingBy: null, closingAt: null, lockedBy: null, lockedAt: null };
}

/** `GET /api/auth/me` for the node's key: compare `id` with a request's `createdBy.id` to know this key raised it. */
async function whoAmI(client: Landledger): Promise<JsonObject> {
  const me = await client.me();
  return { kind: me.kind, id: me.user?.id ?? null, name: me.user?.name ?? null, scopes: Array.isArray(me.scopes) ? me.scopes : [] };
}

async function relayDecision(ctx: IExecuteContext, api: ApiContext, i: number): Promise<JsonObject> {
  if (byAgent(ctx)) {
    throw new NodeOperationError('Decision → Relay is for flows only: an agent never decides', {
      itemIndex: i,
      description: 'A person decides in Landledger\'s console, or presses a button whose signed press a flow relays.',
    });
  }
  const channel = String(ctx.getNodeParameter('channel', i, 'slack'));
  if (channel !== 'slack') throw new NodeOperationError(`Channel "${channel}" is not a relay channel (only slack)`, { itemIndex: i });
  // Exactly the bytes Slack signed: no trimming, no re-encoding.
  const raw = ctx.getNodeParameter<unknown>('slackBody', i, '');
  const body = typeof raw === 'string' ? raw : '';
  if (!body) {
    throw new NodeOperationError('Slack Request Body is empty', {
      itemIndex: i,
      description: 'Use the Slack Trigger\'s Button Pressed item: rawBody, with headers x-slack-signature and x-slack-request-timestamp.',
    });
  }
  const signature = optionalString(ctx, 'slackSignature', i);
  if (!/^v0=[0-9a-f]{64}$/.test(signature)) throw new NodeOperationError('X-Slack-Signature must be v0=<64 hex characters>, as Slack sent it', { itemIndex: i });
  const timestamp = optionalString(ctx, 'slackTimestamp', i);
  if (!/^\d{1,12}$/.test(timestamp)) throw new NodeOperationError('X-Slack-Request-Timestamp must be Unix seconds, as Slack sent it', { itemIndex: i });
  const channelId = optionalString(ctx, 'relayChannelId', i);
  const relay = new Landledger(api, ctx.getCredentials<LandledgerRelayCredentials>('landledgerRelayApi'));
  return relay.relaySlack({ body, signature, timestamp, ...(channelId && { channelId }) });
}
