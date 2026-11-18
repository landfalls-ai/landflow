/**
 * Re-review finding 4: a Run an Agent step that fails before its session starts ("The message is empty") still records the agent
 * version it was going to run, so the run carries its “workflow vN · agent vM” label.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-failed-label-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { database } = await import('@/lib/server/db');
registry.registerBuiltin(corePlugin);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

describe('a failed Run an Agent step', () => {
  it('records the agent version before it checks the message', async () => {
    const agent = agentStore.create({ name: 'Mailer', instructions: 'You send emails.', model: { provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:1' }, tools: [] });
    agentStore.publish(agent.id);
    const wf: Workflow = { id: 'wf_label', name: 'label', nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId: agent.id, message: '' })], connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }] };
    store.saveWorkflow(wf);
    const record = await runWorkflow({ workflow: wf, mode: 'manual', startNodeId: 'Start', triggerItems: [{ json: {} }] });
    expect(record.error?.message ?? '').toContain('The message is empty');
    const rows = database().all<{ agent_id: string; source: string }>('SELECT agent_id, source FROM execution_agent_versions WHERE execution_id = ?', record.executionId);
    expect(rows).toEqual([expect.objectContaining({ agent_id: agent.id })]);
  });
});
