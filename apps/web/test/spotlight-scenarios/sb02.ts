/**
 * SB02: the draft's guards match the chat's. Scripted (unit) answers are the evaluation's recorded drafts, made up from
 * the trial record; the live form asks the local model. Types: ./scenario.ts (a copy of the contract).
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const left = (o: Outcome) => (((o.draft ?? {}) as { left?: Array<{ node: string; field?: string; kind: string }> }).left ?? []);
const nodesOf = (o: Outcome) => (((o.draft ?? {}) as { nodes?: Array<{ type: string; name: string; parameters?: Record<string, unknown> }> }).nodes ?? []);

const madeUpGone: Check = {
  id: 'ids-asked-not-made-up',
  label: 'No address or table the ask did not give',
  judge: (o) => {
    const text = JSON.stringify(nodesOf(o).map((n) => n.parameters ?? {}));
    return !/made-up\.example|dt_bug_triage/.test(text) && left(o).filter((l) => l.kind === 'made-up').length >= 2;
  },
};
const oneTrigger: Check = { id: 'no-junk-nodes', label: 'One trigger', judge: (o) => nodesOf(o).filter((n) => /trigger|schedule|webhook/i.test(n.type)).length === 1 };

const flow = (): Workflow => ({
  id: 'wf_vip',
  name: 'Notify',
  nodes: [
    { id: 'n1', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Notify VIP', type: 'core.httpRequest', typeVersion: 1, position: [240, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3403/vip' } },
  ],
  connections: [{ id: 'c1', type: 'main', source: 'n1', target: 'n2', sourceIndex: 0, targetIndex: 0 }],
} as unknown as Workflow);

export default defineScenarios([
  {
    id: 'sb02-linear-made-up',
    owner: 'SB02',
    job: 'build',
    via: 'build',
    title: 'A draft does not invent an address or a table (core types only: the unit harness registers the core plugin; the live form can use Slack and Linear)',
    ask: 'Every morning, get the new bugs and post a summary to Slack, and save each bug to a table',
    script: [
      {
        text: JSON.stringify({
          name: 'Bug digest',
          nodes: [
            { key: 't', type: 'core.schedule', name: 'Every morning', parameters: {} },
            { key: 'bugs', type: 'core.httpRequest', name: 'Get bugs', parameters: { method: 'GET', url: 'https://made-up.example/bugs?id={{ $json.id }}' } },
            { key: 'save', type: 'core.dataTable', name: 'Save bug', parameters: { operation: 'insert', dataTableId: 'dt_bug_triage' } },
          ],
          connections: [{ from: 't', to: 'bugs' }, { from: 'bugs', to: 'save' }],
        }),
      },
    ],
    checks: [madeUpGone, oneTrigger],
  },
  {
    id: 'sb02-two-triggers',
    owner: 'SB02',
    job: 'build',
    via: 'build',
    title: 'A draft keeps one trigger: the one the ask names',
    ask: 'Every morning, fetch the page and tell me what changed',
    script: [
      {
        text: JSON.stringify({
          name: 'Morning check',
          nodes: [
            { key: 'm', type: 'core.manualTrigger', name: 'Run', parameters: {} },
            { key: 's', type: 'core.schedule', name: 'Every morning', parameters: {} },
            { key: 'a', type: 'core.httpRequest', name: 'Fetch page', parameters: { method: 'GET' } },
          ],
          connections: [{ from: 'm', to: 'a' }, { from: 's', to: 'a' }],
        }),
      },
    ],
    checks: [oneTrigger, { id: 'schedule-kept', label: 'The schedule is the trigger kept', judge: (o) => nodesOf(o).some((n) => n.type === 'core.schedule') && !nodesOf(o).some((n) => n.type === 'core.manualTrigger') }],
  },
  {
    id: 'sb02-chat-url-swap',
    owner: 'SB02',
    job: 'fix',
    via: 'chat',
    title: 'The chat does not swap the person’s URL for one nobody gave',
    ask: 'send this to httpbin instead',
    start: { workflow: flow(), selected: 'Notify VIP', autonomy: 'asks-first' },
    script: [
      call('propose_changes', { summary: 'Send to httpbin', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'https://httpbin.org/post' } }] }),
      { text: 'The address is yours to give: tell me where it should go.' },
    ],
    checks: [
      checks.noOutside,
      {
        id: 'url-kept',
        label: 'No proposal changes the URL',
        judge: (o) => !o.proposals.some((p) => p.ops.some((op) => JSON.stringify(op).includes('httpbin'))),
      },
    ],
  },
]);
