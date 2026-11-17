/**
 * SB18's scenarios (wave sb3, decision D3): a new agent is smoke-tested on the item that reaches its step and published
 * only after a pass, only in autonomous mode; a failed test leaves a draft; asks-first never publishes. The harness does
 * what the editor does after the design (the smoke route on the flow's pinned item, then the publish route on a pass).
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

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
const design = () =>
  call('propose_design', { summary: 'A refund policy agent', name: 'Refund policy', role: 'Refund answers', instructions: 'Answer questions about our refund policy in two sentences.', model: 'ollama/qwen3-coder:30b' });

const passed: Check = { id: 'smoke-passed', label: 'The smoke test passed on the sample item', judge: (o: Outcome) => o.smoke === 'passed' };
const publishedAfterPass: Check = { id: 'published-after-pass', label: 'Published, after the pass', judge: (o: Outcome) => o.smoke === 'passed' && o.agents.length > 0 && o.agents.every((a) => a.published) };
const notPublished: Check = { id: 'not-published', label: 'Left a draft', judge: (o: Outcome) => o.agents.length > 0 && o.agents.every((a) => !a.published) };

export default defineScenarios([
  {
    id: 'sb18-smoke-then-publish',
    owner: 'SB18',
    job: 'agent',
    via: 'design',
    title: 'Autonomous: a new agent is run once on the item that reaches its step and published after the pass',
    ask,
    start: { workflow: sample(), autonomy: 'auto', outbound: 'blocked' },
    script: [design(), { text: 'Drafted.' }, { text: 'You have 14 days from delivery to ask for a refund.' }],
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
    script: [design(), { text: 'Drafted.' }, { text: 'You have 14 days from delivery to ask for a refund.' }],
    checks: [passed, notPublished, checks.noOutside],
    live: { runs: 3 },
  },
]);
