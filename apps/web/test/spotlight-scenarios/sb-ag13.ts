/**
 * AG13's scenarios (wave ag3): Spotlight gives an agent its knowledge. The ask names a folder: the card lists its files and
 * says how they are searched, and Create indexes only that folder. The ask names none: the card asks for one and nothing is
 * indexed or invented. The runbooks are copied into the test host's files directory before each (the harness). Unit form: the
 * scripted architect; live form: the host's builder model (contracts/ag3/live-host.md).
 */
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const NO_CASES = { text: 'No cases.' };

const STEPS = 'Input: a question about an incident.\nSteps:\n1. Search the runbooks.\n2. Answer from what the search returns.\nOutput: a short answer.\nHand over when: the runbooks do not say.';
const design = () =>
  call('propose_design', { summary: 'Runbook answerer', name: 'Runbook answerer', role: 'Runbook answerer', instructions: STEPS, knowledge: 'runbooks', knowledgeDescription: 'Search the incident runbooks' });

const WITH_FOLDER = 'Create an agent that answers questions from our incident runbooks in the folder runbooks and says which runbook each answer comes from.';
const NO_FOLDER = 'Create an agent that answers questions from our incident runbooks.';

export default defineScenarios([
  {
    id: 'ag13-runbooks-card',
    owner: 'AG13',
    job: 'agent',
    via: 'agent-ask',
    title: 'Answering from the folder runbooks: the card lists its files and keyword search, Create indexes that folder only',
    ask: WITH_FOLDER,
    script: [design(), { text: 'Designed a runbook answerer.' }, NO_CASES],
    checks: [
      checks.agentCard(true),
      checks.knowledgeFromAsk('runbooks'),
      right('knowledge-has-no-add-documents-need', 'The card does not tell the person to add documents', (o) => !(o.card?.needs ?? []).some((n) => /add documents/i.test(n))),
      right('four-files-keyword-search', 'The card lists four files and keyword search when no embeddings model is on this host', (o) => o.card?.knowledge?.files?.length === 4 && o.card.knowledge.search === 'keyword'),
      checks.noOutside,
    ],
  },
  {
    id: 'ag13-no-source',
    owner: 'AG13',
    job: 'agent',
    via: 'agent-ask',
    title: 'Answering from runbooks with no folder named: the card asks which folder, nothing is invented or indexed',
    ask: NO_FOLDER,
    script: [design(), { text: 'Designed a runbook answerer.' }, NO_CASES],
    checks: [checks.agentCard(true), checks.knowledgeAsked, checks.noOutside],
  },
]);
