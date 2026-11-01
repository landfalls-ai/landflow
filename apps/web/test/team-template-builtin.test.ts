/**
 * The built-in agent-team template "Plugin builders" (docs/templates.md#team-templates): it is in the Agent teams category,
 * its card holds the members' faces and what the person picks, nothing of the instance it was written on travels, and using
 * it creates a fresh team, agent and flow with the credential the person picked.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IPlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-team-builtin-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_TEMPLATES_URL;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const templates = await import('@/lib/server/templates');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const listRoute = await import('@/app/api/templates/route');

const fixtures = join(import.meta.dirname, 'fixtures', 'plugin-manifests');
registry.registerBuiltin(corePlugin);
for (const file of readdirSync(fixtures)) {
  const manifest = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  registry.registerBuiltin({ info: manifest.plugin, nodes: manifest.nodes.map((description: unknown) => ({ description, execute: async () => [[]] })), credentialTypes: manifest.credentialTypes } as unknown as IPlugin);
}

type Listed = { templates: Array<{ id: string; source: string; categories: string[]; team?: { faces: Array<{ name: string; avatar?: unknown }>; picks: string[]; members: number } }> };
const list = async (query: string) => (await (await listRoute.GET(new Request(`http://localhost/api/templates?${query}`))).json()) as Listed;

describe('the built-in Plugin builders team template', () => {
  it('is in the Agent teams category, with the members’ faces and what the person picks', async () => {
    const found = (await list('category=agent-teams')).templates.find((t) => t.id === 'plugin-builders')!;
    expect(found).toMatchObject({ source: 'builtin', categories: expect.arrayContaining(['agent-teams']), team: { members: 4, picks: ['GitHub credential', 'Ollama or Claude model', 'Repository'] } });
    expect(found.team!.faces.map((f) => f.name)).toEqual(['Tech Lead', 'Planner', 'Developer', 'Reviewer']);
    // The Tech Lead is a Landflow agent with a face of its own; the Claude Code members show by their names.
    expect(found.team!.faces[0].avatar).toBeDefined();
    expect(found.team!.faces[1].avatar).toBeUndefined();
    expect((await list('category=sales')).templates.some((t) => t.id === 'plugin-builders')).toBe(false);
  });

  it('holds no credential id, secret or id of the instance it was written on', async () => {
    const detail = (await templates.getTemplate('plugin-builders'))!;
    expect(detail.usable).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/cred_|team_[A-Za-z0-9]{8}|ag_[A-Za-z0-9]{8}|wf_[A-Za-z0-9]{8}|ghp_|jhonny/);
    expect(detail.credentials.map((c) => c.id)).toEqual(['github']);
    expect(detail.description).toBe('A Tech Lead with a Planner, Developer and Reviewer on Claude Code, and the flow that builds, checks and merges a plugin.');
  });

  it('is used like any team template: a fresh team, a fresh agent, the flow pointing at them and the credential picked', async () => {
    const token = credentials.create({ name: 'My token', type: 'github.githubApi', data: { accessToken: 'secret-token-value' } }).id;
    const used = await templates.useTemplate('plugin-builders', { credentials: { github: token } });
    expect(used.team!.name).toBe('Tech Lead team');
    expect(used.agents!.map((a) => a.name)).toEqual(['Tech Lead']);
    const made = agentTeamStore.get(used.team!.id)!;
    expect(made.draft.members.map((m) => m.title)).toEqual(['Tech Lead', 'Planner', 'Developer', 'Reviewer']);
    expect(made.draft.members.find((m) => m.kind === 'agent')).toMatchObject({ agentId: used.agents![0].id });
    expect(used.workflow!.nodes.find((n) => n.type === 'core.runTeam')?.parameters.teamId).toBe(used.team!.id);
    const withToken = used.workflow!.nodes.filter((n) => n.credentials);
    expect(withToken.length).toBeGreaterThan(0);
    expect(withToken.every((n) => Object.values(n.credentials!).every((c) => c.id === token))).toBe(true);
    expect(used.workflow!.active).toBe(false);
  });
});
