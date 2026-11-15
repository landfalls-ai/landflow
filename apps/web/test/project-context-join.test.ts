/**
 * The Paperclip wave 7 join (constitution lesson 7, docs/projects-and-goals.md#how-it-is-built): the goals store's data
 * source (PC01) and the provider (PC03) set through lib/server/runtime.ts's own imports, the agents runtime building the
 * block, and the real usage meter (PC05) writing the run's project and goal on the `ai_usage` row. Each package tests its
 * side with fakes; this one sets no seam itself. The model is scripted (it reports usage the way a provider does); no
 * network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';
import type { RunContext } from '@/lib/shared/project-context';

vi.setConfig({ testTimeout: 30_000 });

const seen: { systems: string[]; contexts: Array<RunContext | undefined> } = { systems: [], contexts: [] };

vi.mock('@/lib/server/agents/models', async () => {
  const { afterModelCall, beforeModelCall } = await import('@/lib/server/ai-usage/scope');
  const { currentRunContext } = await import('@/lib/server/project-context/seam');
  return {
    OLLAMA_URL: 'http://127.0.0.1:11434',
    modelOptions: async () => [],
    agentModel: (config: { model?: string } | undefined): LanguageModel => ({
      provider: 'scripted',
      model: config?.model ?? 'm',
      async generate(input) {
        const call = { provider: 'ollama', model: 'scripted-join', operation: 'chat' };
        beforeModelCall(call);
        seen.systems.push(input.system ?? '');
        // What the run's context is where the call is metered: inside the agent's usage scope.
        seen.contexts.push(currentRunContext());
        afterModelCall({ ...call, inputTokens: 40, outputTokens: 6 });
        return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 6 } };
      },
    }),
  };
});

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-context-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The composition root's side-effect imports set both seams; nothing in this file sets one.
await import('@/lib/server/runtime');
const { contextDataSource, runContextProvider, practicesSource } = await import('@/lib/server/project-context/seam');
const { goalsContextSource } = await import('@/lib/server/goals/context-source');
const { projectContextProvider } = await import('@/lib/server/project-context/provider');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setHomeProject, setMember, updateProjectBrief } = await import('@/lib/server/projects/store');
const { createGoalAs, setProjectGoalsAs } = await import('@/lib/server/goals/views');
const { updateSettings } = await import('@/lib/server/settings');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('the project-context join', () => {
  it('runtime.ts sets the goals store as the data source and the real provider; no practices source in wave 7', () => {
    expect(contextDataSource()).toBe(goalsContextSource);
    expect(runContextProvider()).toBe(projectContextProvider);
    expect(practicesSource()).toBeUndefined();
  });

  it('an agent run in a project with a goal gets the block, and its ai_usage row names the project and the goal', async () => {
    const owner = await createUser({ email: 'owner@context-join.test', name: 'Dana Owner', role: 'owner', password: 'owner-password-1' });
    const actor = { id: owner.id, role: owner.role };
    updateSettings({ company: { mission: 'Close the month in a day' } });
    const project = createTeamProject({ name: 'Billing', createdBy: owner.id });
    setMember(project.id, owner.id, 'admin');
    updateProjectBrief(project.id, { brief: 'Invoices for every customer, on time.' });
    const company = createGoalAs(actor, { level: 'company', title: 'Halve close time', status: 'active', ownerId: owner.id });
    const goal = createGoalAs(actor, { level: 'project', projectId: project.id, parentId: company.id, title: 'Export invoices', status: 'active' });
    setProjectGoalsAs(actor, project.id, [goal.id]);

    const agent = agentStore.create({ name: 'Biller', instructions: 'Be brief.', model: { provider: 'ollama', model: 'scripted-join' } });
    setHomeProject('agent', agent.id, project.id);
    const session = newSession(agent, { source: 'schedule', userId: owner.id, version: 'draft' });
    const result = await runAgent({ agent, session, message: 'Send the invoices' });
    expect(result.reply).toBe('ok');

    // The block, from the real store, in the model's input.
    const system = seen.systems.at(-1)!;
    expect(system).toContain('## Where this work fits (from project “Billing”)');
    expect(system).toContain('Close the month in a day');
    expect(system).toContain('Halve close time');
    expect(system).toContain('Export invoices');
    expect(system).toContain('Invoices for every customer, on time.');
    expect(system.indexOf('## Where this work fits')).toBeLessThan(system.indexOf('You are “Biller”'));

    // The run's context where the call was metered: this project and goal, and no practices.
    const context = seen.contexts.at(-1);
    expect(context).toMatchObject({ projectId: project.id, goalId: goal.id, mode: 'full' });
    expect(context!.practices).toEqual([]);

    const row = database().get<Record<string, unknown>>('SELECT * FROM ai_usage WHERE session_id = ?', session.id);
    expect(row).toMatchObject({ agent_id: agent.id, project_id: project.id, goal_id: goal.id, input_tokens: 40, output_tokens: 6 });
  });
});
