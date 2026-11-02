/**
 * Run traces over OTLP (lib/server/journal/otlp-export.ts): a fake OTLP/HTTP endpoint receives a finished run's journal as
 * one trace with parent links, statuses and OpenInference attributes, in batches, with one retry; and a run that ends
 * through the runner's segment hook goes out without the run waiting for it.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent, Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-otlp-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { journalOf, releaseJournal, resetJournals, traceSegment } = await import('@/lib/server/journal');
const { exportRunTraces, journalToOtlp, openInferenceKind } = await import('@/lib/server/journal/otlp-export');
const { store } = await import('@/lib/server/store');

interface Received {
  headers: IncomingMessage['headers'];
  body: { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> }; scopeSpans: Array<{ spans: any[] }> }> };
}
let server: Server;
let url = '';
let received: Received[] = [];
/** Statuses to answer with, one per request; 200 after they run out. */
let answers: number[] = [];

const listening = new Promise<void>((resolve) => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c) => chunks.push(c));
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.statusCode = answers.shift() ?? 200;
      response.end('{}');
    });
  }).listen(0, '127.0.0.1', () => {
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
    resolve();
  });
});
await listening;

afterAll(() => {
  server.close();
  resetJournals();
  for (const key of [...Object.keys(ENV), 'LANDFLOW_OTLP_TRACES_URL']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeEach(() => {
  received = [];
  answers = [];
  delete process.env.LANDFLOW_OTLP_TRACES_URL;
});

const dev = { id: 'node:dev', name: 'Developer', type: 'agent' as const };
const attr = (span: any, key: string) => {
  const found = span.attributes.find((a: { key: string }) => a.key === key)?.value;
  return found && (found.stringValue ?? found.intValue ?? found.doubleValue ?? found.boolValue);
};

function seed(id: string, extra = 0) {
  store.saveExecution({ executionId: id, workflowId: 'wf_otlp', workflowName: 'OTLP flow', mode: 'manual', status: 'error', startedAt: new Date().toISOString(), durationMs: 5000, runData: {}, executionOrder: [] });
  const at = (s: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + s * 1000).toISOString();
  const journal = journalOf(id, { workflowId: 'wf_otlp' });
  journal.record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'OTLP flow', actor: { id: 'workflow', name: 'OTLP flow', type: 'system' }, at: at(0), traceId: 'abcdef0123456789abcdef0123456789' });
  journal.record({ type: 'span.started', spanId: 'node:dev:0', parentSpanId: 'run', kind: 'agent', name: 'Developer', actor: dev, input: 'Fix the bug', at: at(1) });
  journal.record({ type: 'span.started', spanId: 'node:dev:0/model:1', parentSpanId: 'node:dev:0', kind: 'model', name: 'claude-sonnet-5-5', actor: { id: 'model:claude-sonnet-5-5', name: 'claude-sonnet-5-5', type: 'model' }, caller: dev, at: at(2) });
  journal.record({ type: 'span.ended', spanId: 'node:dev:0/model:1', status: 'success', usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 400, costUsd: 0.004, model: 'claude-sonnet-5-5' }, at: at(3) });
  journal.record({ type: 'span.started', spanId: 'node:dev:0/step:1', parentSpanId: 'node:dev:0', kind: 'tool', name: 'Bash', actor: dev, input: { command: 'pnpm test' }, at: at(3) });
  journal.record({ type: 'span.ended', spanId: 'node:dev:0/step:1', status: 'error', error: 'exit 1', at: at(4) });
  journal.record({ type: 'check', spanId: 'node:dev:0', check: { name: 'tests', status: 'fail', message: '1 failed', source: 'node' }, at: at(4) });
  journal.record({ type: 'span.ended', spanId: 'node:dev:0', status: 'success', output: 'Could not fix it', at: at(5) });
  for (let i = 0; i < extra; i++) {
    journal.record({ type: 'span.started', spanId: `run/extra:${i}`, parentSpanId: 'run', kind: 'step', name: `Extra ${i}`, actor: dev, at: at(5) });
    journal.record({ type: 'span.ended', spanId: `run/extra:${i}`, status: 'success', at: at(5) });
  }
  journal.record({ type: 'span.ended', spanId: 'run', status: 'error', error: 'Developer failed', at: at(6) });
  releaseJournal(id);
}

describe('OTLP export of a run', () => {
  it('sends the journal as one trace with parent links, statuses and OpenInference attributes', async () => {
    seed('ot_1');
    process.env.LANDFLOW_OTLP_TRACES_URL = url;
    expect(await exportRunTraces('ot_1')).toEqual({ spans: 4, requests: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].headers['content-type']).toContain('application/json');
    const [resource] = received[0].body.resourceSpans;
    expect(resource.resource.attributes.find((a) => a.key === 'service.name')).toBeDefined();
    const spans = resource.scopeSpans[0].spans;
    // One trace, the run's own OTel trace id.
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set(['abcdef0123456789abcdef0123456789']));
    const by = (name: string) => spans.find((s) => s.name === name)!;
    const root = by('OTLP flow');
    const agent = by('Developer');
    const model = by('claude-sonnet-5-5');
    const tool = by('Bash');
    expect(root.parentSpanId).toBeUndefined();
    expect(agent.parentSpanId).toBe(root.spanId);
    expect(model.parentSpanId).toBe(agent.spanId);
    expect(tool.parentSpanId).toBe(agent.spanId);
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(4);
    expect(spans.every((s) => /^[0-9a-f]{16}$/.test(s.spanId))).toBe(true);
    // Times and status.
    expect(BigInt(model.endTimeUnixNano) - BigInt(model.startTimeUnixNano)).toBe(1_000_000_000n);
    expect(root.status).toEqual({ code: 2, message: 'Developer failed' });
    expect(agent.status).toEqual({ code: 1 });
    expect(tool.status).toEqual({ code: 2, message: 'exit 1' });
    // OpenInference.
    expect([root, agent, model, tool].map((s) => attr(s, 'openinference.span.kind'))).toEqual(['CHAIN', 'AGENT', 'LLM', 'TOOL']);
    expect(attr(model, 'llm.model_name')).toBe('claude-sonnet-5-5');
    expect(attr(model, 'llm.token_count.prompt')).toBe('900');
    expect(attr(model, 'llm.token_count.completion')).toBe('60');
    expect(attr(agent, 'input.value')).toBe('Fix the bug');
    expect(attr(agent, 'output.value')).toBe('Could not fix it');
    expect(attr(tool, 'input.value')).toBe('{"command":"pnpm test"}');
    expect(attr(tool, 'input.mime_type')).toBe('application/json');
    expect(attr(agent, 'landflow.actor')).toBe('Developer');
    expect(attr(agent, 'landflow.execution_id')).toBe('ot_1');
    expect(agent.events).toEqual([expect.objectContaining({ name: 'check' })]);
  });

  it('batches big runs and does nothing when no endpoint is set', async () => {
    seed('ot_2', 205);
    expect(await exportRunTraces('ot_2')).toBeUndefined();
    expect(received).toHaveLength(0);
    process.env.LANDFLOW_OTLP_TRACES_URL = url;
    expect(await exportRunTraces('ot_2')).toEqual({ spans: 209, requests: 2 });
    expect(received.map((r) => r.body.resourceSpans[0].scopeSpans[0].spans.length)).toEqual([200, 9]);
  });

  it('tries a failed request once more, then gives up with an error the caller can swallow', async () => {
    seed('ot_3');
    process.env.LANDFLOW_OTLP_TRACES_URL = url;
    answers = [503];
    expect(await exportRunTraces('ot_3', { retryDelayMs: 5 })).toEqual({ spans: 4, requests: 1 });
    expect(received).toHaveLength(2);
    received = [];
    answers = [500, 500];
    await expect(exportRunTraces('ot_3', { retryDelayMs: 5 })).rejects.toThrow('HTTP 500');
    expect(received).toHaveLength(2);
  });

  it('exports a run when its segment closes finished, not one that waits, and survives a dead endpoint', async () => {
    seed('ot_4');
    const flow: Workflow = { id: 'wf_otlp', name: 'OTLP flow', nodes: [], connections: [] };
    process.env.LANDFLOW_OTLP_TRACES_URL = url;
    const waiting = traceSegment({ executionId: 'ot_4' }, flow);
    waiting.feed({ type: 'execution.finished', executionId: 'ot_4', status: 'waiting', durationMs: 1, at: new Date().toISOString() } as ExecutionEvent);
    waiting.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);

    const done = traceSegment({ executionId: 'ot_4' }, flow);
    done.feed({ type: 'execution.finished', executionId: 'ot_4', status: 'success', durationMs: 1, at: new Date().toISOString() } as ExecutionEvent);
    expect(() => done.close()).not.toThrow();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));

    received = [];
    process.env.LANDFLOW_OTLP_TRACES_URL = 'http://127.0.0.1:1/v1/traces';
    const dead = traceSegment({ executionId: 'ot_4' }, flow);
    dead.feed({ type: 'execution.finished', executionId: 'ot_4', status: 'success', durationMs: 1, at: new Date().toISOString() } as ExecutionEvent);
    expect(() => dead.close()).not.toThrow();
  });
});

describe('the mapping', () => {
  it('names the OpenInference kind of each span kind', () => {
    expect(openInferenceKind('agent')).toBe('AGENT');
    expect(openInferenceKind('delegate')).toBe('AGENT');
    expect(openInferenceKind('model')).toBe('LLM');
    expect(openInferenceKind('tool')).toBe('TOOL');
    expect(openInferenceKind('step')).toBe('CHAIN');
    expect(openInferenceKind('step', { nodeType: 'core.runReport' })).toBe('EVALUATOR');
  });

  it('has nothing to send for an empty journal', () => {
    expect(journalToOtlp('none', [])).toBeUndefined();
  });
});
