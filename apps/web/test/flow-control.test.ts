/**
 * Flow control through the runner and the HTTP routes: waiting executions (time, webhook and form
 * waits, timers re-armed at boot, cancel, limits), the Webhook trigger's respond modes and Respond to
 * Webhook, hosted forms, Loop Over Items, Execute Workflow (sub-executions, waiting children, caller
 * policy, depth), error workflows, Schedule rules, and the timeout / save settings.
 *
 * The boot test boots the host: a waiting execution whose time passed while "the server was down"
 * must resume from bootstrap. Route handlers bootstrap too, so it runs before any of them (only the
 * Schedule tests, which drive the scheduler's tick by hand, come earlier).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-flow-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://flow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { runWorkflow, resumeExecution, ResumeError, errorItem } = await import('@/lib/server/runner');
const { scheduler, scheduleMatcher, isLegacySchedule, ruleMatcher, scheduleItem } = await import('@/lib/server/scheduler');
const { parseCron, timeParts } = await import('@/lib/server/agents/cron');
const { waitNode } = await import('@/lib/server/nodes/flow');
const { run, runFlow } = await import('./helpers');
const waitingRoute = await import('@/app/api/waiting/[id]/route');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const executionRoute = await import('@/app/api/executions/[id]/route');
const formRoute = await import('@/app/form/[...path]/route');
const formWaitingRoute = await import('@/app/form/waiting/[id]/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface N {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  typeVersion?: number;
}

/** Save a workflow whose node ids are their names; edges are [source, target, sourceIndex, targetIndex]. */
function save(id: string, nodes: N[], edges: Array<[string, string, number?, number?]>, extra: Partial<Workflow> = {}): Workflow {
  return store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: n.typeVersion ?? 1, position: [i * 200, 0], parameters: n.parameters ?? {} })),
    connections: edges.map(([source, target, sourceIndex = 0, targetIndex = 0], i) => ({ id: `e${i}`, type: 'main', source, target, sourceIndex, targetIndex })),
    ...extra,
  } as Workflow);
}

const start: N = { name: 'Start', type: 'core.manualTrigger' };
const hoursWait = (name = 'Wait', hours = 2): N => ({ name, type: 'core.wait', typeVersion: 2, parameters: { resume: 'timeInterval', amount: hours, unit: 'hours' } });
const noOp = (name: string): N => ({ name, type: 'core.noOp' });
const fail = (name = 'Fail', message = 'boom'): N => ({ name, type: 'core.stopAndError', parameters: { message } });
const setFields = (name: string, values: Array<{ name: string; type?: string; value: string }>): N => ({
  name,
  type: 'core.set',
  parameters: { mode: 'manual', includeOtherFields: false, fields: { values: values.map((v) => ({ type: 'string', ...v })) } },
});

const trigger = (workflow: Workflow, items: Array<Record<string, unknown>> = [{}]) =>
  runWorkflow({ workflow, mode: 'trigger', startNodeId: workflow.nodes[0].id, triggerItems: items.map((json) => ({ json: json as never })) });

const outputOf = (record: ExecutionRecord | undefined, node: string, output = 0) => record?.runData[node]?.at(-1)?.outputs[output]?.map((i) => i.json);
const stored = (id: string) => store.getExecution(id);
const executionsOf = (workflowId: string) => store.listExecutions({ workflowId, limit: 1000 });

const request = (url: string, init: RequestInit = {}) => new Request(`http://flow.test${url}`, init);
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const formBody = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) for (const v of [value].flat()) body.append(key, v);
  return { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } };
};

// ---------------------------------------------------------------------------

describe('Schedule rules', () => {
  const at = (iso: string, zone = 'UTC') => timeParts(new Date(iso), zone);

  it('matches n8n’s intervals at their times of day, weekdays and days of the month', () => {
    const rule = (r: Record<string, unknown>) => ruleMatcher(r);
    expect(rule({ field: 'seconds', secondsInterval: 15 })(at('2026-10-25T10:00:30Z'))).toBe(true);
    expect(rule({ field: 'seconds', secondsInterval: 15 })(at('2026-10-25T10:00:31Z'))).toBe(false);
    expect(rule({ field: 'minutes', minutesInterval: 10 })(at('2026-10-25T10:20:00Z'))).toBe(true);
    expect(rule({ field: 'minutes', minutesInterval: 10 })(at('2026-10-25T10:20:01Z'))).toBe(false);
    expect(rule({ field: 'hours', hoursInterval: 2, triggerAtMinute: 15 })(at('2026-10-25T14:15:00Z'))).toBe(true);
    expect(rule({ field: 'hours', hoursInterval: 2, triggerAtMinute: 15 })(at('2026-10-25T13:15:00Z'))).toBe(false);
    expect(rule({ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 30 })(at('2026-10-25T09:30:00Z'))).toBe(true);
    expect(rule({ field: 'days', daysInterval: 2, triggerAtHour: 9 })(at('2026-10-02T09:00:00Z'))).toBe(false);
    // 2026-10-25 is a Sunday, 2026-10-26 a Monday.
    expect(rule({ field: 'weeks', weeksInterval: 1, triggerAtDay: [1, 3], triggerAtHour: 8 })(at('2026-10-26T08:00:00Z'))).toBe(true);
    expect(rule({ field: 'weeks', weeksInterval: 1, triggerAtDay: [1, 3], triggerAtHour: 8 })(at('2026-10-25T08:00:00Z'))).toBe(false);
    expect(rule({ field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 25, triggerAtHour: 7 })(at('2026-10-25T07:00:00Z'))).toBe(true);
    expect(rule({ field: 'months', monthsInterval: 3, triggerAtDayOfMonth: 25, triggerAtHour: 7 })(at('2026-10-25T07:00:00Z'))).toBe(true);
    expect(rule({ field: 'months', monthsInterval: 3, triggerAtDayOfMonth: 25, triggerAtHour: 7 })(at('2026-11-25T07:00:00Z'))).toBe(false);
    expect(() => rule({ field: 'fortnights' })).toThrow('Unknown trigger interval');
  });

  it('supports five- and six-field cron with names, in the workflow’s time zone', () => {
    const five = ruleMatcher({ field: 'cronExpression', expression: '0 9 * * mon-fri' });
    expect(five(at('2026-10-26T09:00:00Z'))).toBe(true);
    expect(five(at('2026-10-26T09:00:01Z'))).toBe(false);
    expect(five(at('2026-10-25T09:00:00Z'))).toBe(false);
    const six = ruleMatcher({ field: 'cronExpression', expression: '*/20 * * * * *' });
    expect(six(at('2026-10-26T09:13:40Z'))).toBe(true);
    expect(six(at('2026-10-26T09:13:41Z'))).toBe(false);
    expect(parseCron('0 0 9 ? JAN *').matches({ second: 0, minute: 0, hour: 9, day: 3, month: 1, weekday: 6 })).toBe(true);
    // 07:00 UTC is 09:00 in Jerusalem on 2026-10-25.
    const daily = scheduleMatcher({ unit: 'rules', rule: { interval: [{ field: 'days', triggerAtHour: 9 }, { field: 'cronExpression', expression: '0 0 1 1 *' }] } });
    expect(daily(at('2026-10-25T07:00:00Z', 'Asia/Jerusalem'))).toBe(true);
    expect(daily(at('2026-10-25T07:00:00Z', 'UTC'))).toBe(false);
    expect(scheduleItem(new Date('2026-10-25T07:00:00Z'), 'Asia/Jerusalem')).toMatchObject({ 'Day of week': 'Sunday', Hour: '09', Minute: '00', Month: 'October', Timezone: 'Asia/Jerusalem' });
  });

  it('keeps every/unit schedules on their old interval', () => {
    expect(isLegacySchedule({ every: 5, unit: 'minutes' })).toBe(true);
    expect(isLegacySchedule({ every: 5 })).toBe(true);
    expect(isLegacySchedule({ unit: 'rules', rule: { interval: [] } })).toBe(false);
    expect(isLegacySchedule({ rule: { interval: [{ field: 'days' }] } })).toBe(false);
  });

  it('fires an active schedule once when its second comes, catching up on a late tick', async () => {
    const workflow = save(
      'wf_schedule_rules',
      [{ name: 'Every day', type: 'core.schedule', parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '30 15 10 1 1 *' }] } } }, noOp('After')],
      [['Every day', 'After']],
      { active: true, settings: { timezone: 'UTC' } },
    );
    scheduler.tick(Date.parse('2027-01-01T10:15:29.400Z'));
    scheduler.tick(Date.parse('2027-01-01T10:15:29.900Z'));
    expect(executionsOf(workflow.id)).toHaveLength(0);
    // The tick for 10:15:30 came late: the catch-up still fires it, once.
    scheduler.tick(Date.parse('2027-01-01T10:15:31.200Z'));
    scheduler.tick(Date.parse('2027-01-01T10:15:32.200Z'));
    await vi.waitFor(() => expect(executionsOf(workflow.id)).toHaveLength(1));
    const record = stored(executionsOf(workflow.id)[0].id);
    expect(outputOf(record, 'After')?.[0]).toMatchObject({ scheduledAt: '2027-01-01T10:15:30.000Z', Timezone: 'UTC', Second: '30' });
    save(workflow.id, workflow.nodes.map((n) => ({ name: n.name, type: n.type, parameters: n.parameters })), [['Every day', 'After']], { active: false });
  });
});

describe('boot', () => {
  it('re-arms waiting executions at bootstrap and resumes the overdue ones', async () => {
    const workflow = save('wf_boot_wait', [start, hoursWait(), noOp('After')], [
      ['Start', 'Wait'],
      ['Wait', 'After'],
    ]);
    const due = await trigger(workflow);
    const later = await trigger(workflow);
    expect([due.status, later.status]).toEqual(['waiting', 'waiting']);
    // "Restart": the timers are gone, and the first wait's time passed while the server was down.
    waits.stop();
    expect(waits.pending()).toEqual([]);
    const record = stored(due.executionId)!;
    store.saveExecution({ ...record, wait: { ...record.wait!, until: new Date(Date.now() - 60_000).toISOString() } });

    await ensureBootstrapped();
    // The future one has its timer back; the overdue one resumes after the boot grace period.
    expect(waits.pending()).toContain(later.executionId);
    await vi.waitFor(() => expect(stored(due.executionId)?.status).toBe('success'), { timeout: 8_000, interval: 100 });
    const resumed = stored(due.executionId)!;
    expect(resumed.executionOrder).toEqual(['Start', 'Wait', 'After']);
    expect(resumed.resumeState).toBeUndefined();
    expect(stored(later.executionId)?.status).toBe('waiting');
  }, 12_000);
});

describe('waiting executions', () => {
  it('suspends a long time wait, lists it as waiting and resumes it on the workflow version it started with', async () => {
    const workflow = save('wf_time_wait', [start, hoursWait(), noOp('After')], [
      ['Start', 'Wait'],
      ['Wait', 'After'],
    ]);
    const waiting = await trigger(workflow, [{ n: 1 }]);
    expect(waiting.status).toBe('waiting');
    expect(waiting.wait).toMatchObject({ resume: 'time', nodeName: 'Wait' });
    expect(Date.parse(waiting.wait!.until!) - Date.now()).toBeGreaterThan(7_100_000);
    expect(stored(waiting.executionId)?.status).toBe('waiting');
    expect(executionsOf(workflow.id)[0]).toMatchObject({ id: waiting.executionId, status: 'waiting', wait: { nodeName: 'Wait', resume: 'time' } });
    expect(waits.pending()).toContain(waiting.executionId);

    // The saved workflow changes; the waiting run still finishes on its own version.
    save(workflow.id, [start, hoursWait(), fail('After')], [
      ['Start', 'Wait'],
      ['Wait', 'After'],
    ]);
    const done = await resumeExecution(waiting.executionId, { kind: 'time' });
    expect(done.executionId).toBe(waiting.executionId);
    expect(done.status).toBe('success');
    expect(outputOf(done, 'After')).toEqual([{ n: 1 }]);
    expect(done.runData.Wait).toHaveLength(1);
    expect(stored(waiting.executionId)).toMatchObject({ status: 'success' });
    expect(executionsOf(workflow.id).filter((e) => e.id === waiting.executionId)).toHaveLength(1);
    expect(waits.pending()).not.toContain(waiting.executionId);
    await expect(resumeExecution(waiting.executionId, { kind: 'time' })).rejects.toBeInstanceOf(ResumeError);
  });

  it('waits up to 65 seconds in memory, and keeps the old seconds-only Wait working', async () => {
    const short = await runFlow([{ name: 'Wait', type: 'core.wait', parameters: { resume: 'timeInterval', amount: 0.05, unit: 'seconds' } }], [['Start', 'Wait']]);
    expect(short.status).toBe('success');
    const legacy = await runFlow([{ name: 'Wait', type: 'core.wait', parameters: { seconds: 0 } }], [['Start', 'Wait']], { input: [{ a: 1 }] });
    expect(legacy.status).toBe('success');
    expect(legacy.runData.Wait[0].outputs[0][0].json).toEqual({ a: 1 });
    const past = await runFlow([{ name: 'Wait', type: 'core.wait', parameters: { resume: 'specificTime', dateTime: '2020-01-01T00:00:00Z' } }], [['Start', 'Wait']]);
    expect(past.status).toBe('success');
    // Outside an execution (no way to suspend), a long wait explains itself.
    const outside = await run(waitNode, { resume: 'timeInterval', amount: 2, unit: 'hours' });
    expect(outside.error?.message).toContain('needs a workflow execution');
  });

  it('resumes a webhook wait through /api/waiting/:id and answers with the last node', async () => {
    const workflow = save(
      'wf_webhook_wait',
      [
        start,
        setFields('Link', [{ name: 'url', value: '{{ $execution.resumeUrl }}' }]),
        { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'webhook', httpMethod: 'POST', responseMode: 'lastNode' } },
        noOp('After'),
      ],
      [
        ['Start', 'Link'],
        ['Link', 'Wait'],
        ['Wait', 'After'],
      ],
    );
    const waiting = await trigger(workflow);
    expect(waiting.status).toBe('waiting');
    expect(outputOf(waiting, 'Link')).toEqual([{ url: `http://flow.test/api/waiting/${waiting.executionId}` }]);
    expect(waiting.wait).toMatchObject({ resume: 'webhook', method: 'POST' });
    expect(waits.pending()).not.toContain(waiting.executionId);

    const wrong = await waitingRoute.GET(request(`/api/waiting/${waiting.executionId}`), params({ id: waiting.executionId }));
    expect(wrong.status).toBe(405);
    const response = await waitingRoute.POST(
      request(`/api/waiting/${waiting.executionId}?ok=1`, { method: 'POST', body: JSON.stringify({ approved: true }), headers: { 'content-type': 'application/json' } }),
      params({ id: waiting.executionId }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: 'POST', path: `waiting/${waiting.executionId}`, query: { ok: '1' }, body: { approved: true } });
    expect(stored(waiting.executionId)?.status).toBe('success');
    const again = await waitingRoute.POST(request(`/api/waiting/${waiting.executionId}`, { method: 'POST' }), params({ id: waiting.executionId }));
    expect(again.status).toBe(404);
  });

  it('answers a webhook resume from a Respond to Webhook node', async () => {
    const workflow = save(
      'wf_webhook_wait_respond',
      [
        start,
        { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'webhook', httpMethod: 'POST', responseMode: 'responseNode' } },
        { name: 'Respond', type: 'core.respondToWebhook', parameters: { respondWith: 'text', responseBody: 'thanks {{ $json.body.name }}', options: { responseCode: 201 } } },
      ],
      [
        ['Start', 'Wait'],
        ['Wait', 'Respond'],
      ],
    );
    const waiting = await trigger(workflow);
    const response = await waitingRoute.POST(
      request(`/api/waiting/${waiting.executionId}`, { method: 'POST', body: JSON.stringify({ name: 'Ada' }), headers: { 'content-type': 'application/json' } }),
      params({ id: waiting.executionId }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('thanks Ada');
  });

  it('continues a webhook wait without a payload when its time limit runs out', async () => {
    const workflow = save(
      'wf_wait_limit',
      [
        start,
        { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'webhook', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 0.3, resumeUnit: 'seconds' } },
        noOp('After'),
      ],
      [
        ['Start', 'Wait'],
        ['Wait', 'After'],
      ],
    );
    const waiting = await trigger(workflow, [{ id: 7 }]);
    expect(waiting.status).toBe('waiting');
    expect(waits.pending()).toContain(waiting.executionId);
    await vi.waitFor(() => expect(stored(waiting.executionId)?.status).toBe('success'), { timeout: 5_000, interval: 50 });
    expect(outputOf(stored(waiting.executionId), 'After')).toEqual([{ id: 7 }]);
  });

  it('cancels a waiting execution with DELETE /api/executions/:id', async () => {
    const workflow = save('wf_cancel_wait', [start, hoursWait()], [['Start', 'Wait']]);
    const waiting = await trigger(workflow);
    const response = await executionRoute.DELETE(request(`/api/executions/${waiting.executionId}`, { method: 'DELETE' }), params({ id: waiting.executionId }));
    expect(await response.json()).toEqual({ canceled: true });
    expect(stored(waiting.executionId)).toMatchObject({ status: 'canceled', error: { message: 'Execution canceled' } });
    expect(stored(waiting.executionId)?.resumeState).toBeUndefined();
    expect(waits.pending()).not.toContain(waiting.executionId);
    // The detail route never hands out the engine state.
    const later = await trigger(workflow);
    const detail = await (await executionRoute.GET(request(`/api/executions/${later.executionId}`), params({ id: later.executionId }))).json();
    expect(detail.execution.status).toBe('waiting');
    expect(detail.execution.resumeState).toBeUndefined();
  });
});

describe('Webhook trigger respond modes', () => {
  const call = (path: string, body: unknown = {}) =>
    webhookRoute.POST(request(`/api/webhook/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params({ path: path.split('/') }));
  const hook = (path: string, respond: string): N => ({ name: 'Hook', type: 'core.webhook', parameters: { path, method: 'POST', respond } });

  it('answers from a Respond to Webhook node while the run goes on (and waits)', async () => {
    const workflow = save(
      'wf_hook_respond',
      [
        hook('flow-respond', 'responseNode'),
        {
          name: 'Respond',
          type: 'core.respondToWebhook',
          parameters: { respondWith: 'json', responseBody: '{ "ok": true, "got": "{{ $json.body.x }}" }', options: { responseHeaders: { entries: [{ name: 'X-Test', value: 'yes' }] } } },
        },
        hoursWait(),
      ],
      [
        ['Hook', 'Respond'],
        ['Respond', 'Wait'],
      ],
      { active: true },
    );
    const response = await call('flow-respond', { x: 'abc' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.json()).toEqual({ ok: true, got: 'abc' });
    const execution = response.headers.get('x-landflow-execution')!;
    await vi.waitFor(() => expect(stored(execution)?.status).toBe('waiting'));
    expect(executionsOf(workflow.id)[0].id).toBe(execution);
  });

  it('answers 202 immediately, and { status: "waiting" } when the run waits before responding', async () => {
    save('wf_hook_now', [hook('flow-now', 'immediately'), noOp('After')], [['Hook', 'After']], { active: true });
    const now = await call('flow-now');
    expect(now.status).toBe(202);
    expect(await now.json()).toMatchObject({ status: 'started', workflowId: 'wf_hook_now', executionId: expect.stringMatching(/^ex_/) });

    save('wf_hook_last_wait', [hook('flow-last-wait', 'lastNode'), hoursWait()], [['Hook', 'Wait']], { active: true });
    const last = await call('flow-last-wait');
    expect(await last.json()).toMatchObject({ status: 'waiting', executionId: expect.stringMatching(/^ex_/) });

    save('wf_hook_node_wait', [hook('flow-node-wait', 'responseNode'), hoursWait(), { name: 'Respond', type: 'core.respondToWebhook' }], [['Hook', 'Wait'], ['Wait', 'Respond']], {
      active: true,
    });
    const early = await call('flow-node-wait');
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ status: 'waiting' });
  });

  it('sends first item, all items, no data and redirects', async () => {
    const respond = (path: string, parameters: Record<string, unknown>) => {
      save(`wf_${path}`, [hook(path, 'responseNode'), { name: 'Respond', type: 'core.respondToWebhook', parameters }], [['Hook', 'Respond']], { active: true });
      return call(path, { a: 1 });
    };
    expect(await (await respond('flow-first', {})).json()).toMatchObject({ method: 'POST', body: { a: 1 } });
    expect(await (await respond('flow-all', { respondWith: 'allIncomingItems', options: { responseKey: 'data' } })).json()).toMatchObject({ data: [{ body: { a: 1 } }] });
    const empty = await respond('flow-empty', { respondWith: 'noData', options: { responseCode: 204 } });
    expect([empty.status, await empty.text()]).toEqual([204, '']);
    const moved = await respond('flow-redirect', { respondWith: 'redirect', redirectURL: 'https://example.com/next' });
    expect([moved.status, moved.headers.get('location')]).toEqual([307, 'https://example.com/next']);
  });
});

describe('forms', () => {
  const fields = {
    values: [
      { fieldLabel: 'Name', fieldType: 'text', requiredField: true, placeholder: 'Your name' },
      { fieldLabel: 'Age', fieldType: 'number' },
      { fieldLabel: 'Color', fieldType: 'dropdown', fieldOptions: 'red\nblue' },
      { fieldLabel: 'Agree', fieldType: 'checkbox' },
    ],
  };
  const formTrigger = (path: string, extra: Record<string, unknown> = {}): N => ({
    name: 'Form',
    type: 'core.formTrigger',
    parameters: { path, formTitle: 'Sign up', formFields: fields, options: { formSubmittedText: 'Got it' }, ...extra },
  });

  it('serves /form/<path> of active workflows and starts a run per submission', async () => {
    const workflow = save('wf_form', [formTrigger('flow-form'), noOp('After')], [['Form', 'After']], { active: true });
    const page = await formRoute.GET(request('/form/flow-form'), params({ path: ['flow-form'] }));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('<h1>Sign up</h1>');
    expect(html).toContain('name="f0"');
    expect(html).toMatch(/name="f0"[^>]*placeholder="Your name"[^>]*required/);
    expect(html).toContain('<option value="blue">blue</option>');
    expect(html).not.toContain('<script');

    const invalid = await formRoute.POST(request('/form/flow-form', formBody({ f1: 'x' })), params({ path: ['flow-form'] }));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('This field is required');

    const done = await formRoute.POST(request('/form/flow-form', formBody({ f0: 'Ada', f1: '36', f2: 'blue', f3: 'on' })), params({ path: ['flow-form'] }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Got it');
    await vi.waitFor(() => expect(executionsOf(workflow.id)[0]?.status).toBe('success'));
    const record = stored(executionsOf(workflow.id)[0].id);
    expect(outputOf(record, 'After')).toEqual([{ Name: 'Ada', Age: 36, Color: 'blue', Agree: true, submittedAt: expect.any(String), formMode: 'production' }]);

    save('wf_form', [formTrigger('flow-form'), noOp('After')], [['Form', 'After']], { active: false });
    expect((await formRoute.GET(request('/form/flow-form'), params({ path: ['flow-form'] }))).status).toBe(404);
  });

  it('walks through Form pages at /form/waiting/<id> to the end screen', async () => {
    const workflow = save(
      'wf_form_pages',
      [
        formTrigger('flow-pages', { responseMode: 'lastNode' }),
        { name: 'Details', type: 'core.form', parameters: { operation: 'page', formTitle: 'Details', formFields: { values: [{ fieldLabel: 'Email', fieldType: 'email', requiredField: true }] } } },
        { name: 'End', type: 'core.form', parameters: { operation: 'completion', respondWith: 'text', completionTitle: 'All done', completionMessage: 'Thanks {{ $json.Email }}' } },
      ],
      [
        ['Form', 'Details'],
        ['Details', 'End'],
      ],
      { active: true },
    );
    const first = await formRoute.POST(request('/form/flow-pages', formBody({ f0: 'Ada' })), params({ path: ['flow-pages'] }));
    expect(first.status).toBe(303);
    const location = first.headers.get('location')!;
    const id = location.split('/').at(-1)!;
    expect(location).toBe(`/form/waiting/${id}`);
    expect(stored(id)).toMatchObject({ status: 'waiting', wait: { resume: 'form', nodeName: 'Details' } });

    const page = await formWaitingRoute.GET(request(location), params({ id }));
    expect(await page.text()).toContain('<h1>Details</h1>');
    const bad = await formWaitingRoute.POST(request(location, formBody({ f0: 'not-an-email' })), params({ id }));
    expect(bad.status).toBe(400);
    const end = await formWaitingRoute.POST(request(location, formBody({ f0: 'ada@example.com' })), params({ id }));
    expect(end.status).toBe(200);
    const html = await end.text();
    expect(html).toContain('All done');
    expect(html).toContain('Thanks ada@example.com');
    await vi.waitFor(() => expect(stored(id)?.status).toBe('success'));
    const record = stored(id)!;
    expect(outputOf(record, 'Details')).toEqual([{ Email: 'ada@example.com', submittedAt: expect.any(String), formMode: 'production' }]);
    expect(record.formCompletion).toMatchObject({ respondWith: 'text', title: 'All done' });
    // Afterwards the page shows the end screen.
    expect(await (await formWaitingRoute.GET(request(location), params({ id }))).text()).toContain('All done');
    expect(executionsOf(workflow.id)).toHaveLength(1);
  });

  it('redirects to a Form Ending URL', async () => {
    save(
      'wf_form_redirect',
      [formTrigger('flow-redirect', { responseMode: 'lastNode' }), { name: 'End', type: 'core.form', parameters: { operation: 'completion', respondWith: 'redirect', redirectUrl: 'https://example.com/thanks' } }],
      [['Form', 'End']],
      { active: true },
    );
    const response = await formRoute.POST(request('/form/flow-redirect', formBody({ f0: 'Ada' })), params({ path: ['flow-redirect'] }));
    expect([response.status, response.headers.get('location')]).toEqual([303, 'https://example.com/thanks']);
  });
});

describe('Loop Over Items', () => {
  it('hands out batches on "loop" and everything that came back on "done"', async () => {
    const result = await runFlow(
      [
        { name: 'Loop', type: 'core.splitInBatches', parameters: { batchSize: 2 } },
        { name: 'Body', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: true, fields: { values: [{ name: 'batch', type: 'number', value: "{{ $('Loop').all().length }}" }] } } },
        { name: 'Done', type: 'core.noOp' },
      ],
      [
        ['Start', 'Loop'],
        ['Loop', 'Body', 'main', 1, 0],
        ['Body', 'Loop'],
        ['Loop', 'Done', 'main', 0, 0],
      ],
      { input: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }] },
    );
    expect(result.status).toBe('success');
    expect(result.runData.Body).toHaveLength(3);
    expect(result.runData.Done[0].outputs[0].map((i) => i.json)).toEqual([
      { n: 1, batch: 2 },
      { n: 2, batch: 2 },
      { n: 3, batch: 2 },
      { n: 4, batch: 2 },
      { n: 5, batch: 1 },
    ]);
  });
});

describe('Execute Workflow', () => {
  const child = (id: string, nodes: N[] = [], edges: Array<[string, string]> = [], extra: Partial<Workflow> = {}) =>
    save(
      id,
      [{ name: 'Called', type: 'core.workflowTrigger', parameters: { inputs: { fields: [{ name: 'n', type: 'number', required: true }] } } }, ...nodes],
      edges.length ? edges : nodes.length ? [['Called', nodes[0].name]] : [],
      extra,
    );
  const caller = (id: string, parameters: Record<string, unknown>, extra: Partial<Workflow> = {}) =>
    save(id, [start, { name: 'Run', type: 'core.executeWorkflow', parameters }, noOp('After')], [
      ['Start', 'Run'],
      ['Run', 'After'],
    ], extra);
  const mapped = { inputSource: 'map', workflowInputs: { values: [{ name: 'n', value: '{{ $json.n }}' }] } };

  it('runs the sub-workflow and returns its last node, linking both executions', async () => {
    child('wf_child_double', [setFields('Double', [{ name: 'doubled', type: 'number', value: '{{ $json.n * 2 }}' }])]);
    const parent = await trigger(caller('wf_parent', { workflowId: 'wf_child_double', ...mapped }), [{ n: 2 }, { n: 5 }]);
    expect(parent.status).toBe('success');
    expect(outputOf(parent, 'After')).toEqual([{ doubled: 4 }, { doubled: 10 }]);
    expect(parent.subExecutions).toHaveLength(1);
    const [sub] = parent.subExecutions!;
    expect(sub).toMatchObject({ workflowId: 'wf_child_double', nodeId: 'Run' });
    expect(stored(sub.executionId)).toMatchObject({ status: 'success', parentExecutionId: parent.executionId, depth: 1 });
    expect(executionsOf('wf_child_double')[0]).toMatchObject({ id: sub.executionId, parentExecutionId: parent.executionId });
    expect(parent.runData.Run[0].logs?.some((log) => log.message.includes(sub.executionId))).toBe(true);
  });

  it('runs once per item, passes items through, and can start without waiting', async () => {
    child('wf_child_echo', [noOp('Echo')]);
    const each = await trigger(caller('wf_parent_each', { workflowId: 'wf_child_echo', mode: 'each' }), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(each.status).toBe('success');
    expect(each.subExecutions).toHaveLength(3);
    expect(outputOf(each, 'After')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    const background = await trigger(caller('wf_parent_nowait', { workflowId: 'wf_child_echo', options: { waitForSubWorkflow: false } }), [{ n: 9 }]);
    expect(background.status).toBe('success');
    expect(outputOf(background, 'After')).toEqual([{ n: 9 }]);
    await vi.waitFor(() => expect(stored(background.subExecutions![0].executionId)?.status).toBe('success'));
  });

  it('honours the callee’s caller policy', async () => {
    child('wf_child_private', [noOp('Echo')], [], { settings: { callerPolicy: 'none' } });
    const denied = await trigger(caller('wf_parent_denied', { workflowId: 'wf_child_private' }));
    expect(denied.status).toBe('error');
    expect(denied.error?.message).toContain('doesn’t allow this workflow to call it');
    child('wf_child_listed', [noOp('Echo')], [], { settings: { callerPolicy: 'list', callerIds: ['wf_parent_listed'] } });
    expect((await trigger(caller('wf_parent_listed', { workflowId: 'wf_child_listed' }))).status).toBe('success');
  });

  it('puts the parent into waiting while its sub-workflow waits, then resumes it with the child’s output', async () => {
    child('wf_child_waits', [hoursWait(), setFields('Result', [{ name: 'answer', value: 'yes {{ $json.n }}' }])], [
      ['Called', 'Wait'],
      ['Wait', 'Result'],
    ]);
    const parent = await trigger(caller('wf_parent_waits', { workflowId: 'wf_child_waits', ...mapped }), [{ n: 3 }]);
    expect(parent.status).toBe('waiting');
    const childId = parent.subExecutions![0].executionId;
    expect(parent.wait).toMatchObject({ resume: 'subworkflow', nodeName: 'Run', data: { executionId: childId } });
    expect(stored(childId)?.status).toBe('waiting');
    expect(waits.pending()).not.toContain(parent.executionId);

    await resumeExecution(childId, { kind: 'time' });
    await vi.waitFor(() => expect(stored(parent.executionId)?.status).toBe('success'));
    expect(outputOf(stored(parent.executionId), 'After')).toEqual([{ answer: 'yes 3' }]);
  });

  it('fails the waiting parent when its sub-workflow fails or is canceled', async () => {
    child('wf_child_fails_later', [hoursWait(), fail('Fail', 'child broke')], [
      ['Called', 'Wait'],
      ['Wait', 'Fail'],
    ]);
    const parent = await trigger(caller('wf_parent_fails_later', { workflowId: 'wf_child_fails_later' }), [{ n: 1 }]);
    await resumeExecution(parent.subExecutions![0].executionId, { kind: 'time' });
    await vi.waitFor(() => expect(stored(parent.executionId)?.status).toBe('error'));
    expect(stored(parent.executionId)?.error?.message).toContain('Sub-workflow failed: child broke');

    const other = await trigger(caller('wf_parent_canceled', { workflowId: 'wf_child_fails_later' }), [{ n: 1 }]);
    const childId = other.subExecutions![0].executionId;
    await executionRoute.DELETE(request(`/api/executions/${childId}`, { method: 'DELETE' }), params({ id: childId }));
    await vi.waitFor(() => expect(stored(other.executionId)?.status).toBe('error'));
    expect(stored(other.executionId)?.error?.message).toContain('canceled');
  });

  it('refuses to wait for several waiting children, and stops at 10 levels', async () => {
    const each = await trigger(caller('wf_parent_each_waits', { workflowId: 'wf_child_waits', mode: 'each' }), [{ n: 1 }]);
    expect(each.status).toBe('error');
    expect(each.error?.message).toBe('Sub-workflow is waiting; turn off ‘Wait for Sub-Workflow Completion’ or remove the Wait');

    save('wf_recursive', [
      { name: 'Called', type: 'core.workflowTrigger', parameters: { inputSource: 'passthrough' } },
      { name: 'Again', type: 'core.executeWorkflow', parameters: { workflowId: 'wf_recursive' } },
    ], [['Called', 'Again']]);
    const deep = await runWorkflow({ workflow: store.getWorkflow('wf_recursive')!, mode: 'trigger', startNodeId: 'Called', triggerItems: [{ json: {} }] });
    expect(deep.status).toBe('error');
    expect(deep.error?.message).toContain('nested at most 10 levels deep');
    expect(executionsOf('wf_recursive')).toHaveLength(11);
  });
});

describe('error workflows', () => {
  it('runs the Error Trigger workflow for failed non-manual executions only', async () => {
    const handler = save('wf_error_handler', [{ name: 'On Error', type: 'core.errorTrigger' }, noOp('Notify')], [['On Error', 'Notify']]);
    const failing = save('wf_failing', [start, fail('Fail', 'boom')], [['Start', 'Fail']], { name: 'Failing flow', settings: { errorWorkflowId: handler.id } });
    const failed = await trigger(failing);
    expect(failed.status).toBe('error');
    await vi.waitFor(() => expect(executionsOf(handler.id)).toHaveLength(1));
    const errorRun = stored(executionsOf(handler.id)[0].id)!;
    expect(errorRun.errorOf).toBe(failed.executionId);
    expect(outputOf(errorRun, 'Notify')).toEqual([
      {
        execution: { id: failed.executionId, url: `http://flow.test/workflows/wf_failing/executions/${failed.executionId}`, error: { message: 'boom' }, lastNodeExecuted: 'Fail', mode: 'trigger' },
        workflow: { id: 'wf_failing', name: 'Failing flow' },
      },
    ]);
    expect(errorItem(failed, failing)).toMatchObject({ execution: { id: failed.executionId } });

    await runWorkflow({ workflow: failing, mode: 'manual', startNodeId: 'Start' });
    const self = save('wf_error_self', [start, fail()], [['Start', 'Fail']], { settings: { errorWorkflowId: 'wf_error_self' } });
    await trigger(self);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executionsOf(handler.id)).toHaveLength(1);
    expect(executionsOf(self.id)).toHaveLength(1);
  });

  it('emits an example item when the Error Trigger runs in the editor', async () => {
    const handler = save('wf_error_manual', [{ name: 'On Error', type: 'core.errorTrigger' }], []);
    const manual = await runWorkflow({ workflow: handler, mode: 'manual', startNodeId: 'On Error', triggerItems: [{ json: {} }] });
    expect(outputOf(manual, 'On Error')?.[0]).toMatchObject({ execution: { error: { message: 'Example error message' } }, workflow: { name: 'Example Workflow' } });
  });
});

describe('workflow settings', () => {
  it('times a run out after settings.timeoutSeconds', async () => {
    const workflow = save('wf_timeout', [start, { name: 'Wait', type: 'core.wait', typeVersion: 2, parameters: { resume: 'timeInterval', amount: 5, unit: 'seconds' } }], [['Start', 'Wait']], {
      settings: { timeoutSeconds: 0.2 },
    });
    const started = Date.now();
    const record = await trigger(workflow);
    expect(record.status).toBe('error');
    expect(record.error?.message).toBe('Workflow timed out after 0.2 s');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('keeps or drops executions by the save settings (a waiting one is always kept)', async () => {
    const quiet = save('wf_save_none', [start, noOp('After')], [['Start', 'After']], { settings: { saveSuccessfulExecutions: false, saveManualExecutions: false } });
    const ok = await trigger(quiet);
    expect(ok.status).toBe('success');
    expect(stored(ok.executionId)).toBeUndefined();
    const failing = save('wf_save_failed', [start, fail()], [['Start', 'Fail']], { settings: { saveFailedExecutions: false } });
    expect(stored((await trigger(failing)).executionId)).toBeUndefined();
    const manual = await runWorkflow({ workflow: save('wf_save_manual', [start], [], { settings: { saveManualExecutions: false } }), mode: 'manual', startNodeId: 'Start' });
    expect(stored(manual.executionId)).toBeUndefined();

    const waiting = await trigger(save('wf_save_waiting', [start, hoursWait(), noOp('After')], [['Start', 'Wait'], ['Wait', 'After']], { settings: { saveSuccessfulExecutions: false } }));
    expect(stored(waiting.executionId)?.status).toBe('waiting');
    await resumeExecution(waiting.executionId, { kind: 'time' });
    expect(stored(waiting.executionId)).toBeUndefined();
  });
});
