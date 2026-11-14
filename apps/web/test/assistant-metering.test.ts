/**
 * Spotlight and the Agent architect count in AI usage: each model call writes an `ai_usage` row with `surface`, the
 * caller's id and the workflow, the per-user caps apply, and `done` says what it cost and whether the model was local.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { ChatEvent } from '@/lib/server/assistant/chat';

/** The model the chat route resolves (a test's scripted one); a model object passed in directly is used as is. */
const routeModel = vi.hoisted(() => ({ current: undefined as LanguageModel | undefined }));
vi.mock('@/lib/server/assistant/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/assistant/model')>();
  return { ...actual, assistantModel: (override?: string | LanguageModel) => (typeof override === 'object' ? override : (routeModel.current ?? actual.assistantModel(override))) };
});

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-assistant-metering-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { runChat } = await import('@/lib/server/assistant/chat');
const { runArchitect } = await import('@/lib/server/assistant/architect');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { traceChat } = await import('@/lib/server/telemetry');
const { database } = await import('@/lib/server/db');
const { meteredWorkflowId } = await import('@/lib/server/assistant/scope');
const { TOOLS } = await import('@/lib/server/assistant/chat');
const { TOOL_NAMES } = await import('@/lib/server/assistant/guards');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

beforeEach(() => {
  saveAiCaps({ credentials: {}, users: {} });
  aiUsageMeter().invalidateCaps();
  database().sqlite.exec('DELETE FROM ai_usage');
});

const workflow = (): Workflow => ({ id: 'wf_metered', name: 'Metered', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] });

/** A model that reports its tokens the way the real adapters do (through the metered chat span). */
function metered(provider: string, turns: Array<Partial<ModelTurn> & { tokens?: number }>): LanguageModel {
  return {
    provider,
    model: 'metered-model',
    generate: () => {
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return traceChat({ system: provider, model: 'metered-model' }, async () => ({ text: '', toolCalls: [], stopReason: 'stop' as const, ...next }), () => ({ inputTokens: next.tokens ?? 100, outputTokens: 20 }));
    },
  };
}

const rows = () => database().all<{ surface: string | null; user_id: string | null; workflow_id: string | null; provider: string; input_tokens: number }>('SELECT surface, user_id, workflow_id, provider, input_tokens FROM ai_usage ORDER BY at');

async function chat(model: LanguageModel) {
  const events: ChatEvent[] = [];
  await runChat({ messages: [{ role: 'user', content: 'Hello' }], workflow: workflow(), model, types, trace: true, userId: TEST_OWNER.id, onEvent: (e) => events.push(e) });
  return events;
}

describe('assistant metering', () => {
  it('writes one ai_usage row per Spotlight call, with its surface, user and workflow', async () => {
    const events = await chat(metered('anthropic', [{ text: 'Hi there.' }]));
    expect(rows()).toEqual([{ surface: 'spotlight', user_id: TEST_OWNER.id, workflow_id: 'wf_metered', provider: 'anthropic', input_tokens: 100 }]);
    const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
    expect(done.local).toBe(false);
    expect(done.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('does not count Spotlight against the workflow’s own per-day cap', async () => {
    await chat(metered('anthropic', [{ text: 'Hi there.' }]));
    expect(rows()).toHaveLength(1);
    expect(aiUsageMeter().workflowDay('wf_metered').inputTokens).toBe(0);
  });

  it('attributes Spotlight to a workflow only when the caller can read it', () => {
    expect(meteredWorkflowId(undefined, TEST_OWNER)).toBeUndefined();
    expect(meteredWorkflowId('wf_not_mine', { id: 'usr_nobody', role: 'member' } as Parameters<typeof meteredWorkflowId>[1])).toBeUndefined();
  });

  it('books a member’s Spotlight call on no workflow when they cannot read the one they sent (through the route)', async () => {
    const { store } = await import('@/lib/server/store');
    const projects = await import('@/lib/server/projects');
    const { personalProjectId } = await import('@/lib/shared/projects');
    const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
    const chatRoute = await import('@/app/api/assistant/chat/route');
    const hidden = { ...workflow(), id: 'wf_owners_only', name: 'Owner only' };
    store.saveWorkflow(hidden);
    projects.setHomeProject('workflow', hidden.id, personalProjectId(TEST_OWNER.id));
    const member = { ...TEST_OWNER, id: 'usr_metering_member', email: 'member@metering.test', name: 'Member', role: 'member' as const };
    routeModel.current = metered('anthropic', [{ text: 'Hi there.' }]);
    enableTestAuth(member);
    try {
      const response = await chatRoute.POST(new Request('http://localhost/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }], workflow: hidden, workflowId: hidden.id }) }));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: done');
    } finally {
      enableTestAuth();
      routeModel.current = undefined;
    }
    expect(rows()).toEqual([{ surface: 'spotlight', user_id: member.id, workflow_id: null, provider: 'anthropic', input_tokens: 100 }]);
  });

  it('recovers every tool the chat offers from text', () => {
    expect([...TOOL_NAMES].sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('counts every step of a reply', async () => {
    await chat(metered('anthropic', [{ toolCalls: [{ id: 'c1', name: 'get_workflow', input: {} }] }, { text: 'It has a trigger.' }]));
    expect(rows().map((r) => r.surface)).toEqual(['spotlight', 'spotlight']);
  });

  it('says a local model is local', async () => {
    const events = await chat(metered('ollama', [{ text: 'Hi.' }]));
    expect(events.at(-1)).toMatchObject({ type: 'done', local: true });
  });

  it('counts the architect as surface architect', async () => {
    await runArchitect({ messages: [{ role: 'user', content: 'An agent' }], model: metered('anthropic', [{ text: 'Sure.' }]), types, actor: TEST_OWNER, trace: true, onEvent: () => undefined });
    expect(rows()).toMatchObject([{ surface: 'architect', user_id: TEST_OWNER.id, workflow_id: null }]);
  });

  it('stops the chat with a cap error when the caller’s cap is reached', async () => {
    saveAiCaps({ credentials: {}, users: { [TEST_OWNER.id]: { name: 'Test Owner', dayTokens: 100 } } });
    aiUsageMeter().invalidateCaps();
    // The first call goes over the cap (120 tokens of 100): its result is lost, it is counted, and the next one is refused.
    const first = await chat(metered('anthropic', [{ text: 'Hi.' }]));
    expect(first.at(-1)).toMatchObject({ type: 'error', kind: 'cap', message: expect.stringContaining('AI usage cap reached') });
    expect(first.some((e) => e.type === 'done')).toBe(false);
    const second = await chat(metered('anthropic', [{ text: 'Hi again.' }]));
    expect(second.at(-1)).toMatchObject({ type: 'error', kind: 'cap' });
    expect(rows()).toHaveLength(1);
  });
});
