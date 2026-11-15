/**
 * The join of the practices inbox (PR09 ↔ PR01's store, PR04's MCP tools, PR06's delivery): a `practice_draft` over MCP is
 * tainted and files a suggestion with no Apply; a person's draft files an applyable one; a member's Apply is refused and
 * the owner's approves it; the next agent run in its project gets it. Everything real: `lib/server/runtime` first (the
 * inbox's applier, the store's port and the practices source register there), a fake model only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { LanguageModel } from '@landflow/engine';
import type { Proposal } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 30_000 });

const systems: string[] = [];
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => ({
    provider: 'scripted',
    model: config?.model ?? 'm',
    async generate(input) {
      systems.push(input.system ?? '');
      return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-inbox-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { storePort } = await import('@/lib/server/practices/register');
const { getPractice } = await import('@/lib/server/practices/store');
const proposals = await import('@/lib/server/brain/proposals');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const applyRoute = await import('@/app/api/proposals/[id]/apply/route');

const owner = await createUser({ email: 'owner@inbox-join.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const member = await createUser({ email: 'member@inbox-join.test', name: 'Member', role: 'member', password: 'member-password-1' });
const project = createTeamProject({ name: 'Charts', createdBy: owner.id });
setMember(project.id, member.id, 'editor');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const DRAFT = { title: 'A rule', level: 'project', strength: 'recommended', topics: [], repos: [], paths: [], summary: 'A short rule', body: 'The full rule.' };
const suggestionOf = (practiceId: string): Proposal => {
  const found = proposals.listProposals({ status: 'open', limit: 500 }).filter((p) => p.practice?.practiceId === practiceId);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const apply = async (user: typeof owner, id: string) => {
  enableTestAuth(user);
  const response = await applyRoute.POST(new Request(`http://localhost/api/proposals/${id}/apply`, { method: 'POST' }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { error?: string; proposal?: Proposal } };
};
const runInProject = async () => {
  const agent = agentStore.create({ name: 'Chart helper', instructions: 'Be brief.', model: { provider: 'ollama', model: 'scripted-1' } });
  setHomeProject('agent', agent.id, project.id);
  systems.length = 0;
  await runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), message: 'hi' });
  return systems[0] ?? '';
};

describe('drafts in the inbox, then in a run', () => {
  let tainted = '';
  let personal = '';

  it('a practice_draft over MCP is tainted: its suggestion has no Apply, for anyone', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer({ id: member.id, role: 'member' }, { projectId: project.id }).connect(serverSide);
    const client = new Client({ name: 'inbox-join', version: '1.0.0' });
    await client.connect(clientSide);
    const result = (await client.callTool({ name: 'practice_draft', arguments: { ...DRAFT, handle: 'helm/from-an-agent' } })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    tainted = (JSON.parse(result.content[0]!.text) as { practiceId: string }).practiceId;
    expect(getPractice(tainted)?.projectId).toBe(project.id);
    const suggestion = suggestionOf(tainted);
    expect(suggestion.practice).toMatchObject({ practiceId: tainted, version: 1, tainted: true });
    expect((await apply(owner, suggestion.id)).status).toBe(403);
    expect(getPractice(tainted)?.status).not.toBe('approved');
  });

  it('a person’s draft is applyable: a member’s Apply is refused (not found), the owner’s approves it', async () => {
    personal = storePort.draft({ ...DRAFT, level: 'project', projectId: project.id, handle: 'helm/from-a-person' } as never, { source: 'person', actor: member }).practice.id;
    const suggestion = suggestionOf(personal);
    expect(suggestion.practice).toMatchObject({ practiceId: personal, version: 1, tainted: false });
    // The suggestion is addressed to the practice's approvers: an editor of the project is not one, so it is not found.
    expect((await apply(member, suggestion.id)).status).toBe(404);
    expect(getPractice(personal)?.status).not.toBe('approved');
    const applied = await apply(owner, suggestion.id);
    expect(applied.status, applied.body.error).toBe(200);
    expect(getPractice(personal)).toMatchObject({ status: 'approved', approvedVersion: 1 });
  });

  it('the next agent run in the project gets the approved one, and not the tainted draft', async () => {
    const system = await runInProject();
    expect(system).toContain('[helm/from-a-person@1]');
    expect(system).not.toContain('helm/from-an-agent');
  });
});
