/**
 * AG19's scenarios (wave ag4): Spotlight reuses an agent the tenant has and says why, or builds one from the tenant's own
 * plugins, an existing knowledge base and the model the person named. The tenant (`start.agents`, `start.knowledgeBases`)
 * is the seeds of contracts/ag4/asks.md: S1 the alert triager, S2 the runbooks agent with its `runbooks` base. Unit form:
 * scripted models; live form: the host's builder model (contracts/ag4/live-host.md).
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const NO_CASES = { text: 'No cases.' };

const tool = (name: string, nodeType: string, extra: Record<string, unknown> = {}) => ({ id: `tl_${name}`, type: 'node', name, description: `Call ${name}`, nodeType, parameters: {}, ...extra });
/** S1: the triage agent (asks.md seeds): normalises, pulls IOCs, emails on-call (asks first). */
const S1 = {
  config: {
    name: 'Alert triager',
    description: 'Triages an alert: normalises it, pulls out the IOCs, judges how serious it is and emails a short summary to oncall@landflow.test.',
    instructions: 'Input: an alert.\nSteps:\n1. Call normalize_alert.\n2. Call extract_iocs.\n3. Call send_email with the summary.\nOutput: a short summary.\nHand over when: the alert is unclear.',
    model: { provider: 'ollama', model: 'qwen3-coder:30b' },
    tools: [tool('normalize_alert', 'triage.normalizeAlert'), tool('extract_iocs', 'triage.extractIocs'), tool('send_email', 'messaging.emailSend', { requireApproval: true, parameters: { toEmail: 'oncall@landflow.test' } })],
  },
};
/** S2: the runbooks agent: its knowledge base `runbooks` (four documents, keyword search) is what a new agent attaches. */
const S2 = {
  config: {
    name: 'Runbook answerer',
    description: 'Answers questions from our incident runbooks and says which runbook each answer comes from.',
    instructions: 'Answer from what search_runbooks returns and name the file each answer comes from.',
    model: { provider: 'ollama', model: 'qwen3-coder:30b' },
    tools: [],
  },
};
const RUNBOOKS = { collection: 'runbooks', folder: 'runbooks', owner: 'Runbook answerer' };

const S1_ASK = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.';
const A_ASK = 'When an alert comes in on our webhook, triage it and email on-call about it.';
const B_ASK = 'I need an agent that reads an alert someone pastes, pulls out the IPs and domains in it, and tells us what our incident runbooks say to do about it. Keep it cheap: Haiku is fine.';

const EMPTY: Workflow = { id: 'ag19-empty', name: 'Untitled workflow', active: false, nodes: [], connections: [], pinData: {}, settings: {} } as unknown as Workflow;

const STEPS = (tools: string) => `Input: what each message brings.\nSteps:\n${tools}\nOutput: a short answer.\nHand over when: it cannot tell.`;
const reuseDesign = (extra: Record<string, unknown> = {}) =>
  call('propose_design', {
    summary: 'Triage agent',
    name: 'Alert triager',
    role: 'Alert triager',
    instructions: STEPS('1. Call normalize_alert.\n2. Call extract_iocs.\n3. Call send_email.'),
    nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend',
    reuseAgentId: 'Alert triager',
    reuseWhy: 'it normalises alerts, pulls out the IOCs, judges them and emails oncall@landflow.test',
    ...extra,
  });

/** The agent id the chat's roster gives (`“Alert triager” (agentId <id>, …`): the scripted model reads it as a real one would. */
const roster = (name: string) => (input: { system?: string }) => {
  const id = new RegExp(`“${name}” \\(agentId (\\S+?),`).exec(input.system ?? '')?.[1] ?? '';
  return call('propose_changes', {
    summary: `Run ${name} on each alert`,
    ops: [
      { op: 'addNode', ref: 'hook', type: 'core.webhook', name: 'Alert webhook' },
      { op: 'addNode', ref: 'triage', type: 'core.messageAgent', name, parameters: { agentId: id, message: '{{ JSON.stringify($json.body) }}' }, after: 'hook' },
    ],
  });
};

export default defineScenarios([
  {
    id: 'ag19-reuse-chat',
    owner: 'AG19',
    job: 'build',
    via: 'chat',
    title: 'A: an alert flow reuses the triage agent the tenant has, makes no agent and says why',
    ask: A_ASK,
    start: { workflow: EMPTY, plugins: ['triage', 'messaging'], agents: [S1] },
    script: [call('list_agents', {}), roster('Alert triager'), { text: 'Reuses “Alert triager”: it already normalises alerts, pulls out the IOCs and emails oncall@landflow.test.' }],
    checks: [checks.reusedAgent('Alert triager'), checks.readTenant(['list_agents']), right('no-send-email-node', 'No Send Email step: the agent sends', (o) => !(o.after?.nodes ?? []).some((n) => /email/i.test(n.type))), checks.noOutside],
  },
  {
    id: 'ag19-reuse-card',
    owner: 'AG19',
    job: 'agent',
    via: 'agent-ask',
    title: 'The triage agent’s own ask typed again: the card offers the agent that exists, Use places it, no agent is made',
    ask: S1_ASK,
    start: { plugins: ['triage', 'messaging'], agents: [S1] },
    script: [reuseDesign(), { text: 'Designed an alert triager.' }, NO_CASES],
    checks: [checks.reusedAgent('Alert triager'), right('reuse-says-why', 'The reply says which agent and why', (o) => /^Reuses “Alert triager”: .+\.$/.test(o.text.split('\n')[0] ?? '')), checks.noOutside],
  },
  {
    id: 'ag19-build-plugin-kb-model',
    owner: 'AG19',
    job: 'agent',
    via: 'agent-ask',
    title: 'B: no agent covers it: the new one gets Extract IOCs, the existing runbooks base as it is and the model the person named (or the host’s, said)',
    ask: B_ASK,
    start: { plugins: ['triage', 'messaging'], agents: [S1, S2], knowledgeBases: [RUNBOOKS] },
    script: [
      call('propose_design', {
        summary: 'IOC and runbook agent',
        name: 'Alert runbook advisor',
        role: 'Alert advisor',
        instructions: STEPS('1. Call extract_iocs on the alert.\n2. Search the runbooks.\n3. Say what they say to do.'),
        nodeTools: 'triage.extractIocs',
        knowledgeBase: 'runbooks',
        model: 'anthropic/claude-haiku-4-5',
      }),
      { text: 'Designed an alert advisor.' },
      NO_CASES,
    ],
    checks: [checks.builtAndPlaced, checks.usesNode('triage.extractIocs'), checks.attachedKnowledge('runbooks'), checks.modelChosen(/haiku/i), right('no-send-email', 'No Send Email: nobody asked to send', (o) => !o.agents.some((a) => (a.toolsDetail ?? []).some((t) => /emailSend/.test(t.type ?? '')))), checks.noOutside],
  },
  {
    id: 'ag19-no-fit-no-reuse',
    owner: 'AG19',
    job: 'agent',
    via: 'agent-ask',
    title: 'An ask no agent covers is built new: the card offers no reuse',
    ask: 'Create an agent that translates our release notes into French.',
    start: { agents: [S1, S2], knowledgeBases: [RUNBOOKS] },
    script: [call('propose_design', { summary: 'Translator', name: 'Release note translator', role: 'Translator', instructions: STEPS('1. Translate the notes into French.'), nodeTools: '' }), { text: 'Designed a translator.' }, NO_CASES],
    checks: [checks.builtAndPlaced, right('no-reuse', 'No reuse offered', (o) => !o.reused), checks.noOutside],
  },
  {
    id: 'ag19-draft-reuse',
    owner: 'AG19',
    job: 'agent',
    via: 'agent-ask',
    title: 'A fitting agent that is only a draft is reused too: placed, and the reply says to publish it first',
    ask: S1_ASK,
    start: { plugins: ['triage', 'messaging'], agents: [{ ...S1, published: false }] },
    script: [reuseDesign(), { text: 'Designed an alert triager.' }, NO_CASES],
    checks: [checks.reusedAgent('Alert triager'), right('publish-first', 'The reply says to publish it first', (o) => /not published yet[^.]*publish/i.test(o.text)), checks.noOutside],
  },
]);
