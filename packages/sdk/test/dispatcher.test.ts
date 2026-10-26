/** The dispatcher (docs/transports.md "The shape"): deadline, cancellation and the concurrency limit, the same for every binding. */
import { describe, expect, it } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';
import { createDispatcher, defineNode, definePlugin, DispatchError, type IExecuteContext } from '../src';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });

/** Waits `ms` (parameter) unless its signal fires; reports what the context carried. */
const slow = defineNode({
  description: {
    name: 'slow',
    displayName: 'Slow',
    description: '',
    version: 1,
    kind: 'action',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [{ name: 'ms', displayName: 'ms', type: 'number', default: 0 }],
  },
  async execute(ctx: IExecuteContext) {
    await sleep(ctx.getNodeParameter<number>('ms'), ctx.signal);
    return [{ json: { deadline: ctx.deadline ?? null, hadSignal: ctx.signal !== undefined } }];
  },
});

/** Ignores its signal: finishes anyway. */
const stubborn = defineNode({
  description: { ...slow.description, name: 'stubborn' },
  async execute(ctx: IExecuteContext) {
    await sleep(ctx.getNodeParameter<number>('ms'));
    return [{ json: { aborted: ctx.signal?.aborted ?? null } }];
  },
});

const plugin = definePlugin({ info: { id: 'disp', name: 'Dispatcher test', version: '1' }, nodes: [slow, stubborn] });

const request = (type: string, ms: number): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_1',
  mode: 'manual',
  node: { id: 'n1', name: 'N', type: `disp.${type}`, typeVersion: 1 },
  parameters: { ms },
  itemParameters: [{ ms }],
  inputs: [[{ json: {} }]],
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('dispatcher: deadline', () => {
  it('reaches node code as ctx.deadline and ctx.signal, and no deadline means neither', async () => {
    const dispatcher = createDispatcher(plugin);
    const deadline = Date.now() + 5_000;
    const withDeadline = await dispatcher.execute(request('slow', 0), { transport: 'fake', deadline });
    expect(withDeadline.outputs[0]![0]!.json).toEqual({ deadline, hadSignal: true });
    const without = await dispatcher.execute(request('slow', 0), { transport: 'fake' });
    expect(without.outputs[0]![0]!.json).toEqual({ deadline: null, hadSignal: false });
  });

  it('refuses a call whose deadline has already passed, without running the node', async () => {
    const dispatcher = createDispatcher(plugin);
    const error = await dispatcher.execute(request('slow', 0), { transport: 'fake', deadline: Date.now() - 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(DispatchError);
    expect((error as DispatchError).code).toBe('deadline_exceeded');
    expect(dispatcher.inFlight).toBe(0);
  });

  it('aborts ctx.signal when the deadline passes mid-call and reports "Deadline exceeded"', async () => {
    const dispatcher = createDispatcher(plugin);
    const response = await dispatcher.execute(request('slow', 2_000), { transport: 'fake', deadline: Date.now() + 30 });
    expect(response.error?.message).toBe('Deadline exceeded');
    expect(response.outputs).toEqual([[]]);
  });

  it('lets a node that ignores the signal finish and hands back its result', async () => {
    const dispatcher = createDispatcher(plugin);
    const response = await dispatcher.execute(request('stubborn', 40), { transport: 'fake', deadline: Date.now() + 10 });
    expect(response.error).toBeUndefined();
    expect(response.outputs[0]![0]!.json).toEqual({ aborted: true });
  });
});

describe('dispatcher: cancellation', () => {
  it('aborts a running call when the binding aborts its signal', async () => {
    const dispatcher = createDispatcher(plugin);
    const controller = new AbortController();
    const pending = dispatcher.execute(request('slow', 2_000), { transport: 'fake', signal: controller.signal });
    await tick();
    expect(dispatcher.inFlight).toBe(1);
    controller.abort();
    const response = await pending;
    expect(response.error?.message).toBe('The call was canceled');
    expect(dispatcher.inFlight).toBe(0);
  });

  it('refuses a call that is already canceled', async () => {
    const dispatcher = createDispatcher(plugin);
    const error = await dispatcher.execute(request('slow', 0), { transport: 'fake', signal: AbortSignal.abort() }).catch((e) => e);
    expect((error as DispatchError).code).toBe('canceled');
  });

  it('passes a custom abort reason through to the node error', async () => {
    const dispatcher = createDispatcher(plugin);
    const controller = new AbortController();
    const pending = dispatcher.execute(request('slow', 2_000), { transport: 'fake', signal: controller.signal });
    await tick();
    controller.abort(new Error('cancel event from the broker'));
    expect((await pending).error?.message).toBe('cancel event from the broker');
  });
});

describe('dispatcher: concurrency', () => {
  it('runs at most maxConcurrency calls at once, queues the next ones, refuses beyond the queue', async () => {
    const dispatcher = createDispatcher(plugin, { maxConcurrency: 2 });
    expect(dispatcher.manifest).toMatchObject({ maxConcurrency: 2 });
    const calls = [1, 2, 3, 4].map(() => dispatcher.execute(request('slow', 60), { transport: 'fake' }));
    await tick();
    expect(dispatcher.stats()).toEqual({ inFlight: 2, queued: 2, maxConcurrency: 2 });
    // 2 running + 2 waiting: the fifth is refused at once, and never ran.
    const refused = await dispatcher.execute(request('slow', 0), { transport: 'fake' }).catch((e) => e);
    expect(refused).toBeInstanceOf(DispatchError);
    expect((refused as DispatchError).code).toBe('capacity');
    const responses = await Promise.all(calls);
    expect(responses.every((r) => !r.error)).toBe(true);
    expect(dispatcher.stats()).toEqual({ inFlight: 0, queued: 0, maxConcurrency: 2 });
  });

  it('a queued call whose deadline passes while waiting fails without running', async () => {
    const dispatcher = createDispatcher(plugin, { maxConcurrency: 1 });
    const first = dispatcher.execute(request('slow', 80), { transport: 'fake' });
    await tick();
    const queued = dispatcher.execute(request('slow', 0), { transport: 'fake', deadline: Date.now() + 20 });
    const error = await queued.catch((e) => e);
    expect((error as DispatchError).code).toBe('deadline_exceeded');
    expect(error.message).toContain('while waiting');
    expect(dispatcher.queued).toBe(0);
    await first;
  });

  it('a queued call can be canceled while waiting, and the slot still goes to the next one', async () => {
    const dispatcher = createDispatcher(plugin, { maxConcurrency: 1, maxQueue: 5 });
    const first = dispatcher.execute(request('slow', 50), { transport: 'fake' });
    await tick();
    const controller = new AbortController();
    const canceled = dispatcher.execute(request('slow', 0), { transport: 'fake', signal: controller.signal });
    const third = dispatcher.execute(request('slow', 0), { transport: 'fake' });
    await tick();
    expect(dispatcher.queued).toBe(2);
    controller.abort();
    expect(((await canceled.catch((e) => e)) as DispatchError).code).toBe('canceled');
    expect(dispatcher.queued).toBe(1);
    await first;
    expect((await third).error).toBeUndefined();
  });

  it('drain() resolves once nothing runs or waits; with no limit everything runs at once', async () => {
    const dispatcher = createDispatcher(plugin);
    expect(dispatcher.maxConcurrency).toBeUndefined();
    const calls = [1, 2, 3].map(() => dispatcher.execute(request('slow', 30), { transport: 'fake' }));
    await tick();
    expect(dispatcher.inFlight).toBe(3);
    const started = Date.now();
    await dispatcher.drain();
    expect(dispatcher.inFlight).toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
    await Promise.all(calls);
    await dispatcher.drain(); // idle: resolves at once
  });
});

describe('dispatcher: lookups and hints', () => {
  it('throws unknown_node / unknown_credential_type before taking a slot', async () => {
    const dispatcher = createDispatcher(plugin, { maxConcurrency: 1 });
    const node = await dispatcher.execute(request('nope', 0), { transport: 'fake' }).catch((e) => e);
    expect((node as DispatchError).code).toBe('unknown_node');
    const cred = await dispatcher.testCredentials({ credentialType: 'nope', data: {} }, { transport: 'fake' }).catch((e) => e);
    expect((cred as DispatchError).code).toBe('unknown_credential_type');
    expect(dispatcher.stats()).toEqual({ inFlight: 0, queued: 0, maxConcurrency: 1 });
  });

  it('puts the transports hint into the manifest and leaves it out when there is none', () => {
    expect(createDispatcher(plugin, { hints: { transports: ['http', 'fake'] } }).manifest).toMatchObject({ transports: ['http', 'fake'] });
    const plain = createDispatcher(plugin).manifest as unknown as Record<string, unknown>;
    expect('transports' in plain).toBe(false);
    expect('maxConcurrency' in plain).toBe(false);
  });
});
