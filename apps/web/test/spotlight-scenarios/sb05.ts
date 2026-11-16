/** SB05: a new agent survives a send-back, is placed where asked with its tools, and a parse error is retried. */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, type Check } from './scenario';

const sample = (): Workflow => ({
  id: 'sb05-sample',
  name: 'Sample question',
  nodes: [
    { id: 'n1', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Sample question', type: 'core.set', typeVersion: 1, position: [220, 0], parameters: {} },
    { id: 'n3', name: 'Reply', type: 'core.noOp', typeVersion: 1, position: [440, 0], parameters: {} },
  ],
  connections: [
    { id: 'c1', source: 'n1', target: 'n2', sourceIndex: 0, targetIndex: 0, type: 'main' },
    { id: 'c2', source: 'n2', target: 'n3', sourceIndex: 0, targetIndex: 0, type: 'main' },
  ],
});

const agentOp = { op: 'newAgent', ref: 'docs', name: 'Docs Answerer', description: 'Answers questions from our docs and looks up Linear issues.', instructions: 'Answer from the docs; look up Linear issues when asked.', tools: ['Linear: read issues'], knowledge: 'our product docs', parameters: { message: '{{ $json.question }}' }, after: 'Sample question' };
const newAgents = (o: Parameters<Check['judge']>[0]) => o.proposals.flatMap((p) => p.ops).filter((op) => op.op === 'addNode' && 'newAgent' in op && op.newAgent);
const sole = (o: Parameters<Check['judge']>[0]) => newAgents(o)[0] as undefined | { after?: string; newAgent?: { tools?: string[]; knowledge?: string } };

export default defineScenarios([
  {
    id: 'sb05-docs-linear-agent',
    owner: 'SB05',
    job: 'agent',
    via: 'chat',
    title: 'An agent from the docs with a Linear tool, after Sample question, survives a send-back',
    ask: 'add an agent after Sample question that answers from our docs and can look up Linear issues',
    start: { workflow: sample(), autonomy: 'asks-first' },
    script: [
      call('propose_changes', { summary: 'A docs agent', ops: [agentOp, { op: 'connect', from: 'ghost', to: 'Reply' }] }),
      call('propose_changes', { summary: 'A docs agent', ops: [agentOp] }),
      { text: 'Adds the Docs Answerer agent after Sample question.' },
    ],
    checks: [
      checks.noOutside,
      { id: 'one-proposal', label: 'One change card', judge: (o) => o.proposals.length === 1 },
      { id: 'one-new-agent', label: 'One new agent, not a stand-in', judge: (o) => newAgents(o).length === 1 && !JSON.stringify(o.proposals).includes('core.aiAgent') },
      { id: 'placed-after', label: 'Placed after Sample question', judge: (o) => sole(o)?.after === 'Sample question' },
      { id: 'tool-kept', label: 'Names a Linear tool', judge: (o) => (sole(o)?.newAgent?.tools ?? []).some((t) => /linear/i.test(t)) },
      { id: 'knowledge-kept', label: 'Says what it answers from', judge: (o) => Boolean(sole(o)?.newAgent?.knowledge) },
    ],
  },
  {
    id: 'sb05-parse-retry',
    owner: 'SB05',
    job: 'build',
    via: 'chat',
    title: 'A tool-call parse error after streamed text is asked once more',
    ask: 'add a step called Done after Reply',
    start: { workflow: sample(), autonomy: 'asks-first' },
    script: [
      () => {
        throw new Error('Ollama error: XML syntax error on line 1: unexpected EOF');
      },
      call('propose_changes', { summary: 'Add Done', ops: [{ op: 'addNode', ref: 'd', type: 'core.noOp', name: 'Done', after: 'Reply' }] }),
      { text: 'Adds a Done step after Reply.' },
    ],
    checks: [checks.noOutside, checks.proposed, { id: 'no-error', label: 'No error', judge: (o) => !o.error }],
    live: { skip: 'a parse error cannot be asked for' },
  },
]);
