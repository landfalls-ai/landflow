/**
 * AG15's scenario (wave ag3): an agent that asks before it writes can pass its eval gate honestly. The triage agent ends in
 * Send Email, which asks first; the gate runs with approvals denied, so every case of that action must expect the ask, not
 * the send, with the address kept exactly. Made-up data only; the unit form scripts the model.
 */
import { listCases } from '@/lib/server/agents/eval-gate';
import { agentStore } from '@/lib/server/agents/store';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const NO_CASES = { text: 'No cases.' };
const ALERT = '[Wazuh] rule 5710 sshd: attempt to login using a non-existent user, src 203.0.113.45';

export default defineScenarios([
  {
    id: 'ag15-triage-cases',
    owner: 'AG15',
    job: 'agent',
    via: 'agent-ask',
    title: 'The triage agent’s Send Email cases expect the approval, not the send, with oncall@landflow.test kept',
    ask: 'Create an agent that triages an alert I paste: normalise it, pull out the IOCs, and email a short summary to oncall@landflow.test.',
    start: { plugins: ['triage', 'messaging'] },
    script: [
      call('propose_design', {
        summary: 'An alert triager',
        name: 'Alert triager',
        role: 'Alert triager',
        instructions: 'Steps:\n1. Call normalize_alert on the alert.\n2. Call extract_iocs.\n3. Call send_email with the summary.',
        nodeTools: 'triage.normalizeAlert, triage.extractIocs, messaging.emailSend',
        cases: [
          `${ALERT} => Emails a short summary to oncall@landflow.test`,
          `${ALERT.replace('5710', '5712')} => Email sent to oncall@landflow.test with the source address`,
          `${ALERT.replace('203.0.113.45', '198.51.100.7')} => Names the source address 198.51.100.7 and says it is a login probe`,
        ].join('\n'),
      }),
      { text: 'Designed an alert triager.' },
      NO_CASES,
    ],
    checks: [
      checks.keepsText('oncall@landflow.test'),
      checks.caseInputsReal,
      right('send-cases-expect-approval', 'Every case about Send Email expects the approval, with oncall@landflow.test as given', (o) => {
        const name = o.agents[0]?.name;
        const id = agentStore.list().find((a) => a.name === name)?.id;
        if (!id) return 'n/a';
        const about = listCases(id).filter((c) => /oncall@landflow\.test/.test(c.expected ?? ''));
        return about.length >= 2 && about.every((c) => /approv/i.test(c.expected ?? '') && !/^(?:emails?|email sent|sends?|sent)\b/i.test(c.expected ?? ''));
      }),
      checks.noOutside,
    ],
  },
]);
