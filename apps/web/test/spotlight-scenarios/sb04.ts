/**
 * SB04's scenarios: a question is answered, not applied (finding 2.1), and Spotlight acts alone only on a brand-new
 * draft (decision D1). The "Bug triage" flow is the evaluation's 9-node flow, inlined (SB00's fixture is not on this
 * package's base); its last run failed at "Open status incident" with a 401. Made-up data only.
 */
import type { Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import { call, checks, defineScenarios, touchedNodes, type Check } from './scenario';

// The working flow the "fix one step" trials start from, and the run digests of its last run (the HTTP step failed with 401).
const BUG_TRIAGE = {
  id: 'draft',
  name: 'Bug triage',
  description: 'Every weekday at 8, triage new Linear bugs: P0s go to Slack #oncall and the status page, the rest to a data table.',
  nodes: [
    { id: 'n_sch', name: 'Weekdays at 8', type: 'core.schedule', typeVersion: 1, position: [0, 200], parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } },
    { id: 'n_lin', name: 'Read Linear bugs', type: 'linear.linear', typeVersion: 1, position: [280, 200], parameters: { authentication: 'apiKey', resource: 'issue', operation: 'getManySince', since: '', returnAll: false, limit: 50, activityOptions: {} } },
    {
      id: 'n_agent', name: 'Triage issue', type: 'core.aiAgent', typeVersion: 1, position: [560, 200],
      parameters: { prompt: 'Triage this bug.\nTitle: {{ $json.title }}\nLabels: {{ $json.raw.labels }}\nReply with JSON only: {"priority":"P0|P1|P2|P3","reason":"one sentence"}', systemMessage: 'You triage bug reports for an on-call team. P0 = outage or data loss, P1 = major feature broken, P2 = minor, P3 = cosmetic.', needsFallback: false, requireApproval: 'none', options: {} },
    },
    { id: 'n_model', name: 'Ollama Chat Model', type: 'core.ollamaChatModel', typeVersion: 1, position: [570, 400], parameters: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder:30b', temperature: 0.2 } },
    { id: 'n_parse', name: 'Parse triage', type: 'core.code', typeVersion: 1, position: [840, 200], parameters: { mode: 'each', codeEach: "const t = JSON.parse($json.output);\nreturn { ...$('Read Linear bugs').item.json, priority: t.priority, reason: t.reason };" } },
    { id: 'n_if', name: 'Is P0?', type: 'core.if', typeVersion: 1, position: [1120, 200], parameters: { conditions: { condition: [{ left: '{{ $json.priority }}', operator: 'equals', right: 'P0' }] }, combinator: 'and' } },
    {
      id: 'n_slack', name: 'Post to #oncall', type: 'messaging.slack', typeVersion: 1, position: [1400, 80], retryOnFail: true, maxTries: 2,
      parameters: { authentication: 'accessToken', resource: 'message', operation: 'post', channelId: '#oncall', text: ':rotating_light: P0 bug: {{ $json.title }}\nWhy: {{ $json.reason }}', blocksUi: '', otherOptions: {} },
    },
    {
      id: 'n_http', name: 'Open status incident', type: 'core.httpRequest', typeVersion: 1, position: [1680, 80],
      parameters: { method: 'POST', url: 'https://status.example.com/api/v1/incidents', authentication: 'none', query: {}, headers: {}, bodyType: 'json', body: '{"title": "{{ $json.title }}", "severity": "critical"}', options: {} },
    },
    {
      id: 'n_dt', name: 'Save to backlog', type: 'core.dataTable', typeVersion: 1, position: [1400, 320],
      parameters: { operation: 'insert', dataTableId: 'dt_BXTqEwfZQl2C', mappingMode: 'autoMapInputData' },
    },
  ],
  connections: [
    { id: 'c1', type: 'main', source: 'n_sch', sourceIndex: 0, target: 'n_lin', targetIndex: 0 },
    { id: 'c2', type: 'main', source: 'n_lin', sourceIndex: 0, target: 'n_agent', targetIndex: 0 },
    { id: 'c3', type: 'ai_languageModel', source: 'n_model', sourceIndex: 0, target: 'n_agent', targetIndex: 0 },
    { id: 'c4', type: 'main', source: 'n_agent', sourceIndex: 0, target: 'n_parse', targetIndex: 0 },
    { id: 'c5', type: 'main', source: 'n_parse', sourceIndex: 0, target: 'n_if', targetIndex: 0 },
    { id: 'c6', type: 'main', source: 'n_if', sourceIndex: 0, target: 'n_slack', targetIndex: 0 },
    { id: 'c7', type: 'main', source: 'n_slack', sourceIndex: 0, target: 'n_http', targetIndex: 0 },
    { id: 'c8', type: 'main', source: 'n_if', sourceIndex: 1, target: 'n_dt', targetIndex: 0 },
  ],
  pinData: {},
  settings: {},
};

const issue = { id: 'iss_1', source: 'linear', kind: 'work.ticket_opened', title: 'ENG-412: Checkout returns 500 for all EU cards', url: 'https://linear.app/acme/issue/ENG-412/checkout-returns-500', raw: { priority: 1, labels: ['bug', 'payments'] } };
const triaged = { ...issue, priority: 'P0', reason: 'Checkout is down for EU customers.' };
const ok = (input: unknown, output: unknown) => ({ status: 'success', durationMs: 120, inputs: [{ count: 1, sample: [input] }], outputs: [{ count: 1, sample: [output] }] });

/** The last run: everything passed up to the HTTP step, which the status page refused with 401. */
const LAST_RUN = {
  n_sch: ok({}, { timestamp: '2026-11-16T08:00:00.000Z' }),
  n_lin: ok({}, issue),
  n_agent: ok(issue, { output: '{"priority":"P0","reason":"Checkout is down for EU customers."}' }),
  n_parse: ok({ output: '{"priority":"P0","reason":"Checkout is down for EU customers."}' }, triaged),
  n_if: { status: 'success', durationMs: 3, inputs: [{ count: 1, sample: [triaged] }], outputs: [{ count: 1, sample: [triaged] }, { count: 0, sample: [] }] },
  n_slack: ok(triaged, { ok: true, channel: 'C0ONCALL', ts: '1763280000.000100' }),
  n_http: {
    status: 'error',
    durationMs: 310,
    error: { message: 'Request failed with status 401', description: '{"error":"unauthorized","message":"Missing or invalid Authorization header. Use: Authorization: Bearer <api token>"}' },
    inputs: [{ count: 1, sample: [{ ok: true, channel: 'C0ONCALL', ts: '1763280000.000100' }] }],
    outputs: [{ count: 0, sample: [] }],
  },
};

const bugTriage = BUG_TRIAGE as unknown as Workflow;
const lastRun = LAST_RUN as unknown as Record<string, RunDigest>;

/** The canvas is what it was: nothing was applied (a card may wait). */
const canvasUnchanged: Check = { id: 'canvas-unchanged', label: 'Left the canvas as it was', judge: (o) => (o.after ? touchedNodes(o.before, o.after).length === 0 : 'n/a') };

const retryOps = [{ op: 'setNodeSettings', node: 'Open status incident', settings: { retryOnFail: true, maxTries: 3 } }];

export default defineScenarios([
  {
    id: 'sb04-why-last-run',
    owner: 'SB04',
    job: 'fix',
    via: 'chat',
    title: 'A question about the last run is answered, never applied',
    ask: 'why did the last run fail?',
    start: { workflow: bugTriage, selected: 'Open status incident', runs: lastRun, autonomy: 'auto' },
    // The model reaches for propose_changes anyway: it is not offered, and the answer follows.
    script: [call('propose_changes', { summary: 'Retried the status call', ops: retryOps }), { text: '“Open status incident” got a 401: the status page wants an API token.' }],
    checks: [checks.answered, checks.noChange, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb04-saved-asks-first',
    owner: 'SB04',
    job: 'fix',
    via: 'chat',
    title: 'On a saved workflow a change is shown and waits for Apply',
    ask: 'make it retry 3 times',
    start: { workflow: bugTriage, selected: 'Open status incident', runs: lastRun, autonomy: 'asks-first' },
    script: [call('propose_changes', { summary: 'Retry the status call 3 times', ops: retryOps }), { text: 'Shows the change: retry 3 times. Apply it to keep it.' }],
    checks: [checks.proposed, canvasUnchanged, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb04-new-draft-removal',
    owner: 'SB04',
    job: 'fix',
    via: 'chat',
    title: 'On a new draft a removal still waits for a click',
    ask: 'remove the HTTP step',
    start: { workflow: bugTriage, runs: lastRun, autonomy: 'auto' },
    script: [call('propose_changes', { summary: 'Removed the status call', ops: [{ op: 'removeNode', node: 'Open status incident' }] }), { text: 'Removes “Open status incident”.' }],
    // The card is there, with its reason; the canvas is not changed until Apply.
    checks: [checks.proposed, canvasUnchanged, checks.noOutside],
    live: { runs: 3 },
  },
]);
