/**
 * AG03: a plugin node used as an agent's tool gets the data (an `item` argument). Normalize Alert and Extract IOCs
 * (the triage plugin, in-process) used to run on the model's settings alone and put out an empty alert.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NodeToolConfig } from '@/lib/shared/agents';

vi.setConfig({ testTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-node-tool-item-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { buildToolset } = await import('@/lib/server/agents/tools');
const { plugin: triage } = await import('../../../plugins/triage/src/main');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(triage);

const tool = (id: string, name: string, nodeType: string, parameters: Record<string, unknown> = {}): NodeToolConfig => ({ id, type: 'node', name, description: '', nodeType, parameters });

// The Wazuh alert of the live host's check (A5).
const wazuhAlert = {
  timestamp: '2026-11-17T09:12:44.000+0000',
  rule: { level: 12, description: 'sshd: brute force trying to get access to the system.', id: '5763', groups: ['sshd', 'authentication_failures'] },
  agent: { id: '003', name: 'bastion-1', ip: '10.0.4.12' },
  id: '1763370764.1001',
  full_log: 'Nov 17 09:12:43 bastion-1 sshd[2211]: Failed password for root from 203.0.113.45 port 52144 ssh2; callback to bad-login.example.net',
  data: { srcip: '203.0.113.45', srcuser: 'root' },
};

async function toolsFor(...tools: NodeToolConfig[]) {
  const agent = agentStore.create({ name: 'Triager', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools });
  const toolset = await buildToolset(agent, agent);
  const ctx = { agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), depth: 0, maxDepth: 2, runId: 'run_1', signal: new AbortController().signal } as never;
  return { toolset, ctx };
}

describe('a node tool that reads its whole input item', () => {
  it('Normalize Alert gets the alert as `item` and puts out a full alert', async () => {
    const { toolset, ctx } = await toolsFor(tool('t1', 'normalize_alert', 'triage.normalizeAlert'));
    const normalize = toolset.tools.find((t) => t.name === 'normalize_alert')!;
    expect(normalize.inputSchema).toMatchObject({ required: ['item'] });
    const outcome = await normalize.invoke({ item: wazuhAlert, format: 'wazuh' }, ctx);
    const alert = (outcome.output as { alert: { title: string; severity: string; raw?: unknown; [k: string]: unknown } }).alert;
    expect(alert.title).toBeTruthy();
    expect(alert.severity).toBeTruthy();
    expect(JSON.stringify(alert)).toContain('203.0.113.45');
  });

  it('Extract IOCs gets the same item and finds the address and the domain', async () => {
    const { toolset, ctx } = await toolsFor(tool('t2', 'extract_iocs', 'triage.extractIocs'));
    const extract = toolset.tools.find((t) => t.name === 'extract_iocs')!;
    const outcome = await extract.invoke({ item: wazuhAlert }, ctx);
    const text = JSON.stringify(outcome.output);
    expect(text).toContain('203.0.113.45');
    expect(text).toContain('bad-login.example.net');
  });
});
