/**
 * SB15's scenarios (wave sb3): the first draft's reply is a summary (finding 1.5): the steps in words, what is left
 * (a credential offered, never picked: decision D2) and nothing at all when nothing is. The harness reads a build's text
 * as `summaryText` of the draft's `summary`. Scripted (unit) answers are made-up drafts; the live form asks the local model.
 */
import { checks, defineScenarios, type Check, type Outcome } from './scenario';

interface Item {
  node: string;
  kind: string;
  text: string;
}
const summaryOf = (o: Outcome) => (o.draft?.summary as { steps: string[]; assumptions: string[]; cannot: string[]; left: Item[] } | undefined);
const nodesOf = (o: Outcome) => ((o.draft?.nodes as Array<{ type: string; name: string }> | undefined) ?? []);

/** The summary's left items include a credential item for the step that needs one (the Linear step, when there is one), and the text names it. */
const credentialOffered: Check = {
  id: 'credential-offered',
  label: 'A credential offered for the step that needs it, in the text',
  judge: (o) => {
    const items = (summaryOf(o)?.left ?? []).filter((l) => l.kind === 'credential');
    const linear = nodesOf(o).filter((n) => /^linear\./.test(n.type));
    const forStep = linear.length ? items.filter((l) => linear.some((n) => n.name === l.node)) : items;
    return forStep.length > 0 && forStep.every((l) => o.text.includes(l.text));
  },
};

/** Re-declared (SB00's reads the draft's own `left`): the text itself names what is left, every item of it. */
const leftListed: Check = {
  id: 'left-listed',
  label: 'Said what is left',
  judge: (o) => {
    const left = summaryOf(o)?.left ?? [];
    if (!left.length) return 'n/a';
    return /Left for you/.test(o.text) && left.every((l) => o.text.includes(l.text));
  },
};

const stepsInWords: Check = {
  id: 'steps-in-words',
  label: 'One line per node, in words',
  judge: (o) => {
    const steps = summaryOf(o)?.steps ?? [];
    return steps.length > 0 && steps.length === nodesOf(o).length && steps.every((line, i) => line.startsWith(`${i + 1}. `)) && o.text.includes(steps[0]);
  },
};

const nothingLeft: Check = {
  id: 'nothing-left-said',
  label: 'No “Left for you” block and a text that says something',
  judge: (o) => (summaryOf(o)?.left.length ?? 1) === 0 && !/Left for you/.test(o.text) && o.text.trim().length > 20,
};

const ORDERS = 'When a webhook receives an order, if the total is over 1000 POST it to http://127.0.0.1:3399/vip as JSON with a field "vip": true, otherwise POST it to http://127.0.0.1:3399/regular; then respond to the webhook with {"ok": true}';

export default defineScenarios([
  {
    id: 'sb15-linear-summary',
    owner: 'SB15',
    job: 'build',
    via: 'build',
    title: 'B1: the reply is a summary with the steps in words and a credential offered',
    ask: 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table',
    // The unit form's Linear stand-in has no credential slot, so its scripted "Get issues" is a header-authenticated request; live, the Linear step itself.
    script: [
      {
        text: JSON.stringify({
          name: 'Bug triage',
          nodes: [
            { key: 't', type: 'core.schedule', name: 'Weekdays at 8', parameters: { unit: 'rules', rule: { interval: [{ expression: '0 0 8 * * 1-5', field: 'cronExpression' }] } } },
            { key: 'get', type: 'core.httpRequest', name: 'Get issues', parameters: { method: 'GET', url: 'http://127.0.0.1:3399/issues', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } },
            { key: 'mark', type: 'core.set', name: 'Mark as bug', parameters: { mode: 'manual', fields: { values: [{ name: 'kind', type: 'string', value: 'bug' }] } } },
          ],
          connections: [{ from: 't', to: 'get' }, { from: 'get', to: 'mark' }],
        }),
      },
    ],
    checks: [credentialOffered, leftListed, stepsInWords, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb15-nothing-left',
    owner: 'SB15',
    job: 'build',
    via: 'build',
    title: 'B4 with every field filled: no “Left for you” block and a text that is not empty',
    ask: ORDERS,
    script: [
      {
        text: JSON.stringify({
          name: 'Orders by size',
          nodes: [
            { key: 'hook', type: 'core.webhook', name: 'Order in', parameters: { path: 'orders' } },
            { key: 'big', type: 'core.if', name: 'Check total', parameters: { conditions: { condition: [{ left: '{{ $json.body.total }}', operator: 'gt', right: '1000' }] }, combinator: 'and' } },
            { key: 'vip', type: 'core.httpRequest', name: 'Send to VIP', parameters: { method: 'POST', url: 'http://127.0.0.1:3399/vip', bodyType: 'json', body: '{{ JSON.stringify({ ...$json.body, vip: true }) }}' } },
            { key: 'std', type: 'core.httpRequest', name: 'Send to regular', parameters: { method: 'POST', url: 'http://127.0.0.1:3399/regular', bodyType: 'json', body: '{{ JSON.stringify($json.body) }}' } },
            { key: 'ok', type: 'core.respondToWebhook', name: 'Reply ok', parameters: {} },
          ],
          connections: [{ from: 'hook', to: 'big' }, { from: 'big', to: 'vip', output: 0 }, { from: 'big', to: 'std', output: 1 }, { from: 'vip', to: 'ok' }, { from: 'std', to: 'ok' }],
          testData: [{ body: { id: 'o-1', total: 1500 } }],
        }),
      },
    ],
    checks: [nothingLeft, stepsInWords, checks.noOutside],
    live: { runs: 3 },
  },
]);
