/**
 * SB16: "create an agent" on any canvas is an agent card to review and create, and on an empty canvas also a starter flow
 * (Chat message, then Run an Agent); the chat's new agent keeps the tools and knowledge the message asked for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, touchedNodes, type Check, type Outcome } from './scenario';

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;
const BUG_TRIAGE = fixture<Workflow>('bug-triage.json');

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
/** No `/api/ai/build` call: nothing was drafted as a flow. */
const noBuild = right('no-build', 'Drafted no flow with the builder', (o) => o.draft === undefined);
const agentExists = right('agent-exists', 'An agent draft was made', (o) => o.agents.length > 0);

const sample = (): Workflow => ({
  id: 'sb16-sample',
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

/** SB17's architect asks once more for test cases when the design came with fewer than three: this answer gives none. */
const NO_CASES = { text: 'No cases.' };
const design = (name: string, role: string, instructions: string) => call('propose_design', { summary: name, name, role, instructions, model: 'ollama/qwen3-coder:30b' });

const newAgents = (o: Outcome) => o.proposals.flatMap((p) => p.ops).filter((op) => op.op === 'addNode' && 'newAgent' in op && op.newAgent);
const sole = (o: Outcome) => newAgents(o)[0] as undefined | { newAgent?: { tools?: string[]; knowledge?: string } };

export default defineScenarios([
  {
    id: 'sb16-pr-reviewer-empty',
    owner: 'SB16',
    job: 'agent',
    via: 'agent-ask',
    title: 'An agent that reviews pull requests, asked on an empty canvas: the card and a starter flow, no flow drafted',
    ask: 'create an agent that reviews pull requests against our practices, and run it after Sample PR',
    script: [design('PR reviewer', 'Pull request reviewer', 'Read the pull request, check it against the practices, comment.'), { text: 'Designed a PR reviewer.' }, NO_CASES],
    checks: [checks.agentCard(true), noBuild, agentExists, checks.noOutside],
  },
  {
    id: 'sb16-agent-on-canvas',
    owner: 'SB16',
    job: 'agent',
    via: 'agent-ask',
    title: 'An agent asked for on the Bug triage flow: a card, the canvas unchanged',
    ask: 'create an agent that summarises incidents for the on-call channel',
    start: { workflow: BUG_TRIAGE },
    script: [design('Incident summariser', 'Incident summariser', 'Summarise each incident for the on-call channel.'), { text: 'Designed an incident summariser.' }, NO_CASES],
    checks: [checks.agentCard(false), noBuild, agentExists, right('canvas-unchanged', 'The canvas is unchanged', (o) => touchedNodes(o.before, o.after).length === 0), checks.noOutside],
  },
  {
    id: 'sb16-not-an-agent-ask',
    owner: 'SB16',
    job: 'agent',
    via: 'agent-ask',
    title: 'The Support triage ask (B8) is a flow, not an agent ask',
    ask: 'When a chat message arrives, have my Support triage agent answer it; if it cannot answer, hand it to a person for approval, then reply in the chat',
    script: [],
    checks: [right('not-an-agent-ask', 'No agent card', (o) => o.card === undefined && o.text === 'not an agent ask'), right('no-agent', 'No agent made', (o) => o.agents.length === 0), checks.noOutside],
  },
  {
    id: 'sb16-question-not-an-agent-ask',
    owner: 'SB16',
    job: 'agent',
    via: 'agent-ask',
    title: '"why did the last run fail?" is a question, not an agent ask',
    ask: 'why did the last run fail?',
    start: { workflow: BUG_TRIAGE },
    script: [],
    checks: [right('not-an-agent-ask', 'No agent card', (o) => o.card === undefined && o.text === 'not an agent ask'), right('no-agent', 'No agent made', (o) => o.agents.length === 0), checks.noOutside],
  },
  {
    id: 'sb16-docs-linear-chat',
    owner: 'SB16',
    job: 'agent',
    via: 'chat',
    title: 'A new agent after Sample question keeps the Linear tool and the docs the message asked for, though the model left them out',
    ask: 'add an agent after Sample question that answers from our docs and can look up Linear issues',
    start: { workflow: sample(), autonomy: 'asks-first' },
    script: [
      call('propose_changes', { summary: 'A docs agent', ops: [{ op: 'newAgent', ref: 'docs', name: 'Docs Answerer', description: 'Answers questions from our docs.', instructions: 'Answer from the docs.', parameters: { message: '{{ $json.question }}' }, after: 'Sample question' }] }),
      { text: 'Adds the Docs Answerer agent after Sample question.' },
    ],
    checks: [
      checks.noOutside,
      right('one-new-agent', 'One new agent', (o) => newAgents(o).length === 1),
      right('tool-kept', 'Names a Linear tool', (o) => (sole(o)?.newAgent?.tools ?? []).some((t) => /linear/i.test(t))),
      right('knowledge-kept', 'Says what it answers from', (o) => Boolean(sole(o)?.newAgent?.knowledge)),
    ],
  },
]);
