/**
 * SB09: changes that mean what they say. Retry turns on with its tries, a 401 is fixed by a credential and not by a field no item
 * has, a schedule "every morning" has no day limit. The unit form runs the scripts; the live form (3 runs each) asks the model.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;
const BUG_TRIAGE = fixture<Workflow>('bug-triage.json');
const BUG_TRIAGE_RUNS = fixture<Record<string, RunDigest>>('bug-triage-runs.json');

const HTTP = 'Open status incident';
const SCHEDULE = 'Weekdays at 8';
const node = (o: Outcome, name: string) => o.after?.nodes.find((n) => n.name === name);
const right = (id: string, label: string, judge: (o: Outcome) => boolean): Check => ({ id, label, judge });

export default defineScenarios([
  {
    id: 'sb09-retry-three',
    owner: 'SB09',
    job: 'fix',
    via: 'chat',
    title: 'Only that one node: retry 3 times (retry turns on with the tries)',
    ask: 'only that one node: retry 3 times',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS },
    script: [
      call('propose_changes', { summary: 'Retry 3 times', ops: [{ op: 'setNodeSettings', node: HTTP, settings: { maxTries: 3 } }] }),
      { text: 'The card makes “Open status incident” retry up to 3 times. Apply it to turn that on.' },
    ],
    checks: [
      checks.onlyTouches([HTTP]),
      right('right-change', 'Retry is on, with 3 tries', (o) => {
        const n = node(o, HTTP) as { maxTries?: number; retryOnFail?: boolean } | undefined;
        return o.after ? n?.retryOnFail === true && n?.maxTries === 3 : false;
      }),
      checks.proposed,
      checks.noOutside,
    ],
  },
  {
    id: 'sb09-401-no-made-up-header',
    owner: 'SB09',
    job: 'fix',
    via: 'chat',
    title: 'This HTTP step fails with 401: a credential, not a header read from a field no item has',
    ask: 'this HTTP step fails with 401, fix it',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS },
    script: [
      call('propose_changes', {
        summary: 'Send the token',
        ops: [{ op: 'setParameters', node: HTTP, parameters: { headers: { header: [{ name: 'Authorization', value: 'Bearer {{ $json.api_token }}' }] } } }],
      }),
      call('propose_changes', { summary: 'Authenticate with a credential', ops: [{ op: 'setParameters', node: HTTP, parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' } }] }),
      { text: 'The card sets the step to authenticate with a Bearer credential. Pick the credential in its panel.' },
    ],
    checks: [
      checks.onlyTouches([HTTP]),
      right('right-change', 'Authentication set, no made-up field', (o) => {
        if (!o.after) return false;
        const params = JSON.stringify(node(o, HTTP)?.parameters ?? {});
        const before = JSON.stringify(BUG_TRIAGE.nodes.find((n) => n.name === HTTP)?.parameters);
        return o.proposals.length > 0 && params !== before && !/api_token/.test(params) && !/authorization[^}]*\{\{\s*\$json/i.test(params);
      }),
      checks.noOutside,
    ],
  },
  {
    id: 'sb09-every-morning',
    owner: 'SB09',
    job: 'fix',
    via: 'chat',
    title: '"Run it every morning at 8" has no day limit',
    ask: 'run it every morning at 8',
    start: { workflow: BUG_TRIAGE, selected: 'n_sch' },
    script: [
      call('propose_changes', { summary: 'Every morning at 8', ops: [{ op: 'setParameters', node: SCHEDULE, parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } }] }),
      call('propose_changes', { summary: 'Every morning at 8', ops: [{ op: 'setParameters', node: SCHEDULE, parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } } }] }),
      { text: 'The card runs the schedule every day at 8.' },
    ],
    checks: [
      checks.onlyTouches([SCHEDULE]),
      right('right-change', 'Runs every day: no day-of-week limit', (o) => {
        const text = JSON.stringify(node(o, SCHEDULE)?.parameters ?? {});
        const expression = /"expression":"([^"]*)"/.exec(text)?.[1] ?? '';
        return o.after ? expression.trim().split(/\s+/).pop() === '*' && !/mon|tue|wed|thu|fri/i.test(expression) : false;
      }),
      checks.noOutside,
    ],
  },
]);
