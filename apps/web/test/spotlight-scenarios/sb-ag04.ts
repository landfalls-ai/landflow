/**
 * AG04: Spotlight changes an agent. A follow-up under a pending agent card revises the card (no plan, no flow); a question
 * under it is answered and changes nothing; on an existing agent's page a change is a card whose Apply saves the draft and
 * publishes nothing (D3). Unit form: the scripted architect; live form: the host's model (contracts/ag1/live-host.md).
 */
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });

/** SB17's architect asks once more for test cases when the design came with fewer than three: this answer gives none. */
const NO_CASES = { text: 'No cases.' };
const DONE = { text: 'Done.' };
const FOUR_PARTS = 'Input: Each message that reaches it.\nSteps:\n1. Use the tools it has for what the message asks.\n2. Answer from what they return.\nOutput: One short paragraph.\nHand over when: It cannot tell.';
const design = (name: string, nodeTools: string, role = name, instructions = FOUR_PARTS) => call('propose_design', { summary: name, name, role, instructions, nodeTools, model: 'ollama/qwen3-coder:30b' });

const UTILITY = 'Create an agent that decodes JWTs, hashes strings and makes UUIDs';
const hasTool = (o: Outcome, word: string) => o.agents.some((a) => a.tools.some((t) => t.toLowerCase().includes(word)));

/** No plan card, no flow drafted, no change to a canvas: the follow-up never became a build. */
const noPlan = right('no-plan', 'Made no plan and drafted no flow', (o) => o.plan === undefined && o.draft === undefined && o.proposals.length === 0);

const observer = {
  name: 'Grafana observer',
  description: 'Watches Grafana alerts and says which are firing.',
  instructions: 'Input: Each message that reaches it.\nSteps:\n1. Read the firing alerts with Get Alerts.\n2. Say which are firing.\nOutput: One short paragraph.\nHand over when: It cannot tell.',
  icon: 'bot',
  color: '#6366f1',
  model: { provider: 'ollama', model: 'qwen3-coder:30b' },
  tools: [{ id: 'tl_alerts', type: 'node', name: 'get_alerts', description: 'Read the firing Grafana alerts.', nodeType: 'grafana.getAlerts', parameters: {} }],
  skills: [],
  schedules: [],
  channels: [],
  memory: { crossSession: false },
  settings: {},
};

export default defineScenarios([
  {
    id: 'ag04-add-tool-to-card',
    owner: 'AG04',
    job: 'agent',
    via: 'agent-revise',
    title: '"Add Slugify as a tool" under a pending agent card changes the card: no plan, no flow, the card names Slugify',
    ask: 'add Slugify as a tool',
    start: { card: UTILITY, plugins: ['text-toolkit', 'go-crypto'] },
    script: [design('Utility agent', 'go-crypto.hash, go-crypto.uuid, go-crypto.jwtDecode'), DONE, NO_CASES, design('Utility agent', 'go-crypto.hash, go-crypto.uuid, go-crypto.jwtDecode, text-toolkit.slugify'), DONE],
    checks: [
      noPlan,
      right('card-has-slugify', 'The card has Slugify', (o) => hasTool(o, 'slugify')),
      right('changes-name-slugify', 'Its changes name Slugify', (o) => (o.card?.changes ?? []).some((c) => /slugify/i.test(c))),
      checks.noOutside,
    ],
  },
  {
    id: 'ag04-question-under-card',
    owner: 'AG04',
    job: 'agent',
    via: 'agent-revise',
    title: '"Why does it need the Hash tool?" under a pending card is answered; the card and the canvas are as they were',
    ask: 'why does it need the Hash tool?',
    start: { card: UTILITY, plugins: ['go-crypto'] },
    script: [design('Utility agent', 'go-crypto.hash, go-crypto.uuid, go-crypto.jwtDecode'), DONE, NO_CASES, { text: 'It hashes strings: you asked for hashes, and Hash is the tool that makes them.' }],
    checks: [
      checks.answered,
      checks.noChange,
      noPlan,
      right('card-unchanged', 'The card has no changes', (o) => o.card !== undefined && o.card.changes === undefined),
      checks.noOutside,
    ],
  },
  {
    id: 'ag04-change-existing',
    owner: 'AG04',
    job: 'agent',
    via: 'agent-revise',
    title: '"Also let it get one alert’s details" on the Grafana observer’s page: a change card; Apply saves the draft, the published version stays',
    ask: 'also let it get one alert’s details',
    start: { agent: observer, plugins: ['grafana'] },
    script: [design('Grafana observer', 'grafana.getAlerts, grafana.getAlertDetails', 'Grafana observer', observer.instructions), DONE],
    checks: [
      checks.revisedNotPublished,
      right('draft-has-details', 'The draft has Get Alert Details', (o) => hasTool(o, 'alert_details') || hasTool(o, 'alertdetails') || hasTool(o, 'get_alert_details')),
      right('changes-name-details', 'Its changes name Get Alert Details', (o) => (o.card?.changes ?? []).some((c) => /alert details/i.test(c))),
      right('kept-get-alerts', 'It still has Get Alerts', (o) => hasTool(o, 'get_alerts')),
      right('saved-draft', 'Apply saved the draft', (o) => o.revised?.savedDraft === true),
      checks.noOutside,
    ],
  },
]);
