/**
 * AG24 fix pass: a new agent built from a folder (its knowledge base is indexed only on Create) has its cases checked against the
 * folder's file names, not only against an indexed collection.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startFakeModels } from './fake-ai-services';

const root = mkdtempSync(join(tmpdir(), 'landflow-ag24-folder-'));
const files = join(root, 'files');
mkdirSync(join(files, 'runbooks'), { recursive: true });
writeFileSync(join(files, 'runbooks', 'failover-runbook.md'), '# Failover\nPromote the replica.\n');
Object.assign(process.env, { LANDFLOW_FILES_DIR: files, LANDFLOW_DATA_DIR: join(root, 'data'), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));

describe('a new design from a folder not indexed yet', () => {
  it('cases naming a runbook the folder lacks are dropped, the one it holds stays', async () => {
    const fake = await startFakeModels({
      reply: (_p, body) => {
        if (!Array.isArray((body as { messages?: unknown })?.messages)) return { text: '', toolCalls: [] };
        if (JSON.stringify(body).includes('You write test cases')) return { text: 'How do I fail over? => Quotes the failover steps.\nWhat does the failover runbook say about the replica? => Answers from the failover runbook.', toolCalls: [] };
        return { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Runbook helper', description: 'Answers from the incident runbooks.', model: 'ollama/qwen3-coder:30b', instructions: 'Input: a question.\nSteps:\n1. Search the runbooks.\nOutput: the answer.', nodeTools: '', cases: 'What does the payments runbook say about rollbacks? => Quotes the payments runbook.\nHow do I restore the payments service? => Quotes the payments runbook.\nWhat does the failover runbook say about the primary? => Quotes the failover runbook.' } }] };
      },
    });
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = fake.origin;
    try {
      const body = (await (await post({ name: 'Runbook helper', description: 'Answers questions from our incident runbooks', ask: 'Make an agent that answers questions from our incident runbooks in the folder runbooks', knowledgeFolder: 'runbooks', knowledgeAsked: true, preview: true })).json()) as { cases: Array<{ input: string }>; needs: unknown[] };
      const inputs = body.cases.map((c) => c.input);
      expect(inputs.some((i) => /payments/i.test(i))).toBe(false);
      expect(inputs.some((i) => /fail/i.test(i))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    }
  });
});
