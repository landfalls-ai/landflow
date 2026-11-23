/**
 * Wave ag3 carryover (the live pass, Grafana agent): the design's test cases included "What does the dashboard at
 * https://grafana.example.com/api/dashboards/uid/abc123 show?", a URL nobody gave, which the smoke test and the gate would
 * send the agent's HTTP Request to (lesson 21). A case naming a URL whose host is not in what the person wrote nor in a tool's
 * own settings is dropped from the design; a URL the person gave stays; too few cases left → the card asks for cases.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { startFakeModels } from './fake-ai-services';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-cases-url-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { casesWithoutMadeUpUrls } = await import('@/lib/server/assistant/architect');
const { plugin: grafana } = await import('../../../plugins/grafana/src/main');

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(grafana);
});

describe('a test case never names a URL nobody gave', () => {
  it('drops the made-up URL, keeps a given one and cases with none, in order', () => {
    const cases = [
      { input: 'Which alerts are firing right now?' },
      { input: 'What does the dashboard at https://grafana.example.com/api/dashboards/uid/abc123 show?' },
      { input: 'Read http://127.0.0.1:53188/api/dashboards/uid/ops', expected: 'Names the panels' },
      { input: 'Any alert?', expected: 'See https://made.up/runbook' },
    ];
    expect(casesWithoutMadeUpUrls(cases, 'dashboards at http://127.0.0.1:53188', {}).map((c) => c.input)).toEqual(['Which alerts are firing right now?', 'Read http://127.0.0.1:53188/api/dashboards/uid/ops']);
    // a host in a tool's own settings counts as given
    const config = { tools: [{ name: 'http_request', parameters: { url: 'https://grafana.example.com/api/search' } }] } as never;
    expect(casesWithoutMadeUpUrls(cases, '', config)).toHaveLength(2);
  });

  it("the design route's cases leave the made-up URL out, and ask for cases when too few are left", async () => {
    const proposal = (cases: string) => ({
      summary: 'x',
      role: 'Alert reader',
      instructions: 'Input: a question.\nSteps:\n1. Call get_alerts.\n2. Read the dashboard with http_request.\nOutput: an answer.\nHand over when: not about alerts.',
      description: 'Tells which Grafana alerts are firing.',
      model: 'ollama/qwen3-coder:30b',
      nodeTools: 'grafana.getAlerts, core.httpRequest',
      cases,
    });
    const run = async (cases: string) => {
      const fake = await startFakeModels({ reply: (_p, body) => (Array.isArray((body as { messages?: unknown })?.messages) ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: proposal(cases) }] } : { text: '', toolCalls: [] }) });
      const previous = process.env.OLLAMA_URL;
      process.env.OLLAMA_URL = fake.origin;
      try {
        return (await (await post({ name: 'Grafana alerts agent', preview: true, ask: 'Create an agent that tells me which Grafana alerts are firing and what the dashboards show.', description: 'Tells which Grafana alerts are firing and what the dashboards show.' })).json()) as { cases: Array<{ input: string }>; needs: Array<{ tool: string; text: string }> };
      } finally {
        if (previous === undefined) delete process.env.OLLAMA_URL;
        else process.env.OLLAMA_URL = previous;
        await fake.close();
      }
    };
    const four = await run('Which alerts are firing? => Names them\nDetails on High CPU? => Explains it\nWhat does the dashboard at https://grafana.example.com/d/abc show? => Describes it\nAnything critical? => Says which');
    expect(four.cases.map((c) => c.input)).toEqual(['Which alerts are firing?', 'Details on High CPU?', 'Anything critical?']);
    expect(JSON.stringify(four)).not.toContain('grafana.example.com');
    const three = await run('Which alerts are firing? => Names them\nRead https://grafana.example.com/d/abc => Describes it\nAnything critical? => Says which');
    expect(three.cases).toHaveLength(2);
    expect(three.needs.some((n) => n.tool === 'test cases')).toBe(true);
  });
});
