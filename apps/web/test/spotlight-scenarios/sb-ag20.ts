/**
 * AG20's scenarios (wave ag4): Spotlight runs the flow, reads the run's log, makes one focused fix and runs again, or stops
 * within a bound and says what is left (docs/assistant.md "Test and fix"). The unit form scripts the model and the runs: a
 * scripted error "HTTP 400: <body>" is the node's HTTP status and response body in the run log, as the strict receiver of
 * contracts/ag4/strict-receiver.cjs answers. Made-up data only (a local address, no secret).
 */
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, touchedNodes, type Outcome } from './scenario';

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, x = 0) => ({ id, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex: 0 });

const URL_GIVEN = 'http://127.0.0.1:3474/reports/sales';
const ask = `Post last month's sales report to our reports endpoint at ${URL_GIVEN}. Run it now and fix it if it fails.`;
const body400 = 'HTTP 400: Bad Request: the JSON body needs a non-empty string field "report_text" with the report text (got fields: report)';

/** A manual trigger, the report text, and the POST whose body names the field `report`: the receiver wants `report_text`. */
const reportFlow = (): Workflow => ({
  id: 'wf_ag20_report',
  name: 'Sales report',
  nodes: [
    node('t', 'Start', 'core.manualTrigger'),
    node('s', 'Shape', 'core.set', { mode: 'manual', fields: { values: [{ name: 'report', type: 'string', value: 'North 4,150; South 2,730; West 1,980' }] } }, 280),
    node('p', 'Post report', 'core.httpRequest', { method: 'POST', url: URL_GIVEN, bodyType: 'json', body: { report: '{{ $json.report }}' } }, 560),
  ],
  connections: [edge('t', 's'), edge('s', 'p')],
});

/** A manual trigger and a Run an Agent step: its agent's Send Email failed for an empty To. */
const agentFlow = (): Workflow => ({
  id: 'wf_ag20_agent',
  name: 'Email on-call',
  nodes: [node('t', 'Start', 'core.manualTrigger'), node('a', 'Email oncall', 'core.messageAgent', { agentId: 'ag_ag20_mailer', message: 'Tell on-call the report is ready', conversation: 'new' }, 280)],
  connections: [edge('t', 'a')],
});

const urlOf = (o: Outcome) => o.after?.nodes.find((n) => n.name === 'Post report')?.parameters.url;
const fixBody = { op: 'setParameters', node: 'Post report', parameters: { body: { report_text: '{{ $json.report }}' } } };
const START = { autonomy: 'auto' as const, session: 'auto' as const, approvedDestinations: ['127.0.0.1:3474'], outbound: 'allowed' as const };

export default defineScenarios([
  {
    id: 'ag20-fix-from-log',
    owner: 'AG20',
    job: 'fix',
    via: 'session',
    title: 'The first run fails with a 400 whose body names the field: Spotlight reads the log, fixes only that field, and the second run passes',
    ask,
    start: { ...START, workflow: reportFlow(), sessionRuns: [{ 'Post report': { error: body400 } }, { 'Post report': { items: 1 } }] },
    script: [{ text: 'I will run it and fix it if it fails.' }, call('get_run_log', {}), call('propose_changes', { summary: 'Send the report as report_text', ops: [fixBody] }), { text: '“Post report” sent no report_text: the body now does.' }],
    checks: [
      checks.fixedFromLogs(3),
      checks.askedBeforeWrites,
      checks.stopsAndSays(4),
      checks.destinationsGiven(ask),
      { id: 'url-kept', label: 'The URL the person gave is untouched', judge: (o) => urlOf(o) === URL_GIVEN },
      { id: 'one-focused-fix', label: 'One flow fix, to the failing node only', judge: (o) => (o.fixes ?? []).length === 1 && touchedNodes(o.before, o.after).join() === 'Post report' },
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'ag20-agent-fix',
    owner: 'AG20',
    job: 'fix',
    via: 'session',
    title: 'The run failed inside the agent (Send Email with an empty To): Spotlight proposes a change to the agent, not the flow, and applies nothing by itself',
    ask: 'Email on-call that the report is ready. Run it now and fix it if it fails.',
    start: { ...START, workflow: agentFlow(), sessionRuns: [{ 'Email oncall': { error: 'Email failed: send_email returned “the To address is empty”' } }] },
    script: [
      { text: 'I will run it and fix it if it fails.' },
      call('get_run_log', {}),
      call('propose_agent_fix', { agent: 'Alert mailer', step: 'Email oncall', tool: 'send_email', cause: 'send_email got an empty To address', change: 'Always send the email to oncall@landflow.test' }),
      { text: 'The agent’s Send Email had no To; its change card is above.' },
    ],
    checks: [
      { id: 'agent-fix-card', label: 'An agent change, not applied until clicked', judge: (o) => (o.fixes ?? []).length === 1 && o.fixes![0].target === 'agent' && o.fixes![0].agent === 'Alert mailer' && !o.fixes![0].applied },
      { id: 'no-flow-change', label: 'No change to the flow', judge: (o) => touchedNodes(o.before, o.after).length === 0 && !o.tools.includes('propose_changes') },
      { id: 'read-the-log', label: 'Read the run log first', judge: (o) => o.tools.indexOf('get_run_log') >= 0 && o.tools.indexOf('get_run_log') < o.tools.indexOf('propose_agent_fix') },
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'ag20-review-agent-fix',
    owner: 'AG20',
    job: 'fix',
    via: 'session',
    title: 'The run passed but the agent has no tool for the job (live pass S3): the review reads the log and proposes a change to the agent, not the flow, and does not stop at "I have no change for it"',
    ask: 'Email on-call that the report is ready, then check the email went out. Run it now and fix it if it fails.',
    start: { ...START, workflow: agentFlow(), sessionRuns: [{ 'Email oncall': { items: 1 } }] },
    script: [
      { text: 'I will run it and fix it if it fails.' },
      call('get_run_log', {}),
      call('propose_agent_fix', { agent: 'Alert mailer', step: 'Email oncall', cause: 'the agent has no Send Email tool', change: 'Give the agent the Send Email tool and tell it to email oncall@landflow.test' }),
      { text: 'No, the agent has no Send Email tool; its change card is above.' },
    ],
    checks: [
      { id: 'passed-then-reviewed', label: 'The run passed, and the review still found an agent change', judge: (o) => (o.runs ?? []).length === 1 && o.runs![0].status === 'success' && (o.fixes ?? []).length === 1 && o.fixes![0].target === 'agent' },
      { id: 'no-flow-change', label: 'No change to the flow', judge: (o) => touchedNodes(o.before, o.after).length === 0 && !o.tools.includes('propose_changes') },
      { id: 'read-the-log', label: 'Read the run log before proposing', judge: (o) => o.tools.indexOf('get_run_log') >= 0 && o.tools.indexOf('get_run_log') < o.tools.indexOf('propose_agent_fix') },
      { id: 'not-a-dead-end', label: 'The session does not end at “I have no change for it”: the agent’s change card is what is left', judge: (o) => !/I have no change for it/.test(o.text) },
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'ag20-same-twice',
    owner: 'AG20',
    job: 'fix',
    via: 'session',
    title: 'The same failure twice in a row: Spotlight stops and says what is left',
    ask,
    start: { ...START, workflow: reportFlow(), sessionRuns: [{ 'Post report': { error: body400 } }, { 'Post report': { error: body400 } }] },
    script: [{ text: 'I will run it and fix it if it fails.' }, call('get_run_log', {}), call('propose_changes', { summary: 'Add a header', ops: [{ op: 'setParameters', node: 'Post report', parameters: { headers: { header: [{ name: 'x-source', value: 'landflow' }] } } }] }), { text: 'Added a header.' }],
    checks: [
      checks.stopsAndSays(4),
      { id: 'two-runs', label: 'Two runs, then it stops', judge: (o) => (o.runs ?? []).length === 2 && o.runs!.every((r) => r.status === 'error') },
      { id: 'says-what-is-left', label: 'Says "Still failing at “Post report”" and what is left', judge: (o) => /Still failing at “Post report”/.test(o.text) && /Left:/.test(o.text) },
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
  {
    id: 'ag20-keeps-url',
    owner: 'AG20',
    job: 'fix',
    via: 'session',
    title: 'A fix that points the step at another address is not applied: the URL the person gave stays',
    ask,
    start: { ...START, workflow: reportFlow(), sessionRuns: [{ 'Post report': { error: body400 } }] },
    script: [
      { text: 'I will run it and fix it if it fails.' },
      call('get_run_log', {}),
      call('propose_changes', { summary: 'Post to another endpoint', ops: [{ op: 'setParameters', node: 'Post report', parameters: { url: 'http://127.0.0.1:3500/reports/sales' } }] }),
      { text: 'Pointed it at another endpoint.' },
    ],
    checks: [
      { id: 'url-kept', label: 'The URL the person gave is byte for byte the same', judge: (o) => urlOf(o) === URL_GIVEN },
      { id: 'nothing-applied', label: 'No fix applied', judge: (o) => (o.fixes ?? []).every((f) => !f.applied) },
      { id: 'one-run', label: 'No second run to the other address', judge: (o) => (o.runs ?? []).length === 1 },
      checks.noOutside,
    ],
    live: { runs: 3 },
  },
]);
