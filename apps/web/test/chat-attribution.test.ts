/**
 * Chat with agents, first slice (docs/specs/16): agent labels on streamed chunks and stored transcript messages, the
 * page showing who answered and who was asked, and the "Chat with a team" template. A flow without labels is unchanged.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-attribution-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { wireChunk, chunkAgent } = await import('@/lib/server/streaming');
const { appendTranscript, loadTranscript } = await import('@/lib/server/chat');
const { CHAT_CLIENT_JS } = await import('@/lib/server/chat-client');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates/builtin');
const templates = await import('@/lib/server/templates');
const { normalizeWorkflow, validateWorkflow } = await import('@/lib/server/mcp/workflows');
registry.registerBuiltin(corePlugin);

type Chunk = Extract<ExecutionEvent, { type: 'node.chunk' }>['chunk'];
const event = (chunk: Chunk & { agent?: unknown }) => ({ type: 'node.chunk', executionId: 'e1', nodeId: 'n1', nodeName: 'Lead', chunk, at: '2026-11-07T10:00:00.000Z' }) as Extract<ExecutionEvent, { type: 'node.chunk' }>;

describe('agent labels on the wire', () => {
  it('carries { id, name, face } when the node labels its chunk', () => {
    const wire = wireChunk(event({ type: 'item', content: 'Hi', itemIndex: 0, agent: { id: 'ag_1', name: 'Billing', face: '🧾' } }));
    expect(wire).toMatchObject({ type: 'item', content: 'Hi', agent: { id: 'ag_1', name: 'Billing', face: '🧾' }, metadata: { nodeId: 'n1', nodeName: 'Lead', itemIndex: 0 } });
  });

  it('a chunk without a label streams exactly as before', () => {
    const wire = wireChunk(event({ type: 'item', content: 'Hi', itemIndex: 0 }));
    expect(wire).toEqual({ type: 'item', content: 'Hi', metadata: { nodeId: 'n1', nodeName: 'Lead', itemIndex: 0, timestamp: Date.parse('2026-11-07T10:00:00.000Z') } });
    expect('agent' in wire).toBe(false);
  });

  it('drops a malformed label instead of passing it on', () => {
    for (const agent of [null, 'Billing', { id: 'x' }, { name: 'x' }, { id: '', name: 'x' }, { id: 1, name: 'x' }]) expect(chunkAgent({ agent })).toBeUndefined();
    expect('agent' in wireChunk(event({ type: 'item', content: 'x', agent: { id: 'x' } }))).toBe(false);
    expect(chunkAgent({ agent: { id: 'a', name: 'B', face: 5 } })).toEqual({ id: 'a', name: 'B' });
  });

  it('keeps the reason of a delegation on the tool chunk', () => {
    const wire = wireChunk(event({ type: 'tool', tool: { id: 't1', name: 'Billing', status: 'started', input: { message: 'Refund?', reason: 'A billing question' } } }));
    expect((wire.tool as unknown as { input: { reason: string } }).input.reason).toBe('A billing question');
  });
});

describe('transcript attribution', () => {
  it('round-trips agentKey and agentName, and leaves unlabelled messages as they were', () => {
    appendTranscript('wf_a', 's1', [
      { role: 'user', text: 'Refund?', at: '2026-11-07T10:00:00.000Z' },
      { role: 'assistant', text: 'Sure.', at: '2026-11-07T10:00:01.000Z', executionId: 'e1', agentKey: 'ag_1', agentName: 'Billing' },
      { role: 'assistant', text: 'Anything else?', at: '2026-11-07T10:00:02.000Z' },
    ]);
    const [user, labelled, plain] = loadTranscript('wf_a', 's1');
    expect(labelled).toMatchObject({ role: 'assistant', executionId: 'e1', agentKey: 'ag_1', agentName: 'Billing' });
    expect(user).toEqual({ role: 'user', text: 'Refund?', at: '2026-11-07T10:00:00.000Z' });
    expect(plain).toEqual({ role: 'assistant', text: 'Anything else?', at: '2026-11-07T10:00:02.000Z' });
  });
});

describe('the page shows who answered', () => {
  it('is valid JavaScript and reads the label, the stored agent name and the delegation reason', () => {
    expect(() => new Function(CHAT_CLIENT_JS)).not.toThrow();
    expect(CHAT_CLIENT_JS).toContain('chunk.agent');
    expect(CHAT_CLIENT_JS).toContain('m.agentName');
    expect(CHAT_CLIENT_JS).toContain('chunk.tool.input.reason');
    expect(CHAT_CLIENT_JS).toContain("'asked '");
  });
});

describe('the "Chat with a team" template', () => {
  const template = BUILTIN_TEMPLATES.find((t) => t.id === 'chat-with-a-team')!;

  it('is built in and validates with no warnings', () => {
    expect(template).toBeDefined();
    const result = validateWorkflow({ ...normalizeWorkflow(structuredClone(template.workflow)), id: 'wf_team_chat' });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('has a chat trigger, guardrails, a lead with two specialists and a data table to save to', () => {
    const types = template.workflow.nodes.map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(['core.chatTrigger', 'core.guardrails', 'core.dataTable']));
    expect(types.filter((t) => t === 'core.messageAgent')).toHaveLength(3);
    const lead = template.workflow.nodes.find((n) => n.name === 'Lead')!;
    // Every Run an Agent node names an agent the template creates.
    for (const n of template.workflow.nodes.filter((n) => n.type === 'core.messageAgent')) expect(template.bundle!.agents.map((a) => a.key)).toContain(n.parameters.agentId);
    expect(template.workflow.connections.filter((c) => c.type === 'ai_tool' && c.target === lead.id)).toHaveLength(3);
    expect(template.dataTables.map((d) => d.name)).toContain('Chat notes');
  });

  it('is used like any team template: three fresh agents, a team, and Run an Agent nodes pointing at the copies', async () => {
    const used = await templates.useTemplate('chat-with-a-team', {});
    expect(used.agents!.map((a) => a.name).sort()).toEqual(['Billing', 'Lead', 'Technical']);
    const ids = new Set(used.agents!.map((a) => a.id));
    const runs = used.workflow!.nodes.filter((n) => n.type === 'core.messageAgent');
    expect(runs).toHaveLength(3);
    for (const n of runs) expect(ids.has(String(n.parameters.agentId))).toBe(true);
  });
});
