/**
 * AG07's scenarios (wave ag2): the steps name the agent's own tools, and the ask's tools are read whole. The triage ask says
 * "pull out the IOCs": Extract IOCs is on the agent or said under Not added. The Grafana ask's steps hold no node type and no
 * call name the agent lacks. Scenario version 4's fields only.
 */
import { call, checks, defineScenarios, toolKey, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const NO_CASES = { text: 'No cases.' };
const design = (name: string, instructions: string, nodeTools: string) => call('propose_design', { summary: name, name, role: name, instructions, nodeTools });

/** The steps hold no dotted node type (`grafana.getAlerts`, `core.httpRequest`) and no snake_case call name that is not one of the agent's tools. */
const stepsNameOwnTools = right('steps-own-tools', 'The steps name only the agent’s own tools (no node type, no call name it lacks)', (o) => {
  const agent = o.agents[0];
  if (!agent?.instructions) return 'n/a';
  if (/\b(?:core|grafana|triage|messaging|databases|py-insights|go-crypto|text-toolkit)\.[a-z][A-Za-z]+\b/.test(agent.instructions)) return false;
  const own = new Set([...agent.tools, ...(agent.toolsDetail ?? []).map((t) => t.name)].map(toolKey));
  return (agent.instructions.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []).every((n) => own.has(toolKey(n)));
});

export default defineScenarios([
  {
    id: 'ag07-triage-iocs',
    owner: 'AG07',
    job: 'agent',
    via: 'agent-ask',
    title: '"Pull out the IOCs" names Extract IOCs: it is on the agent, or Not added says why',
    ask: 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.',
    start: { plugins: ['triage', 'messaging'] },
    // What the ag1 run did: the architect left Extract IOCs out and wrote a step for a made-up send_summary.
    script: [design('Alert triager', 'Steps:\n1. Call normalize_alert on the alert.\n2. Judge how serious it is.\n3. Call send_summary with the result.', 'triage.normalizeAlert, messaging.emailSend'), { text: 'Designed an alert triager.' }, NO_CASES],
    checks: [
      right('extract-iocs-accounted', 'Extract IOCs is on the agent, or in Not added with a reason', (o) => {
        const onAgent = (o.agents[0]?.toolsDetail ?? []).some((t) => /extractIocs/i.test(t.type ?? ''));
        return onAgent || (o.card?.notAdded ?? []).some((n) => /extract\s*iocs/i.test(n));
      }),
      stepsNameOwnTools,
      checks.toolsNamedReal,
      checks.noOutside,
    ],
  },
  {
    id: 'ag07-grafana-steps',
    owner: 'AG07',
    job: 'agent',
    via: 'agent-ask',
    title: 'A Grafana agent whose steps the model wrote with node types: the steps carry the agent’s call names instead',
    ask: 'Create an agent that tells me which Grafana alerts are firing and what the dashboards show. Its tools are the Grafana plugin’s Get Alerts and Get Alert Details nodes, plus HTTP Request to read the dashboards.',
    start: { plugins: ['grafana'] },
    script: [design('Grafana alerts agent', 'Steps:\n1. Call grafana.getAlerts.\n2. Call grafana.getAlertDetails for each firing alert.\n3. Call core.httpRequest on the dashboard URL.\n4. Say what is firing.', 'grafana.getAlerts, grafana.getAlertDetails, core.httpRequest'), { text: 'Designed a Grafana agent.' }, NO_CASES],
    checks: [
      stepsNameOwnTools,
      right('steps-keep-the-rest', 'The step that calls no tool stays', (o) => /Say what is firing/.test(o.agents[0]?.instructions ?? '')),
      checks.toolsNamedReal,
      checks.noOutside,
    ],
  },
]);
