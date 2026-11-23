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
// Integration (sb3): a planned draft is sent back per step (SB14), so its reading is the build's stages: one `send-back` stage.
const sentBack: Check = {
  id: 'sent-back-once',
  label: 'The draft was sent back once',
  judge: (o) => {
    const emptyLeft = ((o.draft?.left as Array<{ kind: string }> | undefined) ?? []).some((l) => l.kind === 'empty');
    if (o.draft?.plan) {
      const backs = ((o.draft.stages as Array<{ stage: string }> | undefined) ?? []).filter((s) => s.stage === 'send-back').length;
      return backs === 0 && !emptyLeft ? 'n/a' : backs === 1;
    }
    return o.modelCalls === 1 && !emptyLeft ? 'n/a' : o.modelCalls === 2;
  },
};

const ASK = 'When a webhook receives an order, if body.total is over 1000 POST the whole order with vip: true to http://127.0.0.1:3402/vip, otherwise POST the order to http://127.0.0.1:3402/standard, then respond with ok';
const http = (url: string, body?: string) => ({ url, method: 'POST', ...(body && { bodyType: 'json', body }) });

// Integration (sb3): the staged script: the plan, then one reply per step, the If sent back once with its condition.
const reply = (value: unknown) => ({ text: JSON.stringify(value) });
const plan = reply({
  name: 'Orders by size',
  steps: [
    { key: 's1', type: 'core.webhook', name: 'Order in', does: 'Start when a webhook receives an order' },
    { key: 's2', type: 'core.if', name: 'Check total', does: 'Tell orders over 1000 from the rest', from: 's1', reads: ['body.total'] },
    { key: 's3', type: 'core.httpRequest', name: 'Send to VIP', does: 'POST the whole order with vip: true to /vip', from: 's2', output: 0 },
    { key: 's4', type: 'core.httpRequest', name: 'Send to standard', does: 'POST the order to /standard', from: 's2', output: 1 },
    { key: 's5', type: 'core.respondToWebhook', name: 'Reply ok', does: 'Respond with ok', from: 's3' },
  ],
  assumptions: [],
  cannot: [],
});
const stagedScript = [
  plan,
  reply({ parameters: { path: 'orders' }, testData: [{ body: { id: 'o-1', total: 1500 } }, { body: { id: 'o-2', total: 500 } }] }),
  reply({ parameters: { conditions: { condition: [] }, combinator: 'and' } }),
  reply({ parameters: { conditions: { condition: [{ left: '{{ $json.body.total }}', operator: 'gt', right: '1000' }] }, combinator: 'and' } }),
  reply({ parameters: http('http://127.0.0.1:3402/vip', '{{ JSON.stringify({ ...$json.body, vip: true }) }}') }),
  reply({ parameters: http('http://127.0.0.1:3402/standard', '{{ JSON.stringify($json.body) }}') }),
  reply({ parameters: {} }),
];

export default defineScenarios([
  {
    id: 'sb01-webhook-branch',
    owner: 'SB01',
    job: 'build',
    via: 'build',
    title: 'A webhook order flow branches on the total with both POSTs filled',
    ask: ASK,
    script: stagedScript, // Integration (sb3): was the one-shot `[draft(empty If), draft(filled)]`
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
    // Integration (sb3): the plan names the near-miss type; its send-back answers the same, so the plan is repaired in code.
    script: [
      reply({ name: 'Linear issues', steps: [{ key: 's1', type: 'core.manualTrigger', name: 'Start', does: 'Start by hand' }, { key: 's2', type: 'core.linear.linear', name: 'Get issues', does: 'Get my Linear issues', from: 's1' }], assumptions: [], cannot: [] }),
      reply({ name: 'Linear issues', steps: [{ key: 's1', type: 'core.manualTrigger', name: 'Start', does: 'Start by hand' }, { key: 's2', type: 'core.linear.linear', name: 'Get issues', does: 'Get my Linear issues', from: 's1' }], assumptions: [], cannot: [] }),
      reply({ parameters: {} }),
      reply({ parameters: {} }),
    ],
    checks: [{ id: 'near-miss-mapped', label: 'The step kept, as the linear type', judge: (o) => (nodesOf(o).some((n) => n.name === 'Get issues' && /\.linear$/.test(n.type)) ? true : 'n/a') }],
    live: { skip: 'unit only: needs a fake linear node type registered' },
  },
]);
