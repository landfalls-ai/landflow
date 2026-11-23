/**
 * SB07's scenarios: a request about one step carries a scope (selected, tagged with @, named with "only", or where a new
 * step goes); a change outside it goes back once, then is left out and listed (docs/assistant.md#the-builder-chat). The Bug triage
 * flow and the PR flow are the evaluation's; the unit form scripts a model that wanders first, the live form asks the
 * local model three times.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;
const BUG_TRIAGE = fixture<Workflow>('bug-triage.json');
const BUG_TRIAGE_RUNS = fixture<Record<string, RunDigest>>('bug-triage-runs.json');
const PR_REVIEW = fixture<Workflow>('pr-review.json');

const HTTP = 'Open status incident';
const SAVE = 'Save to backlog';
const node = (o: Outcome, name: string) => o.after?.nodes.find((n) => n.name === name) as ({ maxTries?: number; retryOnFail?: boolean; onError?: string } & Record<string, unknown>) | undefined;
const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
/** Nothing was left out of a card: what was outside the scope was sent back and not proposed again. */
const nothingLeftOut = right('nothing-left-out', 'No change had to be left out', (o) => o.proposals.every((p) => !p.dropped.some((d) => d.startsWith('Left out'))));
const retryOn = (name: string) => right('right-change', `${name} retries 3 times`, (o) => (o.after ? node(o, name)?.maxTries === 3 && node(o, name)?.retryOnFail === true : false));

const retry = (name: string) => ({ op: 'setNodeSettings', node: name, settings: { maxTries: 3, retryOnFail: true } });
const wander = [
  retry(HTTP),
  { op: 'addNode', ref: 'extra', type: 'core.set', name: 'Extra step', after: HTTP },
  { op: 'setNodeSettings', node: SAVE, settings: { onError: 'continue' } },
];

export default defineScenarios([
  {
    id: 'sb07-401-only-selected',
    owner: 'SB07',
    job: 'fix',
    via: 'chat',
    title: '401 on the selected step: only that step changes (a node added and another step changed are sent back)',
    ask: 'this HTTP step fails with 401, fix it',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS },
    script: [
      call('propose_changes', { summary: 'Fix the 401', ops: [{ op: 'setParameters', node: HTTP, parameters: { headers: { header: [{ name: 'X-Api-Key', value: 'secure-test' }] } } }, wander[1], wander[2]] }),
      call('propose_changes', { summary: 'Fix the 401', ops: [{ op: 'setParameters', node: HTTP, parameters: { headers: { header: [{ name: 'X-Api-Key', value: 'secure-test' }] } } }] }),
      { text: 'The status page call sends an API key header now. Apply the card to use it.' },
    ],
    checks: [checks.onlyTouches([HTTP]), nothingLeftOut, checks.proposed, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb07-only-named',
    owner: 'SB07',
    job: 'fix',
    via: 'chat',
    title: 'Named with "only", nothing selected: retry 3 times changes that step alone',
    ask: `only ${HTTP}: retry 3 times`,
    start: { workflow: BUG_TRIAGE },
    script: [
      call('propose_changes', { summary: 'Retry', ops: [retry(HTTP), retry('Parse triage')] }),
      call('propose_changes', { summary: 'Retry', ops: [retry(HTTP)] }),
      { text: 'The status page call retries up to 3 times.' },
    ],
    checks: [checks.onlyTouches([HTTP]), retryOn(HTTP), nothingLeftOut, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb07-tagged',
    owner: 'SB07',
    job: 'fix',
    via: 'chat',
    title: 'Two steps tagged with @: a change to a third is sent back',
    ask: 'make these two steps retry 3 times',
    start: { workflow: BUG_TRIAGE, tagged: [HTTP, 'Post to #oncall'] },
    script: [
      call('propose_changes', { summary: 'Retry', ops: [retry(HTTP), retry('Post to #oncall'), retry(SAVE)] }),
      call('propose_changes', { summary: 'Retry', ops: [retry(HTTP), retry('Post to #oncall')] }),
      { text: 'Both steps retry up to 3 times.' },
    ],
    checks: [checks.onlyTouches([HTTP, 'Post to #oncall']), retryOn(HTTP), retryOn('Post to #oncall'), nothingLeftOut, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb07-insert-after',
    owner: 'SB07',
    job: 'fix',
    via: 'chat',
    title: 'A new agent "after Sample PR" goes there, not after the trigger',
    ask: 'add an agent after “Sample PR” that reviews it',
    start: { workflow: PR_REVIEW },
    script: [
      call('propose_changes', { summary: 'Add a reviewer', ops: [{ op: 'addNode', ref: 'rv', type: 'core.set', name: 'PR reviewer', after: 'Start' }] }),
      call('propose_changes', { summary: 'Add a reviewer', ops: [{ op: 'addNode', ref: 'rv', type: 'core.set', name: 'PR reviewer', after: 'Sample PR' }] }),
      { text: 'The reviewer comes after Sample PR.' },
    ],
    checks: [
      right('placed-after', 'The new step is wired after “Sample PR”', (o) => {
        const wf = o.after;
        const pr = wf?.nodes.find((n) => n.name === 'Sample PR')?.id;
        const added = wf?.nodes.find((n) => !PR_REVIEW.nodes.some((m) => m.id === n.id));
        return wf && pr && added ? wf.connections.some((c) => c.source === pr && c.target === added.id) && !wf.connections.some((c) => c.source !== pr && c.target === added.id) : false;
      }),
      nothingLeftOut,
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'sb07-chip-lifted',
    owner: 'SB07',
    job: 'fix',
    via: 'chat',
    title: 'With the chip lifted, a change to another step goes through',
    ask: 'retry the status incident call 3 times, and let Save to backlog continue on error',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS, scope: null },
    script: [
      call('propose_changes', { summary: 'Retry and continue', ops: [retry(HTTP), { op: 'setNodeSettings', node: SAVE, settings: { onError: 'continue' } }] }),
      { text: 'The status page call retries; Save to backlog continues on error.' },
    ],
    checks: [
      right('both-changed', 'Both steps changed', (o) => (o.after ? node(o, HTTP)?.maxTries === 3 && node(o, SAVE)?.onError === 'continue' : false)),
      nothingLeftOut,
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
]);
