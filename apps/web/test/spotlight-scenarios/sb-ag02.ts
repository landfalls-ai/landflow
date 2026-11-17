/**
 * AG02's scenarios (wave ag1): the agent Spotlight designs follows the ask. The four agents of the agents-local session,
 * asked as a person asks: the host's model, the address kept, every asked tool on the agent or said why not, a sensible
 * name, instructions that name only its tools, reads without approval, and no token masking for a job that reads tokens.
 */
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
/** SB17's architect asks once more for test cases when the design came with fewer than three: this answer gives none. */
const NO_CASES = { text: 'No cases.' };
const design = (name: string, instructions: string, nodeTools: string) => call('propose_design', { summary: name, name, role: name, instructions, nodeTools });

/** A name that is a short noun phrase: no article, pronoun or comma, at most 40 characters. */
const nounName = right('name-noun', 'The name has no article, pronoun or comma', (o) => {
  const name = o.agents[0]?.name ?? '';
  return Boolean(name) && name.length <= 40 && !/,/.test(name) && !/^(?:an?|the|me|my|our|its|your|i)\b/i.test(name);
});
const detail = (o: Outcome, type: RegExp) => o.agents[0]?.toolsDetail?.find((t) => type.test(t.type ?? ''));

export default defineScenarios([
  {
    id: 'ag02-triage-email',
    owner: 'AG02',
    job: 'agent',
    via: 'agent-ask',
    title: 'An alert triager that emails oncall@landflow.test: the address whole, Send Email asks first, the other two tools read',
    ask: 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.',
    start: { plugins: ['triage', 'messaging'] },
    script: [design('Alert triager', 'Steps:\n1. Call normalize_alert on the alert.\n2. Call extract_iocs.\n3. Call send_slack_message with the summary.', 'triage.normalizeAlert, triage.extractIocs'), { text: 'Designed an alert triager.' }, NO_CASES],
    checks: [
      checks.keepsText('oncall@landflow.test'),
      checks.askedToolsAccounted(['Normalize Alert', 'Extract IOCs', 'Send Email']),
      checks.toolsNamedReal,
      checks.modelFollowsHost,
      nounName,
      right('send-email-asks-first', 'Send Email asks first; Normalize Alert and Extract IOCs do not', (o) => {
        const mail = detail(o, /emailSend/);
        const others = (o.agents[0]?.toolsDetail ?? []).filter((t) => /triage\./.test(t.type ?? ''));
        return Boolean(mail?.requireApproval) && others.every((t) => !t.requireApproval);
      }),
      checks.noOutside,
    ],
  },
  {
    id: 'ag02-sqlite-analyst',
    owner: 'AG02',
    job: 'agent',
    via: 'agent-ask',
    title: 'A sales data analyst: SQLite reads (select) without approval, Field Statistics and Sentiment added from the ask',
    ask: 'Create an agent that answers questions about our sales table in SQLite, with stats and the sentiment of customer comments. Its tools are the SQLite node from the Databases plugin and the Field Statistics and Sentiment nodes from Insights.',
    start: { plugins: ['databases', 'py-insights'] },
    script: [design('Sales data analyst', 'Steps:\n1. Query the database with query_database.\n2. Report the sentiment.', 'databases.sqlite'), { text: 'Designed a sales analyst.' }, NO_CASES],
    checks: [
      checks.askedToolsAccounted(['SQLite', 'Field Statistics', 'Sentiment']),
      checks.readsWithoutApproval,
      right('sqlite-selects', 'The SQLite tool’s operation is select', (o) => detail(o, /sqlite/)?.operation === 'select'),
      checks.toolsNamedReal,
      checks.modelFollowsHost,
      nounName,
      checks.noOutside,
    ],
  },
  {
    id: 'ag02-grafana-observer',
    owner: 'AG02',
    job: 'agent',
    via: 'agent-ask',
    title: 'A Grafana alerts agent: Get Alerts and Get Alert Details as reads; Acknowledge Alert only when asked',
    ask: 'Create an agent that tells me which Grafana alerts are firing and what the dashboards show. Its tools are the Grafana plugin’s Get Alerts and Get Alert Details nodes, plus HTTP Request to read the dashboards.',
    start: { plugins: ['grafana'] },
    script: [design('Grafana alerts agent', 'Steps:\n1. Call get_alerts.\n2. Call get_alert_details for each.', 'grafana.getAlerts, grafana.acknowledgeAlert'), { text: 'Designed a Grafana agent.' }, NO_CASES],
    checks: [
      checks.askedToolsAccounted(['Get Alerts', 'Get Alert Details', 'HTTP Request']),
      checks.readsWithoutApproval,
      right('no-acknowledge', 'Acknowledge Alert is not on it (the ask never asked)', (o) => !(o.agents[0]?.toolsDetail ?? []).some((t) => /acknowledge/i.test(t.type ?? ''))),
      checks.toolsNamedReal,
      checks.modelFollowsHost,
      nounName,
      checks.noOutside,
    ],
  },
  {
    id: 'ag02-utility-helper',
    owner: 'AG02',
    job: 'agent',
    via: 'agent-ask',
    title: 'A utility helper that reads tokens: JWT Decode, Hash, UUID and Slugify, and no secret masking on its messages',
    ask: 'Create an agent that decodes JWTs, hashes strings, makes UUIDs and slugifies titles.',
    start: { plugins: ['go-crypto', 'text-toolkit'] },
    script: [design('Utility helper', 'Steps:\n1. Decode with jwt_decode.\n2. Hash with hash.', 'go-crypto.jwtDecode'), { text: 'Designed a utility helper.' }, NO_CASES],
    checks: [
      checks.askedToolsAccounted(['JWT Decode', 'Hash', 'UUID', 'Slugify']),
      right('no-input-secrets-rule', 'Its messages are not secret-masked', (o) => !(o.agents[0]?.guardrails ?? []).some((g) => /^Masks secrets in messages/.test(g))),
      checks.toolsNamedReal,
      checks.modelFollowsHost,
      nounName,
      checks.noOutside,
    ],
  },
]);
