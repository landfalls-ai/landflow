/**
 * SB00's scenarios: the evaluation (spotlight-pro/findings.md) as a baseline. Live for all, unit only where today's code
 * already passes. The fixtures are made-up data; the echo URLs are http://127.0.0.1:3399/… and the harness rewrites the port.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import { call, checks, defineScenarios, touchedNodes, type Check, type Outcome } from './scenario';

const fixture = <T>(name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;
const BUG_TRIAGE = fixture<Workflow>('bug-triage.json');
const BUG_TRIAGE_RUNS = fixture<Record<string, RunDigest>>('bug-triage-runs.json');
const PR_REVIEW = fixture<Workflow>('pr-review.json');

/** The step the status page call is: the evaluation's "this HTTP step". */
const HTTP = 'Open status incident';

const node = (o: Outcome, name: string) => o.after?.nodes.find((n) => n.name === name);
const only = (names: string[]) => checks.onlyTouches(names);
const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const text = (o: Outcome) => JSON.stringify(o.after ?? {});

// ---------------------------------------------------------------------------
// Builds: what the empty canvas's first draft gets right (collections, ids, credentials, wiring)
// ---------------------------------------------------------------------------

/** A parameter value that is a collection with nothing in it: `{ condition: [] }`, `{ rule: { interval: [] } }`, `[]`. */
function hollow(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') {
    const values = Object.values(value);
    return values.length > 0 && values.every((v) => hollow(v));
  }
  return false;
}

const draftNodes = (o: Outcome) => o.after?.nodes ?? [];
const typesOf = (o: Outcome) => draftNodes(o).map((n) => n.type);

const rightTypes = (expected: string[]): Check => ({
  id: 'right-types',
  label: 'Right node types',
  judge: (o) => (o.after ? expected.every((t) => typesOf(o).includes(t)) : false),
});

const wired: Check = {
  id: 'wiring',
  label: 'Wired from the trigger',
  judge: (o) => {
    const wf = o.after;
    if (!wf) return false;
    const triggers = wf.nodes.filter((n) => /manualTrigger|webhook|schedule|chatTrigger|Trigger$/.test(n.type));
    const reached = new Set(triggers.map((n) => n.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of wf.connections) if (reached.has(c.source) !== reached.has(c.target) && (reached.has(c.source) || c.type !== 'main')) (reached.add(c.source), reached.add(c.target), (grew = true));
    }
    return triggers.length === 1 && wf.nodes.every((n) => reached.has(n.id));
  },
};

const collectionsFilled: Check = {
  id: 'collections-filled',
  label: 'Collections filled (conditions, fields, rules, columns)',
  judge: (o) => (o.after ? !draftNodes(o).some((n) => Object.values(n.parameters ?? {}).some(hollow)) : false),
};

/** Ids and channels the ask never gave: a Slack channel id, a data table id. */
const idsAsked: Check = {
  id: 'ids-asked',
  label: 'Ids asked for, not made up',
  judge: (o) => {
    const made = /"(C0[0-9A-Z]{8,}|dt_[A-Za-z0-9_]{5,}|T0[0-9A-Z]{8,})"/;
    return o.after ? !made.test(text(o)) : false;
  },
};

const credentialsListed: Check = {
  id: 'credentials-listed',
  label: 'Credentials named as still to pick',
  judge: (o) => (draftNodes(o).some((n) => /^(messaging|linear)\./.test(n.type)) ? /credential|sign in|connect/i.test(o.text) : 'n/a'),
};

const noJunk: Check = {
  id: 'no-junk',
  label: 'No junk nodes',
  judge: (o) => {
    if (!o.after) return false;
    const empty = draftNodes(o).filter((n) => ['core.set', 'core.code'].includes(n.type) && Object.keys(n.parameters ?? {}).length === 0);
    return empty.length === 0;
  },
};

const leftListed: Check = {
  id: 'left-listed',
  label: 'Said what is left',
  judge: (o) => /left|still|need|pick|set up|assum|empty|choose/i.test(o.text) && o.text.length > 40,
};

/** Both POST steps send the order (an expression), not a fixed body. */
const sendsTheOrder: Check = {
  id: 'runs-right',
  label: 'Runs right with the pinned data',
  judge: (o) => {
    const posts = draftNodes(o).filter((n) => n.type === 'core.httpRequest');
    return posts.length === 2 && posts.every((n) => /\{\{\s*\$json/.test(JSON.stringify(n.parameters ?? {}))) && draftNodes(o).some((n) => n.type === 'core.if' && !hollow(n.parameters));
  },
};

const hasAgentNode: Check = {
  id: 'runs-right',
  label: 'Runs the existing agent once, behind a decision',
  judge: (o) => draftNodes(o).some((n) => n.type === 'core.messageAgent' && Boolean((n.parameters as { agentId?: unknown } | undefined)?.agentId)) && !draftNodes(o).some((n) => n.type === 'core.if' && hollow(n.parameters)),
};

// ---------------------------------------------------------------------------
// One-step asks on the "Bug triage" fixture
// ---------------------------------------------------------------------------

const retryOn = (name: string): Check =>
  right('right-change', 'Retries 3 times', (o) => {
    const n = node(o, name) as { maxTries?: number; retryOnFail?: boolean } | undefined;
    return o.after ? n?.maxTries === 3 && n?.retryOnFail === true : false;
  });

export default defineScenarios([
  // -- Builds ---------------------------------------------------------------
  {
    id: 'sb00-build-linear-bugs',
    owner: 'SB00',
    job: 'build',
    via: 'build',
    title: 'B1: Linear bugs, an agent triages them, P0s to Slack, the rest to a table',
    ask: 'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table',
    checks: [rightTypes(['core.schedule', 'linear.linear', 'messaging.slack']), wired, collectionsFilled, idsAsked, credentialsListed, noJunk, leftListed, checks.noOutside],
    // Needs the real Linear and Messaging nodes online (docs/development.md: LANDFLOW_SPOTLIGHT_PLUGINS).
    live: process.env.LANDFLOW_SPOTLIGHT_PLUGINS ? { runs: 3 } : { skip: 'the Linear and Messaging plugins are not online (set LANDFLOW_SPOTLIGHT_PLUGINS to their local endpoints)' },
  },
  {
    id: 'sb00-build-webhook-branch',
    owner: 'SB00',
    job: 'build',
    via: 'build',
    title: 'B4: a webhook, branch on the total, two POSTs to the echo server, respond',
    ask: 'When a webhook receives an order, if the total is over 1000 POST it to http://127.0.0.1:3399/vip as JSON with a field "vip": true, otherwise POST it to http://127.0.0.1:3399/regular; then respond to the webhook with {"ok": true}',
    checks: [rightTypes(['core.webhook', 'core.if', 'core.httpRequest', 'core.respondToWebhook']), wired, collectionsFilled, sendsTheOrder, noJunk, leftListed, checks.noOutside],
  },
  {
    id: 'sb00-build-chat-support',
    owner: 'SB00',
    job: 'build',
    via: 'build',
    title: 'B8: a chat message, the Support triage agent, a person approves what it cannot answer, reply',
    ask: 'When a chat message arrives, have my Support triage agent answer it; if it cannot answer, hand it to a person for approval, then reply in the chat',
    checks: [rightTypes(['core.messageAgent']), wired, collectionsFilled, hasAgentNode, noJunk, leftListed, checks.noOutside],
  },

  // -- Fix one step ---------------------------------------------------------
  {
    id: 'sb00-fix-slack-link',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'The Slack message should include the issue link',
    ask: 'the Slack message should include the issue link',
    start: { workflow: BUG_TRIAGE },
    script: [
      call('propose_changes', {
        summary: 'Updated Slack message to include issue link',
        ops: [{ op: 'setParameters', node: 'Post to #oncall', parameters: { text: ':rotating_light: P0 bug: {{ $json.title }}\nLink: {{ $json.url }}\nWhy: {{ $json.reason }}' } }],
      }),
      { text: 'The change updates the message text to include `{{ $json.url }}` which contains the bug’s URL. Apply the change to see the link in future Slack notifications.' },
    ],
    checks: [only(['Post to #oncall']), right('right-change', 'Message holds the link', (o) => (o.after ? /\$json\.(url|link)/.test(JSON.stringify(node(o, 'Post to #oncall')?.parameters)) : false)), checks.proposed, checks.noOutside],
  },
  {
    id: 'sb00-fix-schedule',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'Change the schedule to 9:30 Monday to Thursday',
    ask: 'change the schedule to 9:30 Mon–Thu',
    start: { workflow: BUG_TRIAGE },
    script: [
      call('propose_changes', {
        summary: 'Updated schedule to 9:30 Mon–Thu',
        ops: [{ op: 'setParameters', node: 'Weekdays at 8', parameters: { unit: 'rules', rule: { interval: [{ expression: '0 30 9 * * 1-4', field: 'cronExpression' }] } } }],
      }),
      { text: 'The schedule node is updated to run at 9:30 AM Monday through Thursday using a cron expression. Apply the change to see the new timing take effect.' },
    ],
    checks: [only(['Weekdays at 8']), right('right-change', 'Runs at 9:30, Monday to Thursday', (o) => (o.after ? /30 9|9:30/.test(JSON.stringify(node(o, 'Weekdays at 8')?.parameters)) && /1-4|mon.*thu/i.test(JSON.stringify(node(o, 'Weekdays at 8')?.parameters)) : false)), checks.proposed, checks.noOutside],
  },
  {
    id: 'sb00-fix-401-selected',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'This HTTP step fails with 401 (selected, with the failed run)',
    ask: 'this HTTP step fails with 401, fix it',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS },
    checks: [only([HTTP]), right('right-change', 'Authentication set, no made-up field', (o) => (o.after ? Boolean(o.proposals.length) && !/api_token/.test(JSON.stringify(node(o, HTTP)?.parameters)) && JSON.stringify(node(o, HTTP)?.parameters) !== JSON.stringify(BUG_TRIAGE.nodes.find((n) => n.name === HTTP)?.parameters) : false)), checks.noOutside],
  },
  {
    id: 'sb00-fix-401-autonomous',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'This HTTP step fails with 401, in autonomous mode',
    ask: 'this HTTP step fails with 401, fix it',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS, autonomy: 'auto', session: 'auto' },
    checks: [only([HTTP]), right('right-change', 'Authentication set, no made-up field', (o) => (o.after ? Boolean(o.proposals.length) && !/api_token/.test(JSON.stringify(node(o, HTTP)?.parameters)) && JSON.stringify(node(o, HTTP)?.parameters) !== JSON.stringify(BUG_TRIAGE.nodes.find((n) => n.name === HTTP)?.parameters) : false)), checks.noOutside],
  },
  {
    id: 'sb00-fix-retry-only',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'Only that one node: retry 3 times (selected)',
    ask: 'only that one node: retry 3 times',
    start: { workflow: BUG_TRIAGE, selected: 'n_http', runs: BUG_TRIAGE_RUNS },
    script: [
      call('propose_changes', { summary: 'Set retry attempts for status incident', ops: [{ op: 'setNodeSettings', node: HTTP, settings: { maxTries: 3, retryOnFail: true } }] }),
      { text: 'The card sets the “Open status incident” node to retry up to 3 times on failure. Apply the change to enable this behavior.' },
    ],
    checks: [only([HTTP]), retryOn(HTTP), checks.proposed, checks.noOutside],
  },
  {
    id: 'sb00-fix-retry-backoff',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'Retry 3 times with exponential backoff, nothing else (named loosely)',
    ask: 'make the status page call retry 3 times with exponential backoff, nothing else',
    start: { workflow: BUG_TRIAGE },
    checks: [
      only([HTTP]),
      right('right-change', 'Retries 3 times, exponential, and nothing more', (o) => {
        const n = node(o, HTTP) as { maxTries?: number; retryOnFail?: boolean; retryBackoff?: string; waitBetweenTriesMs?: number } | undefined;
        return o.after ? n?.maxTries === 3 && n?.retryOnFail === true && n?.retryBackoff === 'exponential' && n?.waitBetweenTriesMs === undefined : false;
      }),
      checks.noOutside,
    ],
  },
  {
    id: 'sb00-fix-retry-vague',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'It should retry 3 times (nothing selected, nothing named)',
    ask: 'it should retry 3 times',
    start: { workflow: BUG_TRIAGE },
    checks: [
      right('right-change', 'Asked which step instead of picking one', (o) => o.tools.includes('ask_user') || (o.proposals.length === 0 && touchedNodes(o.before, o.after).length === 0)),
      checks.noOutside,
    ],
  },
  {
    id: 'sb00-fix-why-last-run',
    owner: 'SB00',
    job: 'fix',
    via: 'chat',
    title: 'Why did the last run fail? (a question)',
    ask: 'why did the last run fail?',
    start: { workflow: BUG_TRIAGE, runs: BUG_TRIAGE_RUNS },
    checks: [checks.noChange, checks.answered, checks.noOutside],
  },

  // -- Agents (through the Agent architect) ----------------------------------
  {
    id: 'sb00-agent-pr-reviewer',
    owner: 'SB00',
    job: 'agent',
    via: 'architect',
    title: 'An agent that reviews pull requests against our practices (after "Sample PR")',
    ask: 'create an agent that reviews pull requests against our practices, and run it after Sample PR',
    start: { workflow: PR_REVIEW },
    checks: [agentExists(), agentModel(), leastPrivilege(['github']), checks.noOutside],
  },
  {
    id: 'sb00-agent-docs-linear',
    owner: 'SB00',
    job: 'agent',
    via: 'architect',
    title: 'An agent that answers customer questions from the docs knowledge base with a Linear tool',
    ask: 'an agent that answers customer questions from the docs knowledge base with a Linear tool',
    checks: [agentExists(), agentModel(), leastPrivilege(['linear']), right('knowledge', 'Searches a knowledge base', (o) => (o.agents.length ? o.agents.some((a) => a.knowledge) : false)), checks.noOutside],
  },
]);

function agentExists(): Check {
  return right('agent-exists', 'An agent exists', (o) => o.agents.length > 0);
}
function agentModel(): Check {
  return right('model', 'A model chosen', (o) => (o.agents.length ? o.agents.every((a) => Boolean(a.model)) : false));
}
/** At most three tools, none outside the asked-for families. */
function leastPrivilege(families: string[]): Check {
  return right('tools', 'Tools least-privilege', (o) => (o.agents.length ? o.agents.every((a) => a.tools.length <= 3 && a.tools.every((t) => families.some((f) => t.toLowerCase().includes(f)))) : false));
}
