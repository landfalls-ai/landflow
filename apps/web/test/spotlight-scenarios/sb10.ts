/**
 * SB10's scenarios (wave sb2): the model sees what it edits. A long Code step keeps its tail when one line changes
 * (finding 2.8), the workflow's own settings can be changed from the chat, and a step after a Linear "create issue" reads
 * a field the operation's output schema names (finding 1.4). Made-up data only. The scripted model reads the system prompt
 * (a function turn), so each scenario fails when the prompt lacks what the person's request needs.
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, x = 0) => ({ id, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex: 0 });

// A Code step of ~4 000 characters: notes first, the label table (the line to change) after the first 2 000 characters,
// then the step's last line, which a model that saw only the first 2 000 characters would lose.
const NOTES = Array.from({ length: 36 }, (_, i) => `// note ${String(i + 1).padStart(2, '0')}: a ticket's priority comes from the triage model; keep the labels below in step with the on-call rota.`).join('\n');
const LAST_LINE = "return { ...$json, label: labels[$json.priority] ?? 'Unknown' };";
const codeWith = (p1: string) => `${NOTES}\nconst labels = {\n  P0: 'Critical',\n  P1: '${p1}',\n  P2: 'Low',\n};\n${LAST_LINE}`;
const CODE = codeWith('Normal');
const CODE_AFTER = codeWith('High');

const triage = (): Workflow => ({
  id: 'wf_sb10_triage',
  name: 'Ticket triage',
  nodes: [node('t', 'Manual', 'core.manualTrigger', {}), node('p', 'Parse triage', 'core.code', { mode: 'each', codeEach: CODE }, 280), node('s', 'Save', 'core.set', {}, 560)],
  connections: [edge('t', 'p'), edge('p', 's')],
});

const codeOf = (wf: Workflow | undefined) => wf?.nodes.find((n) => n.name === 'Parse triage')?.parameters.codeEach;

const oneLineChanged: Check = {
  id: 'code-one-line-changed',
  label: 'The code is the same with only the P1 label changed',
  judge: (o: Outcome) => codeOf(o.after) === CODE_AFTER,
};

const issueFlow = (): Workflow => ({
  id: 'wf_sb10_linear',
  name: 'New bug',
  nodes: [
    node('t', 'Manual', 'core.manualTrigger', {}),
    node('c', 'Create issue', 'linear.linear', { resource: 'issue', operation: 'create', teamId: 'team-1', title: 'Export fails' }, 280),
  ],
  connections: [edge('t', 'c')],
});

const readsUrl: Check = {
  id: 'reads-the-url-field',
  label: 'The new step reads the field the schema names ($json.url)',
  judge: (o: Outcome) => JSON.stringify(o.after?.nodes.filter((n) => n.name !== 'Create issue').map((n) => n.parameters) ?? []).includes('$json.url'),
};

export default defineScenarios([
  {
    id: 'sb10-long-code-one-line',
    owner: 'SB10',
    job: 'fix',
    via: 'chat',
    title: 'One line of a 4 000 character Code step changes and the rest of the code stays',
    ask: "in Parse triage change the 'P1' label to 'High'",
    start: { workflow: triage(), selected: 'Parse triage' },
    script: [
      // A model that saw the whole step writes it back whole; one that saw only its first 2 000 characters writes it back cut.
      (input) => call('propose_changes', { summary: "Rename the P1 label", ops: [{ op: 'setParameters', node: 'Parse triage', parameters: { codeEach: input.system.includes(LAST_LINE) ? CODE_AFTER : CODE_AFTER.slice(0, 2000) } }] }),
      { text: "Changes the P1 label to 'High'; the rest of the code is as it was." },
    ],
    checks: [oneLineChanged, checks.onlyTouches(['Parse triage']), checks.noOutside],
    live: { runs: 3 },
  },
  {
    id: 'sb10-workflow-timeout',
    owner: 'SB10',
    job: 'fix',
    via: 'chat',
    title: 'A time limit for the whole workflow is set on the workflow, not on a step',
    ask: 'stop the workflow if it runs longer than 5 minutes',
    start: { workflow: triage() },
    script: [call('propose_changes', { summary: 'Stop after 5 minutes', ops: [{ op: 'setWorkflowSettings', settings: { timeoutSeconds: 300 } }] }), { text: 'The workflow stops after 5 minutes.' }],
    checks: [
      { id: 'workflow-timeout-set', label: 'The workflow’s timeout is 300 seconds', judge: (o) => o.after?.settings?.timeoutSeconds === 300 },
      { id: 'no-step-changed', label: 'No step changed', judge: (o) => o.after?.nodes.every((n) => n.timeoutSeconds === undefined) ?? false },
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'sb10-linear-create-field',
    owner: 'SB10',
    job: 'fix',
    via: 'chat',
    title: 'A step after Linear’s create issue reads the URL field the schema names',
    ask: 'after Create issue, add a Code step that keeps the new issue’s link',
    start: { workflow: issueFlow(), selected: 'Create issue' },
    script: [
      // The model reads `url` only when the prompt names it (the operation's schema); otherwise it guesses.
      (input) =>
        call('propose_changes', {
          summary: 'Keep the issue link',
          ops: [{ op: 'addNode', ref: 'k', type: 'core.code', name: 'Keep link', after: 'Create issue', parameters: { mode: 'each', codeEach: `return { link: ${input.system.includes('Link to the new issue in Linear') ? '$json.url' : '$json.link'} };` } }],
        }),
      { text: 'Adds “Keep link”, which keeps the issue’s url.' },
    ],
    checks: [readsUrl, checks.noOutside],
    live: { runs: 3 },
  },
]);
