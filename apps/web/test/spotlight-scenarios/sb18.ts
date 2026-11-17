/**
 * SB18's scenarios (wave sb3, decision D3): a new agent is smoke-tested on the item that reaches its step and published
 * only after a pass, only in autonomous mode; a failed test leaves a draft; asks-first never publishes. The harness does
 * what the editor does after the design (the smoke route on the flow's pinned item, then the publish route on a pass).
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, touchedNodes, type Check, type Outcome } from './scenario';

/** The sb05 sample flow with its trigger's chat message pinned: the item that reaches the agent's step. */
const sample = (): Workflow => ({
  id: 'sb18-sample',
  name: 'Sample question',
  nodes: [
    { id: 'n1', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Reply', type: 'core.noOp', typeVersion: 1, position: [220, 0], parameters: {} },
  ],
  connections: [{ id: 'c1', source: 'n1', target: 'n2', sourceIndex: 0, targetIndex: 0, type: 'main' }],
  pinData: { n1: [{ json: { chatInput: 'How long do I have to ask for a refund?' } }] },
});

const ask = 'an agent that answers questions about our refund policy';
/** SB17's architect asks once more for test cases when the design came with fewer than three: this answer gives none (so the eval gate has nothing to run). */
const NO_CASES = { text: 'No cases.' };
const design = () =>
  call('propose_design', { summary: 'A refund policy agent', name: 'Refund policy', role: 'Refund answers', instructions: 'Answer questions about our refund policy in two sentences.', model: 'ollama/qwen3-coder:30b' });

const passed: Check = { id: 'smoke-passed', label: 'The smoke test passed on the sample item', judge: (o: Outcome) => o.smoke === 'passed' };
const publishedAfterPass: Check = { id: 'published-after-pass', label: 'Published, after the pass', judge: (o: Outcome) => o.smoke === 'passed' && o.agents.length > 0 && o.agents.every((a) => a.published) };
const notPublished: Check = { id: 'not-published', label: 'Left a draft', judge: (o: Outcome) => o.agents.length > 0 && o.agents.every((a) => !a.published) };

const smoke = defineScenarios([
  {
    id: 'sb18-smoke-then-publish',
    owner: 'SB18',
    job: 'agent',
    via: 'design',
    title: 'Autonomous: a new agent is run once on the item that reaches its step and published after the pass',
    ask,
    start: { workflow: sample(), autonomy: 'auto', outbound: 'blocked' },
    script: [design(), { text: 'Drafted.' }, NO_CASES, { text: 'You have 14 days from delivery to ask for a refund.' }],
    checks: [passed, publishedAfterPass, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb18-smoke-fails-stays-draft',
    owner: 'SB18',
    job: 'agent',
    via: 'design',
    title: 'Autonomous: a smoke test that errors leaves the agent a draft, never published',
    ask,
    start: { workflow: sample(), autonomy: 'auto', outbound: 'blocked' },
    // The agent's own run errors: the model answers 500.
    script: [
      design(),
      { text: 'Drafted.' },
      NO_CASES,
      () => {
        throw new Error('Ollama error 500: {"error":"the model fell over"}');
      },
    ],
    checks: [{ id: 'smoke-failed', label: 'The smoke test failed', judge: (o: Outcome) => o.smoke === 'failed' }, notPublished, checks.noOutside],
    live: { skip: 'a failing agent run cannot be asked for' },
  },
  {
    id: 'sb18-asks-first-no-publish',
    owner: 'SB18',
    job: 'agent',
    via: 'design',
    title: 'Asks first: the test passes and nothing is published (Publish is the person’s click)',
    ask,
    start: { workflow: sample(), autonomy: 'asks-first', outbound: 'blocked' },
    script: [design(), { text: 'Drafted.' }, NO_CASES, { text: 'You have 14 days from delivery to ask for a refund.' }],
    checks: [passed, notPublished, checks.noOutside],
    live: { runs: 3 },
  },
]);

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, x = 0) => ({ id, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex: 0 });

/** sb03's webhook flow (two local POSTs), the first one answering 404. */
const failing = (): Workflow => ({
  id: 'wf_sb18_webhook',
  name: 'Order routing',
  nodes: [
    node('w', 'Webhook', 'core.webhook', { path: 'orders' }),
    node('v', 'Notify VIP', 'core.httpRequest', { method: 'POST', url: 'http://127.0.0.1:3399/vip?fail=404' }, 280),
    node('s', 'Notify Standard', 'core.httpRequest', { method: 'POST', url: 'http://127.0.0.1:3399/standard' }, 560),
    node('r', 'Respond', 'core.respondToWebhook', {}, 840),
  ],
  connections: [edge('w', 'v'), edge('v', 's'), edge('s', 'r')],
});

export const newDestination = defineScenarios([
  {
    // sb03-new-destination asks the local model to move a step to another host:port; in sb2's and sb3's live runs it fixed the
    // path and kept the port 0 of 5 times, so the row was never reached. This one keeps the product's real session, runner and
    // echo server and scripts only the model's fix (the harness keeps a `-scripted` scenario's script in the live form).
    id: 'sb18-new-destination-scripted',
    owner: 'SB18',
    job: 'fix',
    via: 'session',
    title: 'A fix that moves a step to another host:port asks again, whatever the model proposes (the fix is scripted, the session is real)',
    ask: 'Tell the desk about big orders: Notify VIP for a total over 500, Notify Standard for the rest, then respond.',
    start: { workflow: failing(), autonomy: 'auto', session: 'auto', approvedDestinations: ['127.0.0.1:3399'], sessionRuns: [{ 'Notify VIP': { error: 'HTTP 404 Not Found' } }], outbound: 'allowed' },
    script: [{ text: 'I will test it.' }, call('propose_changes', { summary: 'Set the url', ops: [{ op: 'setParameters', node: 'Notify VIP', parameters: { url: 'http://127.0.0.1:3500/vip' } }] }), { text: 'Changed the address.' }],
    checks: [checks.needs('destination'), { id: 'nothing-sent-there', label: 'Nothing was sent to the new address before the yes', judge: (o: Outcome) => !o.sent.some((s) => s.includes(':3500')) }, checks.noOutside, { id: 'kept-the-flow-shape', label: 'Kept all four steps', judge: (o: Outcome) => touchedNodes(o.before, o.after).every((n) => n === 'Notify VIP') }],
    live: { runs: 3 },
  },
]);

export default [...smoke, ...newDestination];
