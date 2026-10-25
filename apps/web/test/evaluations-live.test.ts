/**
 * Evaluations against a real Ollama judge (qwen3-coder:30b): an offline run over a Data Table scored by the
 * LLM-judge correctness metric, and an online grade of an agent conversation.
 *   LANDFLOW_INTEGRATION=ollama npx vitest run test/evaluations-live.test.ts
 * OLLAMA_URL picks the server (default http://127.0.0.1:11434); LANDFLOW_OLLAMA_CHAT_MODEL the judge model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AgentSession } from '@/lib/shared/agents';

const enabled = process.env.LANDFLOW_INTEGRATION?.split(',').includes('ollama');
const baseUrl = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const chatModel = process.env.LANDFLOW_OLLAMA_CHAT_MODEL ?? 'qwen3-coder:30b';
const LIVE_TIMEOUT = 300_000;

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-evaluations-live-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { dataTables } = await import('@/lib/server/datatables');
const { agentStore } = await import('@/lib/server/agents/store');
const { startEvaluation, evaluationDone, evaluationDetail } = await import('@/lib/server/evaluations/runner');
const online = await import('@/lib/server/evaluations/online');
const evalStore = await import('@/lib/server/evaluations/store');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** A stand-in for the system under test: right about Paris and 2+2, wrong about the sky. */
const ANSWER_CODE = `const answers = { '2+2': '4', 'capital of France': 'The capital of France is Paris.', 'color of the sky': 'The sky is green.' };
return { output: answers[$json.question] ?? 'I do not know' };`;

describe.skipIf(!enabled)('live: evaluations with an Ollama judge', () => {
  it(
    'runs an evaluation over a Data Table: one execution per row, scored by the correctness judge',
    async () => {
      const table = dataTables().createTable({ name: 'live_qa', columns: ['question', 'expected'].map((name) => ({ name, type: 'string' as const })) });
      dataTables().insertRows(table.id, [
        { question: '2+2', expected: '4' },
        { question: 'capital of France', expected: 'Paris' },
        { question: 'color of the sky', expected: 'blue' },
      ]);
      const nodes = [
        { name: 'Trigger', type: 'core.evaluationTrigger', parameters: { dataTableId: table.id } },
        { name: 'Answer', type: 'core.code', parameters: { mode: 'each', codeEach: ANSWER_CODE } },
        { name: 'Record', type: 'core.evaluation', parameters: { operation: 'setOutputs', outputs: { values: [{ name: 'answer', value: '{{ $json.output }}' }] } } },
        { name: 'Exact', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'exactMatch' } },
        { name: 'Correct', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'correctness' } },
        { name: 'Judge', type: 'core.ollamaChatModel', parameters: { baseUrl, model: chatModel, temperature: 0 } },
      ];
      const edges: Array<[string, string, string]> = [
        ['Trigger', 'Answer', 'main'],
        ['Answer', 'Record', 'main'],
        ['Record', 'Exact', 'main'],
        ['Exact', 'Correct', 'main'],
        ['Judge', 'Correct', 'ai_languageModel'],
      ];
      const workflow = store.saveWorkflow({
        id: 'wf_eval_live',
        name: 'Live evaluation',
        nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [i * 200, 0], parameters: n.parameters })),
        connections: edges.map(([source, target, type], i) => ({ id: `e${i}`, type, source, target, sourceIndex: 0, targetIndex: 0 })),
      } as Workflow);

      const started = startEvaluation(workflow.id);
      const done = await evaluationDone(started.id);
      const detail = evaluationDetail(started.id)!;
      console.info(
        `[live eval] run #${done?.number} ${done?.status} in ${done?.durationMs} ms:`,
        JSON.stringify(detail.cases.map((c) => ({ q: c.inputs.question, answer: c.outputs.answer, ...c.metrics, why: c.reasons?.correctness }))),
      );
      expect(done).toMatchObject({ status: 'success', total: 3, completed: 3, failed: 0 });
      expect(done!.metrics.exactMatch.average).toBeCloseTo(1 / 3);
      const [math, paris, sky] = detail.cases;
      expect(math.metrics.correctness).toBeGreaterThanOrEqual(4);
      expect(paris.metrics.correctness).toBeGreaterThanOrEqual(4);
      expect(sky.metrics.correctness).toBeLessThanOrEqual(2);
      expect(sky.reasons?.correctness).toBeTruthy();
      // Every case links its execution, kept out of the production counts.
      for (const testCase of detail.cases) expect(store.getExecution(testCase.executionId!)?.evaluation?.runId).toBe(started.id);
    },
    LIVE_TIMEOUT,
  );

  it(
    'grades an agent conversation online and flags a wrong reply',
    async () => {
      const agent = agentStore.create({ name: 'Maths helper', model: { provider: 'ollama', model: chatModel, baseUrl } });
      const target = online.agentTarget(agent.id);
      evalStore.saveOnlineConfig(target, { ...evalStore.getOnlineConfig(target), enabled: true, sampleRate: 100, rubric: 'The reply gives the correct result of the arithmetic.', lowScore: 2 });
      const conversation = (id: string, reply: string) => {
        const at = new Date().toISOString();
        agentStore.saveSession({
          id,
          agentId: agent.id,
          agentName: agent.name,
          source: 'test',
          userId: 'you',
          title: 'Maths',
          status: 'idle',
          version: 'draft',
          messages: [],
          timeline: [
            { id: 't1', type: 'user', text: 'What is 6*7?', at },
            { id: 't2', type: 'assistant', text: reply, at },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          traceIds: [],
          createdAt: at,
          updatedAt: at,
        } as AgentSession);
      };
      conversation('ses_live_good', '6 × 7 = 42.');
      conversation('ses_live_bad', '6 × 7 = 48.');
      const good = await online.gradeAgentSession(agent.id, 'ses_live_good');
      const bad = await online.gradeAgentSession(agent.id, 'ses_live_bad');
      console.info(`[live online] good=${good.score} (${good.reasoning}) bad=${bad.score} (${bad.reasoning})`);
      expect(good).toMatchObject({ flagged: false, judge: `ollama/${chatModel}` });
      expect(good.score).toBeGreaterThanOrEqual(4);
      expect(bad).toMatchObject({ flagged: true });
      expect(online.onlineReport(target)).toMatchObject({ total: 2, flagged: 1 });
    },
    LIVE_TIMEOUT,
  );
});
