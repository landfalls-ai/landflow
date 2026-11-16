/**
 * SB01's scenarios: the first draft fills its collections (JSON mode, the draft checked and sent back once), maps a
 * near-miss type, and pins test data for schedule and app triggers.
 */
import { checks, defineScenarios, type Check, type Outcome } from './scenario';

type DraftNodes = Array<{ type: string; name: string; parameters?: Record<string, unknown> }>;
const nodesOf = (o: Outcome) => ((o.draft?.nodes as DraftNodes | undefined) ?? []);
const rows = (value: unknown, group: string) => {
  const list = value && typeof value === 'object' ? (value as Record<string, unknown>)[group] : undefined;
  return Array.isArray(list) ? list.length : 0;
};

const collectionsFilled: Check = {
  id: 'collections-filled',
  label: 'Every If has a condition and every schedule a rule',
  judge: (o) => {
    const nodes = nodesOf(o);
    if (!nodes.length) return false;
    return nodes.every((n) => (n.type === 'core.if' ? rows(n.parameters?.conditions, 'condition') > 0 : n.type === 'core.schedule' && n.parameters?.unit === 'rules' ? rows(n.parameters?.rule, 'interval') > 0 : true));
  },
};
const noEmptyLeft: Check = { id: 'left-no-empty', label: 'Nothing is left empty', judge: (o) => !((o.draft?.left as Array<{ kind: string }> | undefined) ?? []).some((l) => l.kind === 'empty') };
// SB10 (carryover item 4): `draft.calls` is 2 when the first draft was sent back; 1 with nothing empty needed no send-back ('n/a').
const sentBack: Check = {
  id: 'sent-back-once',
  label: 'The draft was sent back once',
  judge: (o) => (o.modelCalls === 1 && !((o.draft?.left as Array<{ kind: string }> | undefined) ?? []).some((l) => l.kind === 'empty') ? 'n/a' : o.modelCalls === 2),
};

const ASK = 'When a webhook receives an order, if body.total is over 1000 POST the whole order with vip: true to http://127.0.0.1:3402/vip, otherwise POST the order to http://127.0.0.1:3402/standard, then respond with ok';
const http = (url: string, body?: string) => ({ url, method: 'POST', ...(body && { bodyType: 'json', body }) });
const draft = (condition: unknown[], withBody: boolean) =>
  JSON.stringify({
    name: 'Orders by size',
    nodes: [
      { key: 'hook', type: 'core.webhook', name: 'Order in', parameters: { path: 'orders' } },
      { key: 'big', type: 'core.if', name: 'Check total', parameters: { conditions: { condition }, combinator: 'and' } },
      { key: 'vip', type: 'core.httpRequest', name: 'Send to VIP', parameters: http('http://127.0.0.1:3402/vip', withBody ? '{{ JSON.stringify({ ...$json.body, vip: true }) }}' : undefined) },
      { key: 'std', type: 'core.httpRequest', name: 'Send to standard', parameters: http('http://127.0.0.1:3402/standard', withBody ? '{{ JSON.stringify($json.body) }}' : undefined) },
      { key: 'ok', type: 'core.respondToWebhook', name: 'Reply ok', parameters: {} },
    ],
    connections: [{ from: 'hook', to: 'big' }, { from: 'big', to: 'vip', output: 0 }, { from: 'big', to: 'std', output: 1 }, { from: 'vip', to: 'ok' }, { from: 'std', to: 'ok' }],
    testData: [{ body: { id: 'o-1', total: 1500 } }, { body: { id: 'o-2', total: 500 } }],
  });

export default defineScenarios([
  {
    id: 'sb01-webhook-branch',
    owner: 'SB01',
    job: 'build',
    via: 'build',
    title: 'A webhook order flow branches on the total with both POSTs filled',
    ask: ASK,
    script: [{ text: draft([], false) }, { text: draft([{ left: '{{ $json.body.total }}', operator: 'gt', right: '1000' }], true) }],
    checks: [collectionsFilled, noEmptyLeft, sentBack, checks.noOutside],
  },
  {
    id: 'sb01-schedule-linear',
    owner: 'SB01',
    job: 'build',
    via: 'build',
    title: 'A weekday schedule reads Linear issues with one rule and sample records pinned',
    ask: 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table',
    checks: [
      collectionsFilled,
      { id: 'test-items-pinned', label: 'Test items are pinned', judge: (o) => Object.keys((o.draft?.pinData as Record<string, unknown> | undefined) ?? {}).length > 0 },
      checks.noOutside,
    ],
    live: { skip: 'needs the Linear plugin in the registry' },
  },
  {
    id: 'sb01-near-miss',
    owner: 'SB01',
    job: 'build',
    via: 'build',
    title: 'core.linear.linear means the Linear plugin\'s linear node',
    ask: 'Get my Linear issues',
    script: [
      { text: JSON.stringify({ name: 'Linear issues', nodes: [{ key: 'a', type: 'core.linear.linear', name: 'Get issues', parameters: {} }], connections: [] }) },
    ],
    checks: [{ id: 'near-miss-mapped', label: 'The step kept, as the linear type', judge: (o) => (nodesOf(o).some((n) => n.name === 'Get issues' && /\.linear$/.test(n.type)) ? true : 'n/a') }],
    live: { skip: 'unit only: needs a fake linear node type registered' },
  },
]);
