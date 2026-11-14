/**
 * Propose Flows with a real model. Skipped unless LANDFLOW_INTEGRATION names ollama:
 *   LANDFLOW_INTEGRATION=ollama npx vitest run test/velocity-live.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const enabled = process.env.LANDFLOW_INTEGRATION?.split(',').includes('ollama');

vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!enabled)('Propose Flows with Ollama', () => {
  it('returns ideas with titles and build prompts for each signal', async () => {
    Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-velocity-live-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
    if (process.env.LANDFLOW_BRAIN_MODEL?.toLowerCase() === 'off') delete process.env.LANDFLOW_BRAIN_MODEL;
    const { proposeFlowsNode } = await import('@/lib/server/nodes/velocity');
    const { runOk } = await import('./helpers');
    const signals = [
      { type: 'reviewWait', scope: 'acme/api', key: 'reviewWait:acme/api', value: 30, unit: 'hours', threshold: 24, count: 4, evidence: ['ue_1', 'ue_2'], summary: 'Pull requests in acme/api waited a median of 30 hours for a first review over 4 pull requests in 14 days.' },
      { type: 'flakyCi', scope: 'acme/web', key: 'flakyCi:acme/web', value: 3, unit: 'count', threshold: 2, count: 3, evidence: ['ue_3', 'ue_4'], summary: 'CI in acme/web failed and then passed on the same commit 3 times in 14 days.' },
    ];
    const ideas = (await runOk(proposeFlowsNode, { useModel: true, limit: 5 }, signals)).json();
    expect(ideas).toHaveLength(2);
    for (const idea of ideas) {
      expect(String(idea.title).length).toBeGreaterThan(5);
      expect(String(idea.buildPrompt).length).toBeGreaterThan(30);
      expect(String(idea.buildPrompt).length).toBeLessThanOrEqual(2_000);
      expect(['model', 'rules']).toContain(idea.by);
    }
  });
});
