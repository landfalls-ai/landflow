/**
 * SB14's scenarios (wave sb3): stage 2 of a first draft on its own, with the plan given outright (`start.plan`): one
 * small call per step, each checked against that node's docs and the fields it receives, and the wiring from the plan.
 * The plans are the evaluation's asks as a person would agree them (fixtures/sb14-plans.json). Made-up data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_ITEM_SCHEMA } from '@landflow/sdk';
import { checks, defineScenarios, type Check, type Outcome } from './scenario';

const PLANS = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sb14-plans.json'), 'utf8')) as Record<string, Record<string, unknown>>;

type DraftNode = { key: string; type: string; name: string; parameters?: Record<string, unknown> };
const nodesOf = (o: Outcome) => ((o.draft?.nodes as DraftNode[] | undefined) ?? []);
const stagesOf = (o: Outcome) => ((o.draft?.stages as Array<{ stage: string; step?: string }> | undefined) ?? []);
const text = (value: unknown) => JSON.stringify(value ?? {});

/** A parameter value that is a collection with nothing in it: `{ condition: [] }`, `{ rule: { interval: [] } }`, `[]`. */
function hollow(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') {
    const values = Object.values(value);
    return values.length > 0 && values.every((v) => hollow(v));
  }
  return false;
}

const collectionsFilled: Check = {
  id: 'collections-filled',
  label: 'Collections filled (conditions, fields, rules, columns)',
  judge: (o) => (o.after ? !nodesOf(o).some((n) => Object.values(n.parameters ?? {}).some(hollow) || (['core.if', 'core.set'].includes(n.type) && !Object.keys(n.parameters ?? {}).length)) : false),
};

const idsAsked: Check = { id: 'ids-asked', label: 'Ids asked for, not made up', judge: (o) => (o.after ? !/"(C0[0-9A-Z]{8,}|dt_[A-Za-z0-9_]{5,}|T0[0-9A-Z]{8,})"/.test(text(o.after)) : false) };

/** `$json.a.b` roots an expression reads. */
const rootsRead = (value: unknown): string[] => [...text(value).matchAll(/\$json\.([A-Za-z_]\w*)/g)].map((m) => m[1]);

/** The nodes that feed `id`, past the steps that pass items through unchanged (If, Filter, Switch). */
function sourceOf(o: Outcome, id: string): string | undefined {
  const pass = new Set(['core.if', 'core.filter', 'core.switch', 'core.noOp']);
  let at: string | undefined = id;
  for (let hops = 0; at && hops < 10; hops++) {
    const from: string | undefined = o.after?.connections.find((c) => c.target === at && c.type === 'main')?.source;
    const node = o.after?.nodes.find((n) => n.id === from);
    if (!node || !pass.has(node.type)) return node?.id;
    at = node.id;
  }
  return undefined;
}

const AGENT_OUTPUT = ['output', 'sessionId', 'model', 'iterations', 'usage', 'steps', 'fallbackUsed'];
const AGENT_TYPES = new Set(['core.aiAgent', 'core.messageAgent']);

/** The fields a node writes, when known: Linear's schema (and `text`), an agent's output fields; undefined when not known. */
function fieldsOf(node: DraftNode | undefined): Set<string> | undefined {
  if (node?.type === 'linear.linear') return new Set([...Object.keys((ACTIVITY_ITEM_SCHEMA.properties ?? {}) as object), 'text']);
  if (node && AGENT_TYPES.has(node.type)) return new Set(AGENT_OUTPUT);
  return undefined;
}

/**
 * The names a Slack step reads that the step really does not have. `$json.x` is checked against what arrives (its
 * source past If/Filter: Linear's schema, an agent's `output`, `sessionId` ...); `$('Name').item.json.x` against that
 * node's own fields; `$json.lastRun` and `$json.issues` fail unless a Set writes them. Exported for the unit case.
 */
export function badReads(slack: DraftNode, source: DraftNode | undefined, all: DraftNode[]): string[] {
  const written = new Set(all.flatMap((n) => (n.type === 'core.set' ? [...text(n.parameters).matchAll(/"name":"(\w+)"/g)].map((m) => m[1]) : [])));
  const bad: string[] = [];
  const have = fieldsOf(source);
  for (const r of rootsRead(slack.parameters)) {
    if ((r === 'lastRun' || r === 'issues') && !written.has(r)) bad.push(r);
    else if (have && !have.has(r) && !written.has(r)) bad.push(r);
  }
  for (const m of text(slack.parameters).matchAll(/\$\(\\?["']([^"'\\]+)\\?["']\)\.item\.json\.([A-Za-z_]\w*)/g)) {
    const named = fieldsOf(all.find((n) => n.name === m[1]));
    if (named && !named.has(m[2])) bad.push(`${m[1]}.${m[2]}`);
  }
  return bad;
}

const readsRight: Check = {
  id: 'reads-right',
  label: 'The Slack step reads only fields it receives',
  judge: (o) => {
    const slack = nodesOf(o).find((n) => n.type === 'messaging.slack');
    if (!o.after || !slack) return false;
    const source = nodesOf(o).find((n) => n.key === sourceOf(o, slack.key));
    return badReads(slack, source, nodesOf(o)).length === 0;
  },
};

const cronsOf = (o: Outcome) => [...text(nodesOf(o).find((n) => n.type === 'core.schedule')?.parameters).matchAll(/"expression":"([^"]+)"/g)].map((m) => m[1]);
const scheduleOf = (o: Outcome) => nodesOf(o).find((n) => n.type === 'core.schedule')?.parameters;

/** "Every weekday at 8": Monday to Friday at 8:00, as a cron or as a weeks rule. */
const scheduleAsAsked: Check = {
  id: 'schedule-as-asked',
  label: 'Weekdays at 8',
  judge: (o) => {
    const crons = cronsOf(o);
    if (crons.length) return crons.every((c) => /^0 8 \* \* (1-5|1,2,3,4,5|mon-fri)$/i.test(c.trim()));
    const rows = ((scheduleOf(o)?.rule as { interval?: Array<Record<string, unknown>> } | undefined)?.interval ?? []) as Array<Record<string, unknown>>;
    return rows.length > 0 && rows.every((r) => r.field === 'weeks' && Number(r.triggerAtHour) === 8 && [1, 2, 3, 4, 5].every((d) => (r.triggerAtDay as unknown[] | undefined)?.map(Number).includes(d)));
  },
};

/** "Every morning at 8": a daily rule, no day limit. */
const dailyAtEight: Check = {
  id: 'daily-no-day-limit',
  label: 'Every day at 8, no day limit',
  judge: (o) => {
    const crons = cronsOf(o);
    if (crons.length) return crons.every((c) => /^0 8 \* \* \*$/.test(c.trim()));
    const rows = ((scheduleOf(o)?.rule as { interval?: Array<Record<string, unknown>> } | undefined)?.interval ?? []) as Array<Record<string, unknown>>;
    return rows.length > 0 && rows.every((r) => r.field === 'days' && Number(r.daysInterval ?? 1) === 1 && Number(r.triggerAtHour) === 8);
  },
};

const jsonPaths = (value: unknown): string[] => [...text(value).matchAll(/\$json\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g)].map((m) => m[1]);
const reads = (item: unknown, path: string) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), item) !== undefined;

/** B4: both POSTs send the order, and the If reads a field the pinned webhook items really carry. */
const runsRightB4: Check = {
  id: 'runs-right',
  label: 'Runs right with the pinned data',
  judge: (o) => {
    const posts = nodesOf(o).filter((n) => n.type === 'core.httpRequest');
    const ifs = nodesOf(o).filter((n) => n.type === 'core.if');
    if (posts.length !== 2 || !posts.every((n) => /\{\{[^}]*\$json/.test(text(n.parameters))) || ifs.length !== 1) return false;
    if (Object.values(ifs[0].parameters ?? {}).some(hollow)) return false;
    const paths = jsonPaths(ifs[0].parameters);
    const trigger = nodesOf(o).find((n) => n.type === 'core.webhook');
    const pinned = (trigger && o.after?.pinData?.[trigger.key]) || [];
    return paths.length > 0 && pinned.length > 0 && paths.every((path) => pinned.every((item) => reads((item as { json?: unknown }).json, path)));
  },
};

/** B8: the If has a condition, and the agent runs once with its id. */
const runsRightB8: Check = {
  id: 'runs-right',
  label: 'The If has a condition and the agent runs once',
  judge: (o) => {
    const agents = nodesOf(o).filter((n) => n.type === 'core.messageAgent');
    const ifs = nodesOf(o).filter((n) => n.type === 'core.if');
    return agents.length === 1 && Boolean(agents[0].parameters?.agentId) && ifs.length === 1 && !Object.values(ifs[0].parameters ?? {}).some(hollow) && Object.keys(ifs[0].parameters ?? {}).length > 0;
  },
};

/** A build from a plan has exactly the plan's steps, wired as the plan says. */
const planBuilt = (steps: number): Check => ({
  id: 'plan-built',
  label: 'One node per plan step, wired from the plan',
  judge: (o) => nodesOf(o).length === steps && Array.isArray(o.draft?.edges) && (o.draft!.edges as unknown[]).length === steps - 1,
});

/** One call per step, none more: the stages are the plan's steps (and a send-back is that step's alone). */
const oneCallPerStep = (sendBacks: string[] = []): Check => ({
  id: 'one-call-per-step',
  label: 'One call per step; a send-back goes to its step only',
  judge: (o) => {
    const sent = stagesOf(o).filter((s) => s.stage === 'send-back').map((s) => s.step);
    const nodeStages = stagesOf(o).filter((s) => s.stage === 'node');
    return nodeStages.length > 0 && new Set(nodeStages.map((s) => s.step)).size === nodeStages.length && sent.join() === sendBacks.join();
  },
});

const r = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ text: JSON.stringify({ parameters, ...extra }) });
const CONDITION = (left: string, operator: string, right: string) => ({ conditions: { condition: [{ left, operator, right }] }, combinator: 'and' });

export default defineScenarios([
  {
    id: 'sb14-linear-staged',
    owner: 'SB14',
    job: 'build',
    via: 'build',
    title: 'B1 with its plan: every step filled in its own call, the Slack step reads what Linear writes',
    ask: 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table',
    start: { plan: PLANS.b1 },
    script: [
      r({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } }),
      r({ resource: 'issue', operation: 'getManySince' }, { testData: [{ title: 'Crash on save', summary: 'It crashes', url: 'https://example.test/1' }] }),
      r({ prompt: 'Triage this bug into P0, P1, P2 or P3 and say why: {{ $json.title }}. {{ $json.summary }}' }),
      r(CONDITION('{{ $json.output }}', 'contains', 'P0')),
      r({ resource: 'message', operation: 'post', text: '{{ $json.output }}' }),
      r({ operation: 'insert', columns: { column: [{ column: 'title', value: '{{ $json.title }}' }] } }),
    ],
    checks: [planBuilt(6), collectionsFilled, readsRight, scheduleAsAsked, idsAsked, oneCallPerStep(), checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb14-webhook-staged',
    owner: 'SB14',
    job: 'build',
    via: 'build',
    title: 'B4 with its plan: the If has its condition and both POSTs send the whole order',
    ask: 'When a webhook receives an order, if the total is over 1000 POST it to http://127.0.0.1:3399/vip as JSON with a field "vip": true, otherwise POST it to http://127.0.0.1:3399/regular; then respond to the webhook with {"ok": true}',
    start: { plan: PLANS.b4 },
    script: [
      r({ path: 'orders', httpMethod: 'POST' }, { testData: [{ body: { total: 1500 } }, { body: { total: 500 } }] }),
      r(CONDITION('{{ $json.body.total }}', 'gt', '1000')),
      r({ method: 'POST', url: 'http://127.0.0.1:3399/vip', sendBody: true, body: '{{ JSON.stringify({ ...$json.body, vip: true }) }}' }),
      r({ method: 'POST', url: 'http://127.0.0.1:3399/regular', sendBody: true, body: '{{ JSON.stringify($json.body) }}' }),
      r({ respondWith: 'json', responseBody: '{"ok": true}' }),
    ],
    checks: [planBuilt(5), collectionsFilled, runsRightB4, oneCallPerStep(), checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb14-chat-staged',
    owner: 'SB14',
    job: 'build',
    via: 'build',
    title: 'B8 with its plan: the If has a condition and the Support triage agent runs once',
    ask: 'When a chat message arrives, have my Support triage agent answer it; if it cannot answer, hand it to a person for approval, then reply in the chat',
    start: { plan: PLANS.b8 },
    script: [
      r({}),
      r({ agentId: 'Support triage', message: '{{ $json.chatInput }}' }),
      r(CONDITION('{{ $json.output }}', 'contains', 'cannot answer')),
      r({ draft: '{{ $json.output }}', title: 'The agent could not answer' }),
    ],
    checks: [planBuilt(4), collectionsFilled, runsRightB8, oneCallPerStep(), checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb14-morning',
    owner: 'SB14',
    job: 'build',
    via: 'build',
    title: '"Every morning at 8" is a daily rule, with no day limit',
    ask: 'Every morning at 8, set a field greeting to "Good morning"',
    start: { plan: PLANS.morning },
    // The first rule limits the days the request did not name: the schedule check sends it back, and the daily rule stands.
    script: [
      r({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } }),
      r({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } }),
      r({ mode: 'manual', fields: { values: [{ name: 'greeting', type: 'string', value: 'Good morning' }] } }),
    ],
    checks: [planBuilt(2), collectionsFilled, dailyAtEight, oneCallPerStep(['s1']), checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb14-send-back-one-step',
    owner: 'SB14',
    job: 'build',
    via: 'build',
    title: 'The If comes back without a condition: only its call is repeated',
    ask: 'When a webhook receives an order, if the total is over 1000 POST it to http://127.0.0.1:3399/vip, otherwise POST it to http://127.0.0.1:3399/regular; then respond to the webhook',
    start: { plan: PLANS.b4 },
    script: [
      r({ path: 'orders' }, { testData: [{ body: { total: 1500 } }] }),
      { text: '{}' },
      r(CONDITION('{{ $json.body.total }}', 'gt', '1000')),
      r({ method: 'POST', url: 'http://127.0.0.1:3399/vip', sendBody: true, body: '{{ JSON.stringify($json.body) }}' }),
      r({ method: 'POST', url: 'http://127.0.0.1:3399/regular', sendBody: true, body: '{{ JSON.stringify($json.body) }}' }),
      r({ respondWith: 'json', responseBody: '{"ok": true}' }),
    ],
    checks: [
      planBuilt(5),
      collectionsFilled,
      oneCallPerStep(['s2']),
      { id: 'six-calls', label: 'Five steps and one send-back: six calls', judge: (o) => o.modelCalls === 6 },
      checks.noOutside,
    ],
    live: { skip: 'unit only: a scripted empty reply; live, the send-back happens when the model leaves the If empty' },
  },
]);
