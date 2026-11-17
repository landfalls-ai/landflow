/**
 * SB13's scenarios (wave sb3): the first draft is planned before it is built (docs/assistant.md "Building a flow in
 * stages"). Each is staged: the plan route answers a plan (the script's first replies), then the build route builds that
 * plan. The asks are B1, B4 and B8 of sb00.ts. Unit form: scripted; live form: 3 runs on the local model.
 */
import { checks, defineScenarios, type Check, type Outcome } from './scenario';

const planTypes = (o: Outcome) => o.plan?.steps.map((s) => s.type) ?? [];
const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });

const reply = (value: unknown) => ({ text: JSON.stringify(value) });
/** The build's reply, twice: a node left empty is sent back once, and the model answers the same. */
const twice = (value: unknown) => [reply(value), reply(value)];
const schedule = { unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] } };
const condition = (left: string, operator: string, right: string) => ({ conditions: { condition: [{ left, operator, right }] }, combinator: 'and' });

export default defineScenarios([
  {
    id: 'sb13-linear-plan',
    owner: 'SB13',
    job: 'build',
    via: 'build',
    title: 'B1 planned first: one trigger, Linear, an AI step, Slack and a data table',
    ask: 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table',
    start: { staged: true },
    script: [
      // The first plan has two triggers and a made-up type: it is sent back once with what is wrong.
      reply({
        name: 'Bug triage',
        steps: [
          { key: 's1', type: 'core.manualTrigger', name: 'Start', does: 'Start by hand' },
          { key: 's2', type: 'core.schedule', name: 'Every weekday', does: 'Run every weekday at 8', from: 's1' },
          { key: 's3', type: 'linear.getIssues', name: 'Get bug issues', does: 'Read new Linear issues labelled bug', from: 's2' },
        ],
        assumptions: [],
        cannot: [],
      }),
      reply({
        name: 'Bug triage',
        steps: [
          { key: 's1', type: 'core.schedule', name: 'Every weekday at 8', does: 'Run every weekday at 8', reads: [] },
          { key: 's2', type: 'linear.linear', name: 'Get bug issues', does: 'Read new Linear issues labelled bug', from: 's1' },
          { key: 's3', type: 'core.aiAgent', name: 'Triage each issue', does: 'Give each issue a P0–P3 and a reason', from: 's2', reads: ['title', 'description'] },
          { key: 's4', type: 'core.if', name: 'Is it P0', does: 'Tell P0 from the rest', from: 's3', reads: ['priority'] },
          { key: 's5', type: 'messaging.slack', name: 'Post P0 to Slack', does: 'Post P0s to #oncall', from: 's4', output: 0 },
          { key: 's6', type: 'core.dataTable', name: 'Save the rest', does: 'Put the other issues in a data table', from: 's4', output: 1 },
        ],
        assumptions: ['“every weekday at 8” read as 8:00 on weekdays'],
        cannot: [],
      }),
      // The build of that plan.
      ...twice({
        name: 'Bug triage',
        nodes: [
          { key: 's1', type: 'core.schedule', name: 'Every weekday at 8', parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } },
          { key: 's2', type: 'linear.linear', name: 'Get bug issues', parameters: { resource: 'issue', operation: 'getAll' } },
          { key: 's3', type: 'core.aiAgent', name: 'Triage each issue', parameters: { prompt: 'Triage this issue into P0, P1, P2 or P3 with a reason: {{ $json.title }}' } },
          { key: 's4', type: 'core.if', name: 'Is it P0', parameters: condition('{{ $json.output }}', 'contains', 'P0') },
          { key: 's5', type: 'messaging.slack', name: 'Post P0 to Slack', parameters: { text: '{{ $json.title }}' } },
          { key: 's6', type: 'core.dataTable', name: 'Save the rest', parameters: {} },
        ],
        connections: [{ from: 's1', to: 's2' }, { from: 's2', to: 's3' }, { from: 's3', to: 's4' }, { from: 's4', to: 's5', output: 0 }, { from: 's4', to: 's6', output: 1 }],
        testData: [{ title: 'Login fails', description: 'Cannot sign in' }],
      }),
    ],
    checks: [
      checks.oneTrigger,
      checks.promptUnder(6000),
      right('right-types', 'Right node types in the plan (Linear, Slack, an agent or AI step, a data table)', (o) => {
        const types = planTypes(o);
        return types.some((t) => t.startsWith('linear.')) && types.includes('messaging.slack') && types.some((t) => /aiAgent|messageAgent|runTeam/.test(t)) && types.some((t) => /dataTable/i.test(t));
      }),
      checks.noOutside,
    ],
  },
  {
    id: 'sb13-webhook-plan',
    owner: 'SB13',
    job: 'build',
    via: 'build',
    title: 'B4 planned first: a webhook, an If, two HTTP steps, a Respond',
    ask: 'When a webhook receives an order, if the total is over 1000 POST it to http://127.0.0.1:3399/vip as JSON with a field "vip": true, otherwise POST it to http://127.0.0.1:3399/regular; then respond to the webhook with {"ok": true}',
    start: { staged: true },
    script: [
      reply({
        name: 'Order routing',
        steps: [
          { key: 's1', type: 'core.webhook', name: 'Order received', does: 'Start when a webhook receives an order' },
          { key: 's2', type: 'core.if', name: 'Total over 1000', does: 'Tell VIP orders (over 1000) from the rest', from: 's1', reads: ['body.total'] },
          { key: 's3', type: 'core.httpRequest', name: 'Post VIP order', does: 'POST the order to /vip with vip: true', from: 's2', output: 0 },
          { key: 's4', type: 'core.httpRequest', name: 'Post regular order', does: 'POST the order to /regular', from: 's2', output: 1 },
          { key: 's5', type: 'core.respondToWebhook', name: 'Respond ok', does: 'Answer the webhook with {"ok": true}', from: 's3' },
        ],
        assumptions: ['the answer is sent after the VIP post; the regular branch has none of its own'],
        cannot: [],
      }),
      ...twice({
        name: 'Order routing',
        nodes: [
          { key: 's1', type: 'core.webhook', name: 'Order received', parameters: { path: 'orders', httpMethod: 'POST', responseMode: 'responseNode' } },
          { key: 's2', type: 'core.if', name: 'Total over 1000', parameters: condition('{{ $json.body.total }}', 'gt', '1000') },
          { key: 's3', type: 'core.httpRequest', name: 'Post VIP order', parameters: { method: 'POST', url: 'http://127.0.0.1:3399/vip', sendBody: true, contentType: 'json', body: '{{ { ...$json.body, vip: true } }}' } },
          { key: 's4', type: 'core.httpRequest', name: 'Post regular order', parameters: { method: 'POST', url: 'http://127.0.0.1:3399/regular', sendBody: true, contentType: 'json', body: '{{ $json.body }}' } },
          { key: 's5', type: 'core.respondToWebhook', name: 'Respond ok', parameters: { respondWith: 'json', responseBody: '{"ok": true}' } },
        ],
        connections: [{ from: 's1', to: 's2' }, { from: 's2', to: 's3', output: 0 }, { from: 's2', to: 's4', output: 1 }, { from: 's3', to: 's5' }],
        testData: [{ body: { id: 'o1', total: 1500 } }],
      }),
    ],
    checks: [
      right('one-webhook', 'One trigger, the Webhook, then an If, two HTTP steps and a Respond', (o) => {
        const types = planTypes(o);
        return types[0] === 'core.webhook' && types.filter((t) => /Trigger$|webhook$|schedule$/.test(t)).length === 1 && types.includes('core.if') && types.filter((t) => t === 'core.httpRequest').length === 2 && types.includes('core.respondToWebhook');
      }),
      checks.oneTrigger,
      checks.promptUnder(6000),
      checks.noOutside,
    ],
  },
  {
    id: 'sb13-chat-plan',
    owner: 'SB13',
    job: 'build',
    via: 'build',
    title: 'B8 planned first: a chat trigger, the published agent, no second run of it as the reply',
    ask: 'When a chat message arrives, have my Support triage agent answer it; if it cannot answer, hand it to a person for approval, then reply in the chat',
    start: { staged: true },
    script: [
      reply({
        name: 'Support chat',
        steps: [
          { key: 's1', type: 'core.chatTrigger', name: 'Chat message', does: 'Start when a chat message arrives' },
          { key: 's2', type: 'core.messageAgent', name: 'Support triage', does: 'Have the Support triage agent answer the message', from: 's1' },
          { key: 's3', type: 'core.if', name: 'Could it answer', does: 'Tell an answer from a handover', from: 's2', reads: ['output'] },
        ],
        assumptions: ['a person approves by hand: no approval node was named'],
        cannot: [],
      }),
      ...twice({
        name: 'Support chat',
        nodes: [
          { key: 's1', type: 'core.chatTrigger', name: 'Chat message', parameters: {} },
          { key: 's2', type: 'core.messageAgent', name: 'Support triage', parameters: { message: '{{ $json.chatInput }}' } },
          { key: 's3', type: 'core.if', name: 'Could it answer', parameters: condition('{{ $json.output }}', 'isNotEmpty', '') },
        ],
        connections: [{ from: 's1', to: 's2' }, { from: 's2', to: 's3' }],
        testData: [{ chatInput: 'How do I reset my password?' }],
      }),
    ],
    checks: [
      checks.oneTrigger,
      right('right-types', 'A chat trigger, the agent once, no second agent as the reply', (o) => {
        const types = planTypes(o);
        return types[0] === 'core.chatTrigger' && types.filter((t) => t === 'core.messageAgent').length === 1 && !types.includes('core.aiAgent');
      }),
      checks.promptUnder(6000),
      checks.noOutside,
    ],
  },
  {
    id: 'sb13-cannot',
    owner: 'SB13',
    job: 'build',
    via: 'build',
    title: 'A step no node here does is named, not invented',
    ask: 'Every morning, fetch the status page and post a summary to Microsoft Teams',
    start: { staged: true },
    script: [
      // A made-up Teams node: the plan is sent back, and the second reply names what it cannot do.
      reply({
        name: 'Status to Teams',
        steps: [
          { key: 's1', type: 'core.schedule', name: 'Every morning', does: 'Run every morning' },
          { key: 's2', type: 'core.httpRequest', name: 'Fetch status page', does: 'Fetch the status page', from: 's1' },
          { key: 's3', type: 'teams.postMessage', name: 'Post to Teams', does: 'Post the summary to Microsoft Teams', from: 's2' },
        ],
        assumptions: [],
        cannot: [],
      }),
      reply({
        name: 'Status to Teams',
        steps: [
          { key: 's1', type: 'core.schedule', name: 'Every morning', does: 'Run every morning' },
          { key: 's2', type: 'core.httpRequest', name: 'Fetch status page', does: 'Fetch the status page', from: 's1' },
        ],
        assumptions: ['“every morning” read as 8:00 every day'],
        cannot: ['Post to Microsoft Teams: no Teams node is offered'],
      }),
      ...twice({
        name: 'Status page',
        nodes: [
          { key: 's1', type: 'core.schedule', name: 'Every morning', parameters: schedule },
          { key: 's2', type: 'core.httpRequest', name: 'Fetch status page', parameters: { method: 'GET', url: 'http://127.0.0.1:3399/status' } },
        ],
        connections: [{ from: 's1', to: 's2' }],
        testData: [],
      }),
    ],
    checks: [
      checks.oneTrigger,
      right('cannot-named', 'Names Microsoft Teams as not possible, plans no step for it', (o) => Boolean(o.plan?.cannot.some((c) => /teams/i.test(c))) && !planTypes(o).some((t) => /teams/i.test(t))),
      checks.promptUnder(6000),
      checks.noOutside,
    ],
  },
]);
