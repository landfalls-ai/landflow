/**
 * The notebook in a team run (docs/team-notebook.md; agent-teams/runtime.ts): every Landflow-agent member has the notebook
 * tools bound to the team, the run and itself (managers also promote), a Claude Code member on kagent reaches the same tools
 * over MCP bound to the request in flight, the notes show as steps and moments, and a later run finds what the first kept.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, TeamMember } from '@/lib/shared/agent-teams';
import type { TeamActivity } from '@/lib/shared/team-progress';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-team-notebook-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { read } = await import('@/lib/server/journal/store');
const { resetJournals } = await import('@/lib/server/journal/writer');
const { noteStore } = await import('@/lib/server/notebook/store');
const { setNotebookEmbedder } = await import('@/lib/server/notebook/embed');
const mcpRoute = await import('@/app/api/mcp/agents/[id]/route');

registry.registerBuiltin(corePlugin);
// No Ollama here: the notebook finds notes by their words.
setNotebookEmbedder(async () => {
  throw new Error('no embeddings in this test');
});

type Body = { model: string; messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
const scripts = new Map<string, (turn: number, body: Body) => FakeReply>();
const turns = new Map<string, number>();
const fake = await startFakeModels({
  reply: (_provider, body: Body) => {
    const turn = (turns.get(body.model) ?? 0) + 1;
    turns.set(body.model, turn);
    return scripts.get(body.model)?.(turn, body);
  },
});
const a2a = await startFakeA2a();
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`) => ({ toolCalls: [{ id, name, arguments: args }] });
const lastTool = (body: Body) => [...body.messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
const toolNames = (body: Body) => (body.tools ?? []).map((t) => t.function.name);

afterAll(async () => {
  setNotebookEmbedder(undefined);
  await fake.close();
  await a2a.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

function agent(name: string, model: string) {
  const created = agentStore.create({ name, instructions: `You are ${name}.`, model: { provider: 'ollama', model, baseUrl: fake.url.replace(/\/v1$/, '') } });
  agentStore.publish(created.id);
  return created;
}
const lead = agent('Tech Lead', 'nb-lead');
const developer = agent('Developer agent', 'nb-dev');

// A Claude Code reviewer on kagent: a Landflow agent deployed there, reachable at the fake A2A server's /agents/kagent/nb-reviewer.
const reviewerAgent = agentStore.create({ name: 'Reviewer on kagent', instructions: 'Review.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
agentStore.publish(reviewerAgent.id);
const TOKEN = 'lfk_nb_integration';
const reviewerUrl = `${a2a.url}/agents/kagent/nb-reviewer`;
agentStore.setKagent(reviewerAgent.id, { credential: { id: 'cred', name: 'kind' }, name: 'nb-reviewer', version: 1, token: credentials.sealSecret(TOKEN) } as never);

const members = (): TeamMember[] => [
  { id: 'm_lead', title: 'Tech Lead', kind: 'agent', agentId: lead.id },
  { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead' },
  { id: 'm_rev', title: 'Reviewer', kind: 'a2a', reportsTo: 'm_lead', parameters: { agentUrl: reviewerUrl } } as TeamMember,
];
function team() {
  const config: AgentTeamConfig = { name: 'Plugin team', goal: 'Ship the plugin', members: members() };
  const created = agentTeamStore.create(config);
  agentTeamStore.publish(created.id);
  return created;
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
async function run(teamId: string, message = 'Build the slugify plugin') {
  const wf: Workflow = {
    id: `wf_nb_${++n}`,
    name: 'team',
    nodes: [node('Start', 'core.manualTrigger'), node('Team', 'core.runTeam', { teamId, message })],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Team', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start' });
  resetJournals();
  return { record, done: record.runData.Team?.at(-1)?.outputs?.[0]?.[0]?.json as Record<string, unknown> | undefined, events: read(record.executionId) };
}

/** What Claude Code does inside the reviewer: it calls the notebook tools on Landflow's MCP endpoint for its agent. */
async function mcp(name: string, args: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/mcp/agents/${reviewerAgent.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await (await (mcpRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(request, { params: Promise.resolve({ id: reviewerAgent.id }) })).text();
  return JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw).result as { content: Array<{ text: string }>; isError?: boolean };
}

describe('the notebook in a team run', () => {
  it('binds every member’s tools to the run, lets the lead promote, and shows the notes as steps and moments', async () => {
    const t = team();
    const seen: string[] = [];
    // The reviewer notes a fact over MCP while it works, and the run key it was given is in its request.
    a2a.mod = async (text) => {
      seen.push(text);
      const result = await mcp('note_add', { kind: 'fact', text: 'Plugins need an icons/ folder next to src/' });
      expect(result.isError).toBeFalsy();
      return text;
    };
    scripts.set('nb-lead', (turn, body) => {
      if (turn === 1) return call('note_search', { query: 'how do plugins declare icons' }, 's1');
      if (turn === 2) return call('ask_developer', { message: 'Build it', reason: 'Needs code' }, 'd1');
      if (turn === 3) return call('ask_reviewer', { message: 'Review the plugin', reason: 'Needs a review' }, 'r1');
      if (turn === 4) {
        const fact = noteStore.list({ teamId: t.id, allRuns: true }).find((x) => x.author === 'Reviewer');
        return call('note_promote', { id: fact!.id }, 'p1');
      }
      return { text: `Done. ${lastTool(body)}` };
    });
    scripts.set('nb-dev', (turn) => (turn === 1 ? call('note_add', { kind: 'decision', text: 'Each node gets a test against a fake server.' }, 'n1') : { text: 'built it' }));
    turns.clear();
    fake.requests.length = 0;
    const { record, done, events } = await run(t.id);
    expect(record.error?.message ?? record.status).toBe('success');

    // The tools: the lead's include promote, the developer's don't; both are bound without the model naming a team or run.
    const leadTools = toolNames(fake.requests.find((r) => r.body?.model === 'nb-lead')!.body);
    expect(leadTools).toEqual(expect.arrayContaining(['ask_developer', 'ask_reviewer', 'note_add', 'note_search', 'note_update', 'note_dispute', 'note_promote']));
    const devTools = toolNames(fake.requests.find((r) => r.body?.model === 'nb-dev')!.body);
    expect(devTools).toEqual(expect.arrayContaining(['note_add', 'note_search', 'note_update', 'note_dispute']));
    expect(devTools).not.toContain('note_promote');

    // The notes landed on this execution, as the member that wrote them; the lead promoted the reviewer's to the team.
    const notes = noteStore.list({ teamId: t.id, allRuns: true });
    const decision = notes.find((x) => x.author === 'Developer')!;
    const fact = notes.find((x) => x.author === 'Reviewer')!;
    expect(decision).toMatchObject({ kind: 'decision', scope: 'run', runId: record.executionId, workflowId: record.workflowId, source: { executionId: record.executionId, tool: 'note_add' } });
    expect(decision.source.spanId).toBeTruthy();
    expect(fact).toMatchObject({ scope: 'team', promotedFrom: 'run', runId: record.executionId });
    // The reviewer's request carries the run key, so it can name its run if two ask at once.
    expect(seen[0]).toMatch(/Notebook run key: nbk_[\w-]+\. If a note tool asks which run, pass this as "run"\./);

    // The Run Trace shows each notebook call as a tool step under the member's request, named plainly.
    const toolSpans = events.filter((e) => e.type === 'span.started' && e.kind === 'tool').map((e) => (e.type === 'span.started' ? e.name : ''));
    expect(toolSpans).toEqual(expect.arrayContaining(['note_search', 'note_add', 'note_promote']));
    const noteAdd = events.find((e) => e.type === 'span.started' && e.kind === 'tool' && e.name === 'note_add');
    const devRequest = events.find((e) => e.type === 'span.started' && e.kind === 'delegate' && e.name === 'Developer');
    expect(noteAdd && noteAdd.type === 'span.started' && noteAdd.parentSpanId).toBeTruthy();
    expect(devRequest).toBeTruthy();

    // The canvas: the moments for the two notes, the lead's promotion, and the narrated steps.
    const activity = done!.activity as TeamActivity;
    const written = activity.moments.filter((m) => m.note).map((m) => m.text);
    // (The reviewer's note is a moment when its A2A task reports the MCP call as a step: test/team-progress.test.ts.)
    expect(written).toEqual(['Developer decided: Each node gets a test against a fake server.', 'Tech Lead promoted a note to the team']);
  });

  it('tells the next run what the team decided and asked, and it finds the team’s notes by words', async () => {
    const t = team();
    noteStore.insert({ teamId: t.id, kind: 'decision', text: 'Target the v2 alerting API only', scope: 'team', author: 'Tech Lead', source: {} });
    noteStore.insert({ teamId: t.id, kind: 'open_question', text: 'Who owns the icons?', scope: 'team', author: 'Developer', source: {} });
    noteStore.insert({ teamId: t.id, kind: 'fact', text: 'Run one only', scope: 'run', runId: 'exec_old', author: 'Developer', source: {} });
    a2a.mod = async (text) => {
      seen.push(text);
      return text;
    };
    const seen: string[] = [];
    scripts.set('nb-lead', (turn, body) => {
      if (turn === 1) return call('note_search', { query: 'alerting API' }, 's1');
      if (turn === 2) return call('ask_reviewer', { message: 'Review it', reason: 'Needs a review' }, 'r1');
      return { text: `Found: ${body.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' | ')}` };
    });
    turns.clear();
    fake.requests.length = 0;
    const { done } = await run(t.id);
    const first = fake.requests.find((r) => r.body?.model === 'nb-lead')!.body.messages.map((m: { content: string }) => m.content).join('\n');
    expect(first).toContain('Team notebook (shared notes');
    expect(first).toContain('Decisions so far:\n- Target the v2 alerting API only');
    expect(first).toContain('Open questions:\n- Who owns the icons?');
    expect(first).not.toContain('Run one only');
    // Members it asks are told too.
    expect(seen[0]).toContain('Decisions so far:\n- Target the v2 alerting API only');
    expect(String(done!.reply)).toContain('Target the v2 alerting API only');
    expect(String(done!.reply)).toContain('matched by keywords');
  });

  it('writes nothing for a member whose call has ended, and gives a run without kagent members no key', async () => {
    const t = agentTeamStore.create({ name: 'Local team', goal: 'Stay local', members: [{ id: 'm_lead', title: 'Tech Lead', kind: 'agent', agentId: lead.id }, { id: 'm_dev', title: 'Developer', kind: 'agent', agentId: developer.id, reportsTo: 'm_lead' }] });
    agentTeamStore.publish(t.id);
    scripts.set('nb-lead', (turn, body) => (turn === 1 ? call('ask_developer', { message: 'Do it', reason: 'Needs code' }, 'd1') : { text: lastTool(body) }));
    scripts.set('nb-dev', () => ({ text: 'did it' }));
    turns.clear();
    fake.requests.length = 0;
    const { done } = await run(t.id);
    expect(done!.reply).toBe('did it');
    const devMessage = JSON.stringify(fake.requests.find((r) => r.body?.model === 'nb-dev')!.body.messages);
    expect(devMessage).not.toContain('Notebook run key');
    expect(devMessage).not.toContain('Team notebook (shared notes');
    // After the run the reviewer's agent has no open call: a stray note is refused.
    const late = await mcp('note_add', { kind: 'fact', text: 'Too late' });
    expect(late.isError).toBe(true);
    expect(late.content[0].text).toMatch(/No team run is using this agent/);
  });
});
