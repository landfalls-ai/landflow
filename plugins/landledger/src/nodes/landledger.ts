import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { Landledger } from '../client';
import {
  amountParameter,
  jsonParameter,
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
  type LandledgerNotesCredentials,
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
async function whoIs(ctx: { http: ApiContext['http'] }, data: LandledgerCredentials | LandledgerRelayCredentials | LandledgerNotesCredentials) {
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

/** Scopes a notes key never needs: it drafts notes and reads the figures they cite, nothing else. */
const NOT_WITH_NOTES = ['requests:write', 'reservations:write', 'webhooks:write', 'decisions:relay', 'ingest', 'admin'];

/**
 * The notes key: `notes:draft` only. Notes → Submit Draft sends an agent's draft of a variance note; Landledger checks
 * every cited figure against the month's frozen snapshot, and only a person (FP&A or a controller) accepts a note. An
 * agent may hold it: drafting is what agents are for.
 */
export const landledgerNotesKey = defineCredentialType<LandledgerNotesCredentials>({
  name: 'landledgerNotesKey',
  displayName: 'Landledger Notes Key (notes:draft)',
  icon: ICON,
  documentationUrl: DOCS,
  properties: [
    baseUrlProperty,
    {
      name: 'apiKey',
      displayName: 'Notes Key',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      default: '',
      placeholder: 'll_…',
      description: 'A Landledger API key with notes:draft and nothing else (it submits drafts of variance notes and reads the figures they may cite; no person\'s role carries it, and nothing it holds accepts a note)',
    },
  ],
  async test(data, ctx) {
    try {
      const { scopes, who } = await whoIs(ctx, data);
      const list = scopes.join(', ') || 'no scopes';
      if (!scopes.includes('notes:draft')) return { ok: false, message: `Connected to ${who}, but the key has no notes:draft (${list}): it can't submit a draft` };
      const extra = scopes.filter((s) => NOT_WITH_NOTES.includes(s));
      if (extra.length) return { ok: false, message: `Connected to ${who}, but a notes key must hold notes:draft only; this one also holds ${extra.join(', ')}. Ask a Landledger admin for a key with notes:draft alone` };
      const others = scopes.filter((s) => s !== 'notes:draft');
      return { ok: true, message: `Connected to ${who}: ${list}${others.length ? `. Warning: drafting needs only notes:draft; this key also holds ${others.join(', ')}` : ''}` };
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
    description: 'Check a cost center\'s budget, query spend and the cost of services over a window, find a contract\'s seats, read a closing month\'s frozen snapshot, draft its variance notes, raise and read spend requests, release a seat request\'s seats, reserve and release budget, read a month\'s status, and relay a person\'s signed Slack approval to Landledger',
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
      'Landledger, the cost ledger: check what a cost center has left this month after actuals and reservations (and whether a planned amount fits), query spend grouped by cost center, team, service, agent, model…, the estimated cost of named services over a time window, read a closing month\'s frozen snapshot and the figures its variance notes may cite, submit a draft of a variance note (a person accepts it), raise a spend request (an agent always names its sponsor, the accountable person) and read its status and evidence, reserve or release budget for an approved request, and read whether a month is open, closing or locked. Agents request; people decide: no tool here approves or rejects.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    // Relays take their own key (decisions:relay only); everything else the flow's key.
    credentials: [
      { name: 'landledgerApi', required: true, displayOptions: { hide: { resource: ['decision', 'note'] } } },
      { name: 'landledgerRelayApi', required: true, displayOptions: { show: { resource: ['decision'] } } },
      { name: 'landledgerNotesKey', required: true, displayOptions: { show: { resource: ['note'] } } },
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
          { name: 'Close', value: 'close' },
          { name: 'Contract', value: 'contract' },
          { name: 'Cost', value: 'cost' },
          // A person's decision, carried by a flow (Slack, Teams, email). Never a tool: not for agents or MCP.
          { name: 'Decision', value: 'decision', mcp: false },
          { name: 'Key', value: 'key' },
          { name: 'Note', value: 'note' },
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
        default: 'getSnapshot',
        displayOptions: { show: { resource: ['close'] } },
        options: [
          {
            name: 'Snapshot',
            value: 'getSnapshot',
            description: 'A closing month\'s frozen figures (by cost center, P&L class, provider, the accrual, the notes\' figures) and their sha256; Landledger answers 404 before the accrual is accepted',
            action: 'Get a month\'s frozen snapshot',
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
        default: 'submitDraft',
        displayOptions: { show: { resource: ['note'] } },
        options: [
          {
            name: 'Figures',
            value: 'getFigures',
            description: 'The notes a closing month needs (the whole month and each cost center) with the figures each may cite: actual, budget, the day-10 forecast, variances and the drivers',
            action: 'Get the figures notes may cite',
            idempotent: true,
            toolAnnotations: { readOnlyHint: true },
          },
          {
            name: 'Submit Draft',
            value: 'submitDraft',
            description: 'Send a draft of one variance note with the figures it cites; Landledger refuses a figure that differs from the frozen snapshot (422), and only a person accepts a note',
            action: 'Submit a variance note draft',
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getSeats',
        displayOptions: { show: { resource: ['contract'] } },
        options: [
          {
            name: 'Seats',
            value: 'getSeats',
            description: 'The contract that grants a Landbright app, its price per seat a month and the seats left (found: false when no contract names the app)',
            action: 'Find a contract\'s seats',
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
          {
            name: 'Window',
            value: 'window',
            description: 'The estimated cost of named services over a time window (each day\'s cost by the share of it inside the window); always labelled estimated',
            action: 'Get the cost of a window',
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
          {
            name: 'Release Seats',
            value: 'releaseSeats',
            description: 'Give a seat request\'s seats back to the contract and release its reservations: access denied, the grant revoked, or not needed',
            action: 'Release a request\'s seats',
          },
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

      // ---- Close → Snapshot, Note → Figures, Submit Draft
      { name: 'month', displayName: 'Month', type: 'string', required: true, default: '', placeholder: '2026-10', displayOptions: show('close', ['getSnapshot']), description: 'YYYY-MM: a month at least as far as the accepted accrual' },
      { name: 'month', displayName: 'Month', type: 'string', required: true, default: '', placeholder: '2026-10', displayOptions: show('note', ['getFigures', 'submitDraft']), description: 'YYYY-MM: the closing month' },
      { name: 'noteCostCenter', displayName: 'Cost Center', type: 'string', required: true, default: '', placeholder: 'ENG-AGENTS', displayOptions: show('note', ['submitDraft']), description: 'The note\'s cost center as Figures names it, or TOTAL for the month as a whole' },
      { name: 'snapshotSha256', displayName: 'Snapshot SHA-256', type: 'string', required: true, default: '', displayOptions: show('note', ['submitDraft']), description: 'The frozen snapshot the draft cites (Figures\' snapshotSha256); Landledger answers 409 when it is no longer the month\'s current one' },
      { name: 'noteText', displayName: 'Text', type: 'string', required: true, default: '', typeOptions: { rows: 6 }, displayOptions: show('note', ['submitDraft']), description: '10-8,000 characters' },
      {
        name: 'cites',
        displayName: 'Cited Figures',
        type: 'json',
        default: '[]',
        displayOptions: show('note', ['submitDraft']),
        description: 'The figures the text uses, each equal to the snapshot\'s to the cent: [{ "figure": "actual", "amount": "1200.50" }, { "figure": "driver_service", "key": "landflow-host", "amount": "310.00" }]. Figures: actual, budget, forecast_day10, variance_budget, variance_forecast, driver_service, driver_agent, driver_model (a driver cites its change against last month)',
      },
      { name: 'noteAgentId', displayName: 'Agent ID', type: 'string', default: '', displayOptions: show('note', ['submitDraft']), description: 'The agent that drafted it (required when an agent calls this tool)' },
      { name: 'noteAgentName', displayName: 'Agent Name', type: 'string', default: '', displayOptions: show('note', ['submitDraft']) },
      { name: 'noteAgentSystem', displayName: 'Agent Runs In', type: 'string', default: 'landflow', displayOptions: show('note', ['submitDraft']) },
      { name: 'noteSponsor', displayName: 'Sponsor', type: 'string', default: '', placeholder: 'eden.tzur@landbright.test', displayOptions: show('note', ['submitDraft']), description: `The person who answers for the agent; never the one who accepts the note. Empty: the key's minter. ${personHint}` },

      // ---- Cost → Window
      { name: 'services', displayName: 'Services', type: 'string', required: true, default: '', placeholder: 'checkout, landflow-host', displayOptions: show('cost', ['window']), description: 'Service names as Landledger\'s Explore names them, comma-separated (at most 50)' },
      { name: 'windowFrom', displayName: 'From', type: 'dateTime', required: true, default: '', displayOptions: show('cost', ['window']), description: 'The start of the window (an ISO date-time)' },
      { name: 'windowTo', displayName: 'To', type: 'dateTime', required: true, default: '', displayOptions: show('cost', ['window']), description: 'The end of the window (an ISO date-time)' },

      // ---- Contract → Seats
      { name: 'landbrightApp', displayName: 'Landbright App', type: 'string', required: true, default: '', placeholder: 'linear', displayOptions: show('contract', ['getSeats']), description: 'The app key a Landledger contract names (its landbrightApp)' },

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
        name: 'seatContractId',
        displayName: 'Seat: Contract ID',
        type: 'string',
        default: '',
        placeholder: 'con_…',
        displayOptions: show('request', ['create'], { kind: ['tool_or_seat'] }),
        description: 'The contract the seat comes from (Contract → Seats gives it). Set, the request carries seat terms: Amount must be Seats × Seat Price, monthly, and approval reserves the seats on the contract. Empty: a tool or seat without a contract',
      },
      { name: 'seats', displayName: 'Seat: Seats', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 100, numberPrecision: 0 }, displayOptions: show('request', ['create'], { kind: ['tool_or_seat'] }) },
      { name: 'seatPrice', displayName: 'Seat: Price per Seat a Month', type: 'string', default: '', placeholder: '12.50', displayOptions: show('request', ['create'], { kind: ['tool_or_seat'] }), description: 'The contract\'s seat price (Contract → Seats)' },
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
          { name: 'landbrightRequestId', displayName: 'Landbright Request', type: 'string', default: '', placeholder: 'REQ-128', description: 'The Landbright access request this cost belongs to (kept as a related source)' },
          { name: 'landbrightRequestUrl', displayName: 'Landbright Request URL', type: 'string', default: '', description: 'Its page in Landbright' },
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
      requestId('request', ['get', 'markApplied', 'releaseSeats']),
      {
        name: 'seatReason',
        displayName: 'Reason',
        type: 'options',
        default: 'access_denied',
        options: [
          { name: 'Access Denied', value: 'access_denied', description: 'The cost was approved but access was not (the seat is still reserved)' },
          { name: 'Grant Revoked', value: 'grant_revoked', description: 'The grant ended early; the only reason Landledger takes for a seat already applied' },
          { name: 'Not Needed', value: 'not_needed', description: 'Nobody needs the seat any more' },
        ],
        displayOptions: show('request', ['releaseSeats']),
      },
      { name: 'seatNote', displayName: 'Note', type: 'string', default: '', displayOptions: show('request', ['releaseSeats']), description: 'Why, for Landledger\'s audit (≤ 1,000 characters)' },
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
    // The notes key (notes:draft only), for the Note resource.
    let notesClient: Landledger | undefined;
    const notes = () => (notesClient ??= new Landledger(api, ctx.getCredentials<LandledgerNotesCredentials>('landledgerNotesKey')));
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      switch (resource) {
        case 'budget':
          if (operation !== 'check') break;
          return checkBudget(ctx, client(), i);
        case 'close':
          if (operation !== 'getSnapshot') break;
          return client().closeSnapshot(monthParameter(requireString(ctx, 'month', 'Month', i), i));
        case 'note':
          if (operation === 'getFigures') return notes().noteFigures(monthParameter(requireString(ctx, 'month', 'Month', i), i));
          if (operation === 'submitDraft') return submitNoteDraft(ctx, notes(), i);
          break;
        case 'contract':
          if (operation !== 'getSeats') break;
          return contractSeats(ctx, client(), i);
        case 'cost':
          if (operation === 'query') return querySpend(ctx, client(), i);
          if (operation === 'window') return costWindow(ctx, client(), i);
          break;
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
    case 'releaseSeats': {
      const id = requireString(ctx, 'requestId', 'Request ID', i);
      const reason = String(ctx.getNodeParameter('seatReason', i, 'access_denied'));
      if (!SEAT_REASONS.includes(reason)) throw new NodeOperationError(`Reason "${reason}" is not one of ${SEAT_REASONS.join(', ')}`, { itemIndex: i });
      return client.releaseSeats(id, { reason, note: optionalString(ctx, 'seatNote', i).slice(0, 1000) });
    }
  }
  throw unsupported('request', operation);
}

const SEAT_REASONS = ['access_denied', 'grant_revoked', 'not_needed'];

/** What a variance note may cite (Landledger's NoteFigure). */
export const NOTE_FIGURES = ['actual', 'budget', 'forecast_day10', 'variance_budget', 'variance_forecast', 'driver_service', 'driver_agent', 'driver_model'];

/** `POST /api/notes/:month/drafts`: one note's draft with its cited figures, the agent and its sponsor, this run. */
async function submitNoteDraft(ctx: IExecuteContext, client: Landledger, i: number): Promise<JsonObject> {
  const month = monthParameter(requireString(ctx, 'month', 'Month', i), i);
  const costCenter = requireString(ctx, 'noteCostCenter', 'Cost Center', i);
  const snapshotSha256 = requireString(ctx, 'snapshotSha256', 'Snapshot SHA-256', i).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(snapshotSha256)) throw new NodeOperationError('Snapshot SHA-256 must be 64 hex characters (Figures\' snapshotSha256)', { itemIndex: i });
  const text = requireString(ctx, 'noteText', 'Text', i);
  if (text.length < 10 || text.length > 8000) throw new NodeOperationError('Text must be 10-8,000 characters', { itemIndex: i });
  const raw = jsonParameter(ctx.getNodeParameter('cites', i, '[]'), 'Cited Figures') ?? [];
  if (!Array.isArray(raw)) throw new NodeOperationError('Cited Figures must be a JSON array of { figure, key?, amount }', { itemIndex: i });
  if (raw.length > 50) throw new NodeOperationError('At most 50 cited figures', { itemIndex: i });
  const cites = raw.map((c, n) => {
    const cite = (c ?? {}) as JsonObject;
    const figure = String(cite.figure ?? '');
    if (!NOTE_FIGURES.includes(figure)) throw new NodeOperationError(`Cited figure ${n + 1}: "${figure}" is not one of ${NOTE_FIGURES.join(', ')}`, { itemIndex: i });
    const micros = toMicros(cite.amount);
    if (micros === undefined) throw new NodeOperationError(`Cited figure ${n + 1} (${figure}): the amount must be a decimal with at most six decimals`, { itemIndex: i });
    const key = cite.key === undefined || cite.key === null ? '' : String(cite.key).trim();
    if (figure.startsWith('driver_') && !key) throw new NodeOperationError(`Cited figure ${n + 1} (${figure}) needs the key of the driver it cites`, { itemIndex: i });
    return { figure, ...(key && { key }), amount: fromMicros(micros) };
  });
  const agentId = optionalString(ctx, 'noteAgentId', i);
  const agentName = optionalString(ctx, 'noteAgentName', i);
  // An agent drafts as itself.
  if (byAgent(ctx) && (!agentId || !agentName)) {
    throw new NodeOperationError('An agent drafts a note as itself: give Agent ID and Agent Name', { itemIndex: i });
  }
  const sponsor = optionalString(ctx, 'noteSponsor', i);
  return client.submitNoteDraft(month, {
    costCenter,
    snapshotSha256,
    text,
    cites,
    ...(agentId && agentName && { agent: { id: agentId, name: agentName, system: optionalString(ctx, 'noteAgentSystem', i) || 'landflow' } }),
    ...(sponsor && { sponsor: personRef(sponsor) }),
    runId: ctx.getExecutionId(),
  });
}

/** An ISO date-time with its offset (`2026-11-14T10:00:00.000Z`) from a date-time parameter. */
function instantParameter(value: unknown, label: string, itemIndex: number): string {
  const text = value === undefined || value === null ? '' : String(value).trim();
  const date = text ? new Date(text) : undefined;
  if (!date || Number.isNaN(date.getTime())) throw new NodeOperationError(`${label} "${text}" is not a date-time`, { itemIndex });
  return date.toISOString();
}

/** `GET /api/cost/window`: the estimated cost of named services between two instants. */
async function costWindow(ctx: IExecuteContext, client: Landledger, i: number): Promise<JsonObject> {
  const services = optionalString(ctx, 'services', i)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!services.length) throw new NodeOperationError('Services: name at least one service', { itemIndex: i });
  if (services.length > 50) throw new NodeOperationError('Services: at most 50', { itemIndex: i });
  const from = instantParameter(ctx.getNodeParameter('windowFrom', i, ''), 'From', i);
  const to = instantParameter(ctx.getNodeParameter('windowTo', i, ''), 'To', i);
  if (from >= to) throw new NodeOperationError('From must be before To', { itemIndex: i });
  return client.costWindow({ services: [...new Set(services)].join(','), from, to });
}

/** `GET /api/contracts/seats`: `{ found, landbrightApp, contract, seatPrice, left }`; a 404 is `found: false`, not an error. */
async function contractSeats(ctx: IExecuteContext, client: Landledger, i: number): Promise<JsonObject> {
  const landbrightApp = requireString(ctx, 'landbrightApp', 'Landbright App', i);
  const answer = await client.contractSeats(landbrightApp);
  if (!answer) return { found: false, landbrightApp, contract: null, seatPrice: null, left: 0 };
  return { found: true, landbrightApp, contract: answer.contract, seatPrice: answer.seatPrice ?? null, left: Number(answer.left ?? 0) };
}

/** The seat terms of a tool_or_seat request (`{ contractId, seats, seatPrice }`), or undefined without a contract. */
function seatTerms(ctx: IExecuteContext, kind: string, i: number): JsonObject | undefined {
  if (kind !== 'tool_or_seat') return undefined;
  const contractId = optionalString(ctx, 'seatContractId', i);
  if (!contractId) return undefined;
  const seats = Math.trunc(Number(ctx.getNodeParameter('seats', i, 1)));
  if (!(seats >= 1 && seats <= 100)) throw new NodeOperationError('Seats must be a whole number from 1 to 100', { itemIndex: i });
  return { contractId, seats, seatPrice: amountParameter(ctx.getNodeParameter('seatPrice', i, ''), 'Seat Price', i) };
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
  const related: JsonObject[] = [];
  if (text('pullRequestUrl')) related.push({ type: 'pull_request', url: text('pullRequestUrl') });
  if (text('landbrightRequestId')) {
    related.push({
      type: 'landbright_request',
      id: text('landbrightRequestId'),
      ...(text('landbrightRequestUrl') && { url: text('landbrightRequestUrl') }),
    });
  }
  const seat = seatTerms(ctx, kind, i);
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
    related,
    ...(seat && { seat }),
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
