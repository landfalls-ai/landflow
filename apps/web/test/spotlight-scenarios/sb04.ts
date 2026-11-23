/**
 * SB04's scenarios: a question is answered, not applied (finding 2.1), and Spotlight acts alone only on a brand-new
 * draft (decision D1). The "Bug triage" flow is the evaluation's 9-node flow, SB00's fixture; its last run failed at
 * "Open status incident" with a 401. Made-up data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import { call, checks, defineScenarios, touchedNodes, type Check } from './scenario';

// The working flow the "fix one step" trials start from, and the run digests of its last run (the HTTP step failed
// with 401): SB00's fixtures, the same the sb00 scenarios use.
const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;
const bugTriage = fixture<Workflow>('bug-triage.json');
const lastRun = fixture<Record<string, RunDigest>>('bug-triage-runs.json');

/** The canvas is what it was: nothing was applied (a card may wait). */
const canvasUnchanged: Check = { id: 'canvas-unchanged', label: 'Left the canvas as it was', judge: (o) => (o.after ? touchedNodes(o.before, o.after).length === 0 : 'n/a') };

const retryOps = [{ op: 'setNodeSettings', node: 'Open status incident', settings: { retryOnFail: true, maxTries: 3 } }];

export default defineScenarios([
  {
    id: 'sb04-why-last-run',
    owner: 'SB04',
    job: 'fix',
    via: 'chat',
    title: 'A question about the last run is answered, never applied',
    ask: 'why did the last run fail?',
    start: { workflow: bugTriage, selected: 'Open status incident', runs: lastRun, autonomy: 'auto' },
    // The model reaches for propose_changes anyway: it is not offered, and the answer follows.
    script: [call('propose_changes', { summary: 'Retried the status call', ops: retryOps }), { text: '“Open status incident” got a 401: the status page wants an API token.' }],
    checks: [checks.answered, checks.noChange, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb04-saved-asks-first',
    owner: 'SB04',
    job: 'fix',
    via: 'chat',
    title: 'On a saved workflow a change is shown and waits for Apply',
    ask: 'make it retry 3 times',
    start: { workflow: bugTriage, selected: 'Open status incident', runs: lastRun, autonomy: 'asks-first' },
    script: [call('propose_changes', { summary: 'Retry the status call 3 times', ops: retryOps }), { text: 'Shows the change: retry 3 times. Apply it to keep it.' }],
    checks: [checks.proposed, canvasUnchanged, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb04-new-draft-removal',
    owner: 'SB04',
    job: 'fix',
    via: 'chat',
    title: 'On a new draft a removal still waits for a click',
    ask: 'remove the HTTP step',
    start: { workflow: bugTriage, runs: lastRun, autonomy: 'auto' },
    script: [call('propose_changes', { summary: 'Removed the status call', ops: [{ op: 'removeNode', node: 'Open status incident' }] }), { text: 'Removes “Open status incident”.' }],
    // The card is there, with its reason; the canvas is not changed until Apply.
    checks: [checks.proposed, canvasUnchanged, checks.noOutside],
    live: { runs: 3 },
  },
]);
