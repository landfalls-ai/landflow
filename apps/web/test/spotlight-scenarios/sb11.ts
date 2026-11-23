/** SB11: Spotlight asks when it is not clear (`ask_user`): which step, which channel; never in a test session, never when a step is selected. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios } from './scenario';

const BUG_TRIAGE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'bug-triage.json'), 'utf8')) as Workflow;
const HTTP = 'Open status incident';

export default defineScenarios([
  {
    id: 'sb11-retry-which-step',
    owner: 'SB11',
    job: 'fix',
    via: 'chat',
    title: 'It should retry 3 times (nothing selected): asks which step',
    ask: 'it should retry 3 times',
    start: { workflow: BUG_TRIAGE },
    script: [call('ask_user', { question: 'Which step should retry 3 times?', choices: [HTTP, 'Read Linear bugs'] }), { text: 'unused' }],
    checks: [checks.askedFirst, checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb11-slack-no-channel',
    owner: 'SB11',
    job: 'fix',
    via: 'chat',
    title: 'Post the summary to Slack with no channel known: asks which channel',
    ask: 'post the summary to Slack',
    start: { workflow: BUG_TRIAGE },
    script: [call('ask_user', { question: 'Which Slack channel?', choices: ['#oncall', '#bugs', '#general'] }), { text: 'unused' }],
    checks: [checks.askedFirst],
    live: { runs: 3 },
  },
  {
    id: 'sb11-no-ask-in-session',
    owner: 'SB11',
    job: 'fix',
    via: 'chat',
    title: 'A test-and-fix session is never offered ask_user',
    ask: 'Fix “Open status incident”: it failed with 401.',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', session: 'fix' },
    script: [
      (input) => {
        if (input.tools?.some((t) => t.name === 'ask_user')) throw new Error('ask_user was offered in a test session');
        return call('propose_changes', { summary: 'Set retry on the status call', ops: [{ op: 'setNodeSettings', node: HTTP, settings: { retryOnFail: true, maxTries: 3 } }] });
      },
      { text: 'Retries now.' },
    ],
    checks: [checks.proposed],
    live: { skip: 'a session never asks: unit only' },
  },
  {
    id: 'sb11-not-when-selected',
    owner: 'SB11',
    job: 'fix',
    via: 'chat',
    title: 'It should retry 3 times with the step selected: no question, one change',
    ask: 'it should retry 3 times',
    start: { workflow: BUG_TRIAGE, selected: 'n_http' },
    script: [
      call('propose_changes', { summary: 'Set retry to 3 tries', ops: [{ op: 'setNodeSettings', node: HTTP, settings: { retryOnFail: true, maxTries: 3 } }] }),
      { text: 'The card makes it retry 3 times.' },
    ],
    checks: [checks.proposed, checks.onlyTouches([HTTP])],
    live: { runs: 3 },
  },
]);
