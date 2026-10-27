/**
 * `landflow publish --at` (and `workflows publish/unpublish --at`): the host stores a scheduled publish instead of
 * publishing now; `workflows schedules` lists it and `workflows unschedule` cancels it. The host's ticker publishes
 * it at its time (lib/server/publish-schedule.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAt } from '../src/commands/workflows';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;

const node = (id: string, name: string, type: string) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters: {} });

beforeAll(async () => {
  host = await startHost();
  cli = cliFor(host);
});

afterAll(async () => {
  await host?.close();
});

describe('parseAt', () => {
  it('reads ISO times and relative offsets, and refuses the past and nonsense', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    expect(parseAt('+2h', now)).toBe('2026-11-01T12:00:00.000Z');
    expect(parseAt('+30m', now)).toBe('2026-11-01T10:30:00.000Z');
    expect(parseAt('2026-11-02T09:00:00Z', now)).toBe('2026-11-02T09:00:00.000Z');
    expect(() => parseAt('2026-10-01T09:00:00Z', now)).toThrow(/future/);
    expect(() => parseAt('soon', now)).toThrow(/not a time/);
  });
});

describe('landflow publish --at', () => {
  it('schedules, lists, cancels, and the host publishes what is due', async () => {
    const { store } = await web('lib/server/store');
    const { publishedVersionId } = await web('lib/server/publications');
    const { publishSchedules } = await web('lib/server/publish-schedule');
    const workflow = store.saveWorkflow({ id: 'wf_cli_schedule', name: 'Scheduled by CLI', nodes: [node('start', 'Start', 'core.manualTrigger')], connections: [] });

    const scheduled = await cli(['publish', workflow.id, '--at', '+1h', '--note', 'later', '--json']);
    expect(scheduled.code).toBe(0);
    expect(scheduled.json).toMatchObject({ ok: true, workflowId: workflow.id, scheduled: { action: 'publish', status: 'pending', note: 'later' } });
    expect(publishedVersionId(workflow.id)).toBeUndefined();

    const listed = await cli(['workflows', 'schedules', workflow.id, '--json']);
    expect(listed.json.schedules).toHaveLength(1);
    expect((await cli(['workflows', 'schedules', workflow.id])).stdout).toMatch(/publish v1/);

    const bad = await cli(['publish', workflow.id, '--at', 'yesterday', '--json']);
    expect(bad.code).toBe(2);

    // The host runs it once its time has come.
    const ran = await publishSchedules.tick(new Date(Date.now() + 2 * 3600_000));
    expect(ran).toHaveLength(1);
    expect(publishedVersionId(workflow.id)).toBeDefined();

    const second = await cli(['unpublish', workflow.id, '--at', '+3h', '--json']);
    expect(second.json).toMatchObject({ scheduled: { action: 'unpublish', status: 'pending' } });
    const canceled = await cli(['workflows', 'unschedule', workflow.id, String((second.json as { scheduled: { id: string } }).scheduled.id), '--json']);
    expect(canceled.json).toMatchObject({ scheduled: { status: 'canceled' } });
    expect(await publishSchedules.tick(new Date(Date.now() + 4 * 3600_000))).toEqual([]);
    expect(publishedVersionId(workflow.id)).toBeDefined();
  });
});
