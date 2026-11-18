/**
 * AG21 (wave ag4 review): a production copy carries its agents' pins on every replica. The hook (`productionPins.apply`) was set
 * only by loading lib/server/agents/versions, which a replica that is not the leader (no backfill) loaded lazily, so its copy had no pin.
 * Here nothing but publish.ts is loaded first, the way such a replica starts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { PIN_PARAM } from '@/lib/shared/agent-versions';

vi.setConfig({ testTimeout: 30_000 });
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-pins-replica-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const publish = await import('@/lib/server/publish');
const { productionPins } = await import('@/lib/server/versions');

describe('production pins on every replica', () => {
  it('publish.ts alone sets the hook, and a fresh production copy carries PIN_PARAM', async () => {
    expect(productionPins.apply, 'the hook is set by loading publish.ts').toBeTypeOf('function');
    const { registry } = await import('@/lib/server/plugins/registry');
    const { corePlugin } = await import('@/lib/server/nodes');
    registry.registerBuiltin(corePlugin);
    const { store } = await import('@/lib/server/store');
    const { agentStore } = await import('@/lib/server/agents/store');
    const agent = agentStore.create({ name: 'Pinned helper', instructions: 'Answer.', model: { provider: 'ollama', model: 'm' } });
    agentStore.publish(agent.id);
    const node = (id: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name: id, type, typeVersion: 1, position: [0, 0] as [number, number], parameters });
    const wf: Workflow = { id: 'wf_replica', name: 'Replica', nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId: agent.id, message: 'hi', conversation: 'new' })], connections: [{ id: 'c', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }] };
    store.saveWorkflow(wf);
    await publish.publishDraft('wf_replica', 'owner');
    expect(publish.productionWorkflowById('wf_replica')!.nodes.find((n) => n.id === 'Agent')!.parameters[PIN_PARAM]).toBe(1);
  });
});
