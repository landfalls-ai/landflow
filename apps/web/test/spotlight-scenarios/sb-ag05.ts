/**
 * AG05's scenarios (wave ag1): an honest smoke test (docs/assistant.md "Agents and teams", decision D3). A new agent whose
 * tool needs a credential nobody picked is not tested ("needs a credential: <tool>", no model call) and not published; a
 * tool that puts out nothing fails the test however fluent the reply; a write that needs approval is denied in the test, the
 * reply says so, and that is a pass with the write named. The unit form runs stand-in tools (`ag05stand`, registered by the
 * harness); the first scenario also runs live on the local Grafana plugin.
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const sample = (chatInput: string): Workflow => ({
  id: 'ag05-sample',
  name: 'Sample question',
  nodes: [
    { id: 'n1', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Reply', type: 'core.noOp', typeVersion: 1, position: [220, 0], parameters: {} },
  ],
  connections: [{ id: 'c1', source: 'n1', target: 'n2', sourceIndex: 0, targetIndex: 0, type: 'main' }],
  pinData: { n1: [{ json: { chatInput } }] },
});

const NO_CASES = { text: 'No cases.' };
const design = (name: string, tool: string) =>
  call('propose_design', { summary: name, name, role: 'Watcher', instructions: 'Use your tool, then say what you found.', model: 'ollama/qwen3-coder:30b', nodeTools: `ag05stand.${tool}` });

const notPublished: Check = { id: 'not-published', label: 'Left a draft', judge: (o: Outcome) => o.agents.length > 0 && o.agents.every((a) => !a.published) };

export default defineScenarios([
  {
    id: 'ag05-smoke-needs-credential',
    owner: 'AG05',
    job: 'agent',
    via: 'design',
    title: 'Autonomous: a tool whose required credential is unset leaves the smoke test untested and the agent a draft',
    ask: 'an agent that tells me which Grafana alerts are firing, with Get Alerts',
    start: { workflow: sample('Which alerts are firing?'), autonomy: 'auto', outbound: 'blocked', plugins: ['grafana'] },
    script: [design('Alert watcher', 'alerts'), { text: 'Drafted.' }, NO_CASES, { text: 'Nothing is firing.' }],
    checks: [
      { id: 'smoke-untested', label: 'The smoke test says untested', judge: (o: Outcome) => o.smoke === 'untested' },
      { id: 'needs-a-credential', label: 'It says which tool needs a credential', judge: (o: Outcome) => /^needs a credential: .+/.test(o.smokeReason ?? '') },
      notPublished,
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'ag05-smoke-empty-tools',
    owner: 'AG05',
    job: 'agent',
    via: 'design',
    title: 'Autonomous: a tool that returns nothing fails the smoke test even when the reply is fluent',
    ask: 'an agent that looks things up for me with Hollow Lookup',
    start: { workflow: sample('Look up the latest report.'), autonomy: 'auto', outbound: 'blocked' },
    script: [design('Looker', 'hollow'), { text: 'Drafted.' }, NO_CASES, call('hollow_lookup', {}), { text: 'The latest report is in, and everything in it looks fine.' }],
    checks: [
      { id: 'smoke-failed', label: 'The smoke test failed', judge: (o: Outcome) => o.smoke === 'failed' },
      { id: 'nothing-to-work-with', label: 'It says the tool returned nothing', judge: (o: Outcome) => /returned nothing to work with/.test(o.smokeReason ?? '') && o.smokeTools?.[0]?.status === 'empty' },
      notPublished,
      checks.noOutside,
    ],
    live: { skip: 'a tool that returns nothing is a stand-in; the live form has no such plugin' },
  },
  {
    id: 'ag05-smoke-denied-write',
    owner: 'AG05',
    job: 'agent',
    via: 'design',
    title: 'Asks first: a write the test denied is named, and a reply that says so is a pass',
    ask: 'an agent that sends me a note about each report with Send Note',
    start: { workflow: sample('Note the latest report.'), autonomy: 'asks-first', outbound: 'blocked' },
    script: [design('Noter', 'send'), { text: 'Drafted.' }, NO_CASES, call('send_note', {}), { text: 'I could not send the note without approval; it is ready to go.' }],
    checks: [
      { id: 'smoke-passed', label: 'The smoke test passed', judge: (o: Outcome) => o.smoke === 'passed' },
      { id: 'denied-write-named', label: 'The denied write is in the tools and the reason', judge: (o: Outcome) => o.smokeTools?.some((t) => t.status === 'denied') === true && /needs approval: not sent/.test(o.smokeReason ?? '') },
      notPublished,
      checks.noOutside,
    ],
    live: { skip: 'the write is a stand-in; nothing real is sent in a live run' },
  },
]);
