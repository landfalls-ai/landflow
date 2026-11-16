/**
 * SB12's scenarios (wave sb2): a reply is never empty (finding 2.6), a claimed change with no card is caught (2.9), and a
 * step that needs a credential gets a picker on the reply, never one chosen by Spotlight (2.10, decision D2). The "Bug
 * triage" flow is SB00's fixture; its last run failed at "Open status incident" with a 401. Made-up data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import { call, checks, defineScenarios, type Check } from './scenario';

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;
const bugTriage = fixture<Workflow>('bug-triage.json');
const lastRun = fixture<Record<string, RunDigest>>('bug-triage-runs.json');

/** The B4 flow of the evaluation, as the build made it: a webhook, a branch on the total, two POSTs and a response. */
const orders = {
  id: 'wf_b4',
  name: 'Orders',
  active: false,
  nodes: [
    { id: 'o1', name: 'Order', type: 'core.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'order', method: 'POST' } },
    { id: 'o2', name: 'Big order?', type: 'core.if', typeVersion: 1, position: [280, 0], parameters: {} },
    { id: 'o3', name: 'Send VIP', type: 'core.httpRequest', typeVersion: 1, position: [560, -80], parameters: { method: 'POST', url: 'http://127.0.0.1:3402/vip', bodyType: 'json', body: '{"vip": true}' } },
    { id: 'o4', name: 'Send standard', type: 'core.httpRequest', typeVersion: 1, position: [560, 80], parameters: { method: 'POST', url: 'http://127.0.0.1:3402/standard', bodyType: 'json', body: '{}' } },
  ],
  connections: [
    { id: 'c1', type: 'main', source: 'o1', sourceIndex: 0, target: 'o2', targetIndex: 0 },
    { id: 'c2', type: 'main', source: 'o2', sourceIndex: 0, target: 'o3', targetIndex: 0 },
    { id: 'c3', type: 'main', source: 'o2', sourceIndex: 1, target: 'o4', targetIndex: 0 },
  ],
} as unknown as Workflow;

/** The reply is a card or says why nothing changed. */
const cardOrReason: Check = { id: 'card-or-reason', label: 'A card, or “Nothing changed, because …”', judge: (o) => o.proposals.length > 0 || /^Nothing changed, because /.test(o.text.trim()) };

const noClaimWithoutCard: Check = {
  id: 'no-claim-without-card',
  label: 'Claimed no change without a card',
  judge: (o) => o.proposals.length > 0 || !/\bI(?:'ve| have) (?:set|changed|added|updated|fixed)\b|\bnow (?:retries|posts|sends|uses)\b/i.test(o.text),
};

export default defineScenarios([
  {
    id: 'sb12-401-offers-credential',
    owner: 'SB12',
    job: 'fix',
    via: 'chat',
    title: 'The 401 ask offers the credentials to pick and sets none',
    ask: 'this HTTP step fails with 401, fix it',
    start: { workflow: bugTriage, selected: 'Open status incident', runs: lastRun },
    script: [
      call('propose_changes', { summary: 'Authenticate the status call with a header token', ops: [{ op: 'setParameters', node: 'Open status incident', parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } }] }),
      { text: 'The card makes “Open status incident” send a header token; pick which credential it uses.' },
    ],
    checks: [checks.proposed, checks.offeredCredential('Open status incident'), checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb12-never-empty',
    owner: 'SB12',
    job: 'fix',
    via: 'chat',
    title: 'A last step the guards left nothing of still says something',
    ask: 'rename the first step to Start',
    start: { workflow: orders },
    script: [{ text: '<tool_call></tool_call>' }],
    checks: [checks.neverEmpty, { id: 'says-why', label: 'Says why nothing changed', judge: (o) => /^Nothing changed, because /.test(o.text) }, checks.noOutside],
  },
  {
    id: 'sb12-claim-without-card',
    owner: 'SB12',
    job: 'fix',
    via: 'chat',
    title: 'A change claimed with no card is sent back once, then said plainly',
    ask: 'retry the status call 3 times',
    start: { workflow: bugTriage, selected: 'Open status incident', runs: lastRun },
    script: [{ text: "I've set the retry to 3." }, { text: "I've set the retry to 3." }],
    checks: [checks.neverEmpty, noClaimWithoutCard, { id: 'still-no-card', label: 'Says no change card exists', judge: (o) => o.text.includes('(Still no change card') }, checks.noOutside],
  },
  {
    id: 'sb12-whole-order',
    owner: 'SB12',
    job: 'fix',
    via: 'chat',
    title: 'The “send the whole order” ask ends with a card or a reason',
    ask: 'send the whole order in the body, plus vip: true',
    start: { workflow: orders },
    checks: [cardOrReason, checks.neverEmpty, noClaimWithoutCard, checks.noOutside],
    live: { runs: 3 },
  },
]);
