/**
 * AG16 (wave ag4): what `GET /api/agents/:id/connections` adds for the canvas's bubbles. `draft` (the draft's own connections)
 * only when the draft differs from what is published; `usedBy` only the workflows the caller can read that run the agent, a
 * team's lead included; a node tool that lacks a required credential is `credential: 'missing'`. Made-up data; no model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-connections-draft-ag4-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The caller cannot read the workflows named here (a stand-in for a private project's).
const hidden = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/server/projects/access', async (original) => {
  const real = await original<typeof import('@/lib/server/projects/access')>();
  return { ...real, canResource: (actor: never, kind: string, id: string, action: never) => (kind === 'workflow' && hidden.has(id) ? false : real.canResource(actor, kind as never, id, action)) };
});

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
registry.registerBuiltin(corePlugin);
const { agentStore } = await import('@/lib/server/agents/store');
const { store } = await import('@/lib/server/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const route = await import('@/app/api/agents/[id]/connections/route');
const auth = await import('@/lib/server/auth');
await auth.createOwner({ email: 'o@ag16.test', name: 'Owner', password: 'password-123' });

type Answer = { status: number; agent: { draftDiffers: boolean; published: boolean }; connections: Array<Record<string, unknown>>; draft?: Array<Record<string, unknown>>; usedBy?: Array<{ workflowId: string; name: string }> };
const ask = async (id: string): Promise<Answer> => {
  const response = await route.GET(new Request(`http://localhost:3000/api/agents/${id}/connections`), { params: Promise.resolve({ id }) });
  return { status: response.status, ...(await response.json()) };
};

const note = { id: 'tool_note', type: 'node', name: 'Note', description: 'Note', nodeType: 'core.noOp', parameters: {} } as const;
const chat = { id: 'tool_chat', type: 'node', name: 'Chat', description: 'Chat', nodeType: 'core.openAiChatModel', parameters: {} } as const;
const base = { name: 'Alert triager', description: 'Triage', instructions: 'Work.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, memory: { crossSession: false } };
const wf = (id: string, name: string, nodes: unknown[]) => store.saveWorkflow({ id, name, nodes, connections: [] } as unknown as Workflow);
const run = (id: string, agentId: string) => ({ id: 'n1', type: 'core.messageAgent', name: 'Run', position: [0, 0], parameters: { agentId } });

describe('draft', () => {
  it('is there only when the draft differs from what is published', async () => {
    const a = agentStore.create({ ...base, tools: [note] } as never);
    agentStore.publish(a.id);
    const same = await ask(a.id);
    expect(same.agent.draftDiffers).toBe(false);
    expect(same.draft).toBeUndefined();
    agentStore.saveDraft(a.id, { tools: [note, { ...note, id: 'tool_two', name: 'Second' }] } as never);
    const differs = await ask(a.id);
    expect(differs.agent.draftDiffers).toBe(true);
    expect(differs.connections.some((c) => c.name === 'Second')).toBe(false);
    expect(differs.draft?.some((c) => c.name === 'Second')).toBe(true);
  });

  it('an agent never published has no draft list (its draft is what is shown)', async () => {
    const a = agentStore.create({ ...base, tools: [note] } as never);
    const r = await ask(a.id);
    expect(r.agent.published).toBe(false);
    expect(r.draft).toBeUndefined();
  });
});

describe('usedBy', () => {
  it('lists only the workflows the caller can read that run the agent', async () => {
    const a = agentStore.create({ ...base, tools: [] } as never);
    const other = agentStore.create({ ...base, name: 'Other', tools: [] } as never);
    wf('wf_ag16_open', 'Open flow', [run('n1', a.id)]);
    wf('wf_ag16_private', 'Private flow', [run('n1', a.id)]);
    wf('wf_ag16_other', 'Other flow', [run('n1', other.id)]);
    hidden.add('wf_ag16_private');
    try {
      const r = await ask(a.id);
      expect(r.usedBy).toEqual([{ workflowId: 'wf_ag16_open', name: 'Open flow' }]);
    } finally {
      hidden.delete('wf_ag16_private');
    }
    expect((await ask(a.id)).usedBy?.map((u) => u.workflowId).sort()).toEqual(['wf_ag16_open', 'wf_ag16_private']);
  });

  it('a Run a Team node counts for the team’s lead', async () => {
    const lead = agentStore.create({ ...base, name: 'Team lead', tools: [] } as never);
    const team = agentTeamStore.create({ name: 'Solo', goal: 'Do it', members: [{ id: 'm_lead', title: 'Lead', kind: 'agent', agentId: lead.id }] } as never);
    agentTeamStore.publish(team.id);
    wf('wf_ag16_team', 'Team flow', [{ id: 'n1', type: 'core.runTeam', name: 'Team', position: [0, 0], parameters: { teamId: team.id } }]);
    expect((await ask(lead.id)).usedBy).toEqual([{ workflowId: 'wf_ag16_team', name: 'Team flow' }]);
  });

  it('is empty when no workflow runs the agent', async () => {
    const a = agentStore.create({ ...base, name: 'Lonely', tools: [] } as never);
    expect((await ask(a.id)).usedBy).toEqual([]);
  });
});

describe('credential', () => {
  it('a node tool that lacks a required credential says missing, one that needs none does not', async () => {
    const a = agentStore.create({ ...base, tools: [chat, note] } as never);
    agentStore.publish(a.id);
    const r = await ask(a.id);
    const by = (name: string) => r.connections.find((c) => c.name === name)!;
    expect(by('Chat').credential).toBe('missing');
    expect(by('Note').credential).toBeUndefined();
  });
});
