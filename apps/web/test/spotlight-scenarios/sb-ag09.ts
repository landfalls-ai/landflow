/**
 * AG09: changing an agent follows the agent. A tool a revise adds gets a step of its own and "(asks first)" when it writes; a
 * pending card's name is the design's name for the tools it has now. Unit form: the scripted architect; live form: the host's
 * model (contracts/ag2/live-host.md). Version 4's fields only (the harness's `agent-revise` via, unchanged).
 */
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });

const NO_CASES = { text: 'No cases.' };
const DONE = { text: 'Done.' };
const design = (name: string, nodeTools: string, instructions: string) => call('propose_design', { summary: name, name, role: name, instructions, nodeTools, model: 'ollama/qwen3-coder:30b' });

const TRIAGE_STEPS = 'Input: an alert.\nSteps:\n1. Normalise it with normalize_alert.\n2. Judge how serious it is.\n3. Tools: normalize_alert; read before you write.\nOutput: a short summary.\nHand over when: it cannot tell.';
const triage = {
  name: 'Alert triage agent',
  description: 'Triages an alert.',
  instructions: TRIAGE_STEPS,
  icon: 'bot',
  color: '#6366f1',
  model: { provider: 'ollama', model: 'qwen3-coder:30b' },
  tools: [{ id: 'tl_norm', type: 'node', name: 'normalize_alert', description: 'Normalise an alert.', nodeType: 'triage.normalizeAlert', parameters: {} }],
  skills: [],
  schedules: [],
  channels: [],
  memory: { crossSession: false },
  settings: {},
};

const observer = {
  name: 'Grafana observer',
  description: 'Watches Grafana alerts and says which are firing.',
  instructions: 'Input: Each message that reaches it.\nSteps:\n1. Read the firing alerts with get_alerts.\n2. Tools: get_alerts.\nOutput: One short paragraph.\nHand over when: It cannot tell.',
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

const UTILITY = 'Create an agent that decodes JWTs, hashes strings and makes UUIDs';
const UTILITY_STEPS = 'Input: a token or text.\nSteps:\n1. Decode, hash or make a UUID as asked.\nOutput: the result.\nHand over when: it is not one of these.';

export default defineScenarios([
  {
    id: 'ag09-revise-adds-step',
    owner: 'AG09',
    job: 'agent',
    via: 'agent-revise',
    title: '"Also pull out the IOCs" on the triage agent: Extract IOCs is added and a step that is not the Tools line calls it',
    ask: 'also pull out the IOCs',
    start: { agent: triage, plugins: ['triage'] },
    script: [design('Alert triage agent', 'triage.normalizeAlert, triage.extractIocs', TRIAGE_STEPS), DONE],
    checks: [
      right('changes-add-extract-iocs', 'Its changes hold "Adds the tool Extract IOCs"', (o) => (o.card?.changes ?? []).includes('Adds the tool Extract IOCs')),
      right('step-calls-extract-iocs', 'A step that is not the Tools line calls extract_iocs', (o) => (o.agents[0]?.instructions ?? '').split('\n').some((l) => /^\d+\. /.test(l) && !/^\d+\. Tools:/.test(l) && /extract_iocs/.test(l))),
      right('kept-normalize', 'It still has Normalize Alert', (o) => o.agents[0]?.tools.includes('normalize_alert') === true),
      checks.revisedNotPublished,
      checks.noOutside,
    ],
  },
  {
    id: 'ag09-ack-asks-first',
    owner: 'AG09',
    job: 'agent',
    via: 'agent-revise',
    title: '"Also let it acknowledge an alert" on the Grafana observer: the change says Acknowledge Alert asks first',
    ask: 'also let it acknowledge an alert',
    start: { agent: observer, plugins: ['grafana'] },
    script: [design('Grafana observer', 'grafana.getAlerts, grafana.acknowledgeAlert', observer.instructions), DONE],
    checks: [
      right('changes-ack-asks-first', 'Its changes hold "Adds the tool Acknowledge Alert (asks first)"', (o) => (o.card?.changes ?? []).includes('Adds the tool Acknowledge Alert (asks first)')),
      right('ack-needs-approval', 'Acknowledge Alert needs approval', (o) => o.agents[0]?.toolsDetail.some((t) => /acknowledge/i.test(t.name) && t.requireApproval) === true),
      checks.revisedNotPublished,
      checks.noOutside,
    ],
  },
  {
    id: 'ag09-name-follows',
    owner: 'AG09',
    job: 'agent',
    via: 'agent-revise',
    title: '"Add Slugify" under the pending utility card: the card is named for the tools it has now, and the Changes row says why',
    ask: 'add Slugify as a tool',
    start: { card: UTILITY, plugins: ['text-toolkit', 'go-crypto'] },
    script: [design('Utility agent', 'go-crypto.hash, go-crypto.uuid, go-crypto.jwtDecode', UTILITY_STEPS), DONE, NO_CASES, design('Utility agent', 'go-crypto.hash, go-crypto.uuid, go-crypto.jwtDecode, text-toolkit.slugify', UTILITY_STEPS), DONE],
    checks: [
      right('named-for-its-tools', 'The card is named for its tools now: Utility helper', (o) => o.agents[0]?.name === 'Utility helper'),
      right('changes-say-why', 'Its changes say the name changed because its tools did', (o) => (o.card?.changes ?? []).includes('Renames it to Utility helper (its tools changed)')),
      right('slugify-has-step', 'A step calls slugify', (o) => (o.agents[0]?.instructions ?? '').split('\n').some((l) => /^\d+\. When /.test(l) && /call slugify/.test(l) && !/`|Pass the|add slugify/i.test(l))),
      checks.noOutside,
    ],
  },
]);
