import { describe, expect, it } from 'vitest';
import { defineNode } from '@landflow/sdk';
import type { LanguageModel } from '@landflow/engine';
import { withFallback } from '@/lib/server/nodes/fallback';
import { outputsOf, runFlow } from './helpers';

const answering = (model: string, text = `answer from ${model}`): LanguageModel => ({
  provider: 'test',
  model,
  generate: async () => ({ text, toolCalls: [], stopReason: 'stop' }),
});
const failing = (model: string, message = 'overloaded (529)'): LanguageModel => ({
  provider: 'test',
  model,
  generate: async () => {
    throw new Error(message);
  },
});

describe('withFallback', () => {
  it('retries a failed call on the fallback model and logs it', async () => {
    const logs: string[] = [];
    const model = withFallback(failing('primary'), answering('backup'), (message) => logs.push(message));
    const turn = await model.generate({ system: '', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(turn.text).toBe('answer from backup');
    expect(model.fallbacks).toBe(1);
    expect(model.lastModel).toBe('test/backup');
    expect(logs).toEqual(['test/primary failed (overloaded (529)); retrying on the fallback model test/backup']);
  });

  it('stays on the primary while it works', async () => {
    const model = withFallback(answering('primary'), answering('backup'));
    expect((await model.generate({ system: '', messages: [], tools: [] })).text).toBe('answer from primary');
    expect(model.fallbacks).toBe(0);
    expect(model.lastModel).toBe('test/primary');
  });

  it('does not fall back on a canceled call, and surfaces the fallback’s own error', async () => {
    const controller = new AbortController();
    controller.abort();
    const backup = { ...answering('backup'), generate: async () => ({ text: 'should not run', toolCalls: [], stopReason: 'stop' }) };
    await expect(withFallback(failing('primary', 'aborted'), backup).generate({ system: '', messages: [], tools: [], signal: controller.signal })).rejects.toThrow('aborted');
    await expect(withFallback(failing('primary'), failing('backup', 'also down')).generate({ system: '', messages: [], tools: [] })).rejects.toThrow('also down');
  });
});

/** A chat model sub-node that either answers or fails, by its "fail" parameter. */
const modelNode = defineNode({
  description: {
    name: 'flaky',
    displayName: 'Flaky Model',
    description: 'Answers or fails',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_languageModel',
    categories: ['AI'],
    inputs: [],
    outputs: [{ type: 'ai_languageModel' }],
    properties: [
      { name: 'name', displayName: 'Name', type: 'string', default: 'm' },
      { name: 'fail', displayName: 'Fail', type: 'boolean', default: false },
    ],
  },
  supplyData: (ctx): LanguageModel => {
    const name = String(ctx.getNodeParameter('name'));
    return ctx.getNodeParameter('fail') ? failing(name) : answering(name);
  },
});

const flow = (root: { type: string; parameters: Record<string, unknown> }, primaryFails: boolean, withFallbackModel = true) =>
  runFlow(
    [
      { name: 'Root', ...root },
      { name: 'Primary', type: 'test.flaky', parameters: { name: 'primary', fail: primaryFails } },
      ...(withFallbackModel ? [{ name: 'Backup', type: 'test.flaky', parameters: { name: 'backup' } }] : []),
    ],
    [['Start', 'Root'], ['Primary', 'Root', 'ai_languageModel', 0, 0], ...(withFallbackModel ? ([['Backup', 'Root', 'ai_languageModel', 0, 1]] as const) : [])],
    { input: [{ chatInput: 'Hello?' }], extra: { flaky: modelNode } },
  );

describe('Enable Fallback Model', () => {
  const agent = { type: 'core.aiAgent', parameters: { prompt: '{{ $json.chatInput }}', needsFallback: true } };

  it('lets the AI Agent answer from the fallback when the primary fails', async () => {
    const result = await flow(agent, true);
    const [[out]] = outputsOf(result, 'Root');
    expect(out).toMatchObject({ output: 'answer from backup', model: 'test/backup', fallbackUsed: true });
    // The failed primary call stays in the run data; the fallback's call succeeded.
    expect(result.runData.Primary.map((r) => r.status)).toEqual(['error']);
    expect(result.runData.Backup.map((r) => r.status)).toEqual(['success']);
    const logs = result.runData.Root.at(-1)?.logs ?? [];
    expect(logs.some((l) => l.level === 'warn' && /retrying on the fallback model test\/backup/.test(l.message))).toBe(true);
  });

  it('uses the primary while it works', async () => {
    const result = await flow(agent, false);
    const [[out]] = outputsOf(result, 'Root');
    expect(out).toMatchObject({ output: 'answer from primary', model: 'test/primary' });
    expect(out.fallbackUsed).toBeUndefined();
    expect(result.runData.Backup).toBeUndefined();
  });

  it('works on chains (Basic LLM Chain)', async () => {
    const result = await flow({ type: 'core.chainLlm', parameters: { prompt: '{{ $json.chatInput }}', needsFallback: true } }, true);
    expect(outputsOf(result, 'Root')[0][0].text).toBe('answer from backup');
  });

  it('asks for the fallback model when the switch is on', async () => {
    const result = await flow(agent, false, false);
    expect(result.runData.Root.at(-1)?.error?.message).toBe('No fallback model connected');
  });

  it('does not fall back with the switch off', async () => {
    const result = await flow({ type: 'core.aiAgent', parameters: { prompt: '{{ $json.chatInput }}' } }, true);
    expect(result.status).toBe('error');
  });
});
