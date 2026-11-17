/**
 * AG08's scenarios (wave ag2): a design fills a tool's settings honestly and writes real test cases. The scripted architect
 * does what the ag1 run did (an empty To, the node's preset URL, cases that describe their input); the host's design must not
 * keep any of it. The live form asks the real model three times for the first two.
 */
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const NO_CASES = { text: 'No cases.' };
const design = (name: string, instructions: string, nodeTools: string, cases?: string[]) => call('propose_design', { summary: name, name, role: name, instructions, nodeTools, ...(cases && { cases }) });
const detail = (o: Outcome, type: RegExp) => o.agents[0]?.toolsDetail?.find((t) => type.test(t.type ?? ''));

const TRIAGE_ASK = 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, judge how serious it is, and email a short summary to oncall@landflow.test.';
const GRAFANA_ASK = 'Create an agent that tells me which Grafana alerts are firing and what the dashboards show. Its tools are the Grafana plugin’s Get Alerts and Get Alert Details nodes, plus HTTP Request to read the dashboards.';

export default defineScenarios([
  {
    id: 'ag08-triage-email-filled',
    owner: 'AG08',
    job: 'agent',
    via: 'agent-ask',
    title: 'The triager’s Send Email goes to the ask’s address with a subject and body the agent writes; From is left for the person',
    ask: TRIAGE_ASK,
    start: { plugins: ['triage', 'messaging'] },
    script: [
      design('Alert triager', 'Steps:\n1. Call normalize_alert.\n2. Call extract_iocs.\n3. Call send_email with the summary.', 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend', ['Pasted alert about high CPU => Says it is a CPU alert', 'An email => Is short', '<alert> => Summarises it']),
      { text: 'Designed an alert triager.' },
      { text: '[Wazuh] rule 5710 sshd: attempt to login using a non-existent user, src 203.0.113.45 => Names the source address\nGrafana alert HighCPU firing on web-01: cpu 97% for 10m => Says the CPU is saturated\nsshd[2211]: Failed password for root from 203.0.113.45 port 52144 ssh2 => Says it is a brute-force try' },
    ],
    checks: [
      right('to-is-the-ask', 'Send Email’s To is oncall@landflow.test', (o) => detail(o, /emailSend/) === undefined ? false : o.agents[0]?.toolParameters?.[detail(o, /emailSend/)!.name]?.toEmail === 'oncall@landflow.test'),
      right('subject-text-from-ai', 'Send Email’s Subject and Text are $fromAI', (o) => {
        const p = o.agents[0]?.toolParameters?.[detail(o, /emailSend/)?.name ?? ''] ?? {};
        return /\$fromAI\(/.test(String(p.subject)) && /\$fromAI\(/.test(String(p.text));
      }),
      right('needs-from-not-to', 'The card asks for From Email and not for To Email', (o) => {
        const needs = o.card?.needs ?? [];
        return needs.some((n) => /From Email/.test(n)) && !needs.some((n) => /To Email/.test(n));
      }),
      checks.destinationsGiven(TRIAGE_ASK),
      checks.caseInputsReal,
      checks.noOutside,
    ],
  },
  {
    id: 'ag08-grafana-no-preset-url',
    owner: 'AG08',
    job: 'agent',
    via: 'agent-ask',
    title: 'The Grafana agent’s HTTP Request keeps no URL the ask lacks: the URL is empty and the card asks for it',
    ask: GRAFANA_ASK,
    start: { plugins: ['grafana'] },
    script: [design('Grafana alerts agent', 'Steps:\n1. Call get_alerts.\n2. Call get_alert_details for each.', 'grafana.getAlerts, grafana.getAlertDetails, core.httpRequest'), { text: 'Designed a Grafana agent.' }, NO_CASES],
    checks: [
      checks.destinationsGiven(GRAFANA_ASK),
      right('http-url-empty', 'HTTP Request’s URL is empty and the card asks for it', (o) => {
        const http = detail(o, /httpRequest/);
        if (!http) return 'n/a';
        return !o.agents[0]?.toolParameters?.[http.name]?.url && (o.card?.needs ?? []).some((n) => /URL/.test(n));
      }),
      checks.noOutside,
    ],
  },
  {
    id: 'ag08-ack-not-a-need',
    owner: 'AG08',
    job: 'agent',
    via: 'agent-ask',
    title: 'Acknowledge Alert’s Alert ID is filled on each call: the card does not ask the person for it',
    ask: 'Create an agent that tells me which Grafana alerts are firing and lets me acknowledge an alert in Grafana. Its tools are the Grafana plugin’s Get Alerts and Acknowledge Alert nodes.',
    start: { plugins: ['grafana'] },
    script: [design('Grafana alerts agent', 'Steps:\n1. Call get_alerts.\n2. Call acknowledge_alert for the one I name.', 'grafana.getAlerts, grafana.acknowledgeAlert'), { text: 'Designed a Grafana agent.' }, NO_CASES],
    checks: [
      right('ack-on-card', 'Acknowledge Alert is on the agent', (o) => Boolean(detail(o, /acknowledgeAlert/))),
      right('no-alert-id-need', 'The card does not ask to fill in Alert ID', (o) => !(o.card?.needs ?? []).some((n) => /Alert ID/i.test(n))),
      checks.noOutside,
    ],
    live: { skip: 'unit form only' },
  },
  {
    id: 'ag08-cases-real',
    owner: 'AG08',
    job: 'agent',
    via: 'agent-ask',
    title: 'The utility helper’s test cases are inputs a person would send, not descriptions of them',
    ask: 'Create an agent that decodes JWTs, hashes strings, makes UUIDs and slugifies titles.',
    start: { plugins: ['go-crypto', 'text-toolkit'] },
    script: [
      design('Utility helper', 'Steps:\n1. Decode with jwt_decode.\n2. Hash with hash.', 'go-crypto.jwtDecode', ['A JWT token => Decodes it', 'Some text to hash => Gives the hash', 'A title => Gives the slug']),
      { text: 'Designed a utility helper.' },
      { text: 'Decode eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig => Shows the claims, sub is u1\nHash the text hello world with sha256 => Gives b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9\nMake a slug of the title Q3 Planning: Roadmap & Risks! => q3-planning-roadmap-risks' },
    ],
    checks: [checks.caseInputsReal, checks.noOutside],
    live: { skip: 'unit form only' },
  },
]);
