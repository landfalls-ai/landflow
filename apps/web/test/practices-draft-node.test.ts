/**
 * Draft Practice (core.practiceDraft, docs/practices.md): a draft per item through the practices port with the right input and
 * origin, a store error failing only its item, and citations verified only in a flow an owner or admin saved (the `files` reach
 * the port only then; a member's flow, pin data and a tool call send none and say why). A fake port; no model, no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runNode, type ExecuteRequest, type JsonObject } from '@landflow/sdk';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-node-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { withAuth } = await import('@/lib/server/auth/context');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const { practiceDraftNode } = await import('@/lib/server/nodes/practices');
const { HttpError } = await import('@/lib/server/errors');
const { items } = await import('./helpers');
import type { PracticeDraftInput } from '@/lib/shared/practices';
import type { PracticeDraftOrigin, PracticesPort } from '@/lib/server/practices/port';

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@practices-node.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@practices-node.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const as = <T,>(user: typeof owner, fn: () => T): T => withAuth({ principal: { user, via: 'test' } }, fn);

afterAll(() => {
  setPracticesPort(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
afterEach(() => setPracticesPort(undefined));

const FILE = { repo: 'acme/widgets', sha: 'abc1234', path: 'deploy/helm/web/Chart.yaml', content: 'apiVersion: v2\nname: web\n' };
const EXCERPT = 'name: web';

interface Call {
  input: PracticeDraftInput;
  origin: PracticeDraftOrigin;
}
/** A port that records drafts and refuses the handle `taken/handle` the way the store does (409). */
function fakePort(): { calls: Call[]; port: PracticesPort } {
  const calls: Call[] = [];
  const port: PracticesPort = {
    enabled: () => true,
    approved: () => [],
    record: () => {},
    draft(input, origin) {
      calls.push({ input, origin });
      if (input.handle === 'taken/handle') throw new HttpError('That handle is taken', 409);
      const verified = (input.citations ?? []).map((c) => ({ ...c, verified: Boolean(origin.files?.some((f) => f.repo === c.repo && f.sha === c.sha && f.path === c.path && f.content.includes(c.excerpt))) }));
      const id = `pr_${calls.length}`;
      return {
        practice: { id, handle: input.handle } as never,
        version: { practiceId: id, version: 1, tainted: origin.source !== 'person', citations: verified } as never,
      };
    },
  };
  return { calls, port };
}

const params = (extra: Record<string, unknown> = {}) => ({
  handle: '{{ $json.handle }}',
  title: 'Helm charts live under deploy/helm',
  level: 'org',
  strength: 'required',
  topics: 'helm, devops',
  repositories: 'acme/widgets',
  paths: 'deploy/**',
  summary: 'Put charts in deploy/helm/<service>.',
  body: 'One chart per service.',
  checks: '[]',
  citations: JSON.stringify([{ repo: FILE.repo, sha: FILE.sha, path: FILE.path, lines: [2, 2], excerpt: EXCERPT }]),
  files: '{{ $json.files }}',
  ...extra,
});

function workflowOf(id: string, parameters: Record<string, unknown>, pinData?: Record<string, never>) {
  return {
    id,
    name: id,
    active: false,
    nodes: [
      { id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} },
      { id: 'draft', name: 'Draft', type: 'core.practiceDraft', typeVersion: 1, position: [260, 0] as [number, number], parameters },
    ],
    connections: [{ id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'draft', targetIndex: 0 }],
    ...(pinData && { pinData }),
  };
}

const outputs = (run: Awaited<ReturnType<typeof runWorkflow>>) => run.runData.draft?.at(-1)?.outputs[0]?.map((i) => i.json as Record<string, unknown>) ?? [];

describe('Draft Practice', () => {
  it('drafts one practice per input item with its origin, and a store error fails only that item', async () => {
    const { calls, port } = fakePort();
    setPracticesPort(port);
    as(owner, () => store.saveWorkflow(workflowOf('wf_items', params())));
    const run = await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_items')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ handle: 'helm/charts' }, { handle: 'taken/handle' }, { handle: 'helm/other' }) }));
    expect(run.status).toBe('success');
    const out = outputs(run);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ practiceId: 'pr_1', handle: 'helm/charts', version: 1, tainted: true, verified: 0, url: '/brain/practices/pr_1' });
    expect(out[1]).toMatchObject({ drafted: false, error: 'That handle is taken', status: 409 });
    expect(out[2]).toMatchObject({ practiceId: 'pr_3', handle: 'helm/other' });
    expect(calls[0].input).toMatchObject({ handle: 'helm/charts', level: 'org', strength: 'required', topics: ['helm', 'devops'], repos: ['acme/widgets'], paths: ['deploy/**'], summary: 'Put charts in deploy/helm/<service>.' });
    expect(calls[0].origin).toMatchObject({ source: 'learned', workflowId: 'wf_items', executionId: run.executionId });
    expect(calls[0].origin.actor).toBeUndefined();
  });

  it('a draft with no citations comes from an agent source', async () => {
    const { calls, port } = fakePort();
    setPracticesPort(port);
    as(owner, () => store.saveWorkflow(workflowOf('wf_plain', params({ citations: '[]' }))));
    await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_plain')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ handle: 'helm/charts' }) }));
    expect(calls[0].origin.source).toBe('agent');
  });

  it('in a flow an owner saved and ran, the files reach the port and the citation is verified', async () => {
    const { calls, port } = fakePort();
    setPracticesPort(port);
    as(owner, () => store.saveWorkflow(workflowOf('wf_owner', params())));
    const run = await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_owner')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ handle: 'helm/charts', files: [FILE] }) }));
    expect(calls[0].origin.files).toEqual([FILE]);
    expect(outputs(run)[0]).toMatchObject({ verified: 1, verification: 'checked' });
  });

  it('in a flow a member saved, no files reach the port and the output says why', async () => {
    const { calls, port } = fakePort();
    setPracticesPort(port);
    as(alice, () => store.saveWorkflow(workflowOf('wf_member', params())));
    const run = await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_member')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ handle: 'helm/charts', files: [FILE] }) }));
    expect(calls[0].origin.files).toBeUndefined();
    expect(outputs(run)[0]).toMatchObject({ verified: 0, verification: 'skipped' });
    expect(String(outputs(run)[0].reason)).toContain('owner or admin');
  });

  it('pin data upstream stops verification too', async () => {
    const { calls, port } = fakePort();
    setPracticesPort(port);
    const pinned = { ...workflowOf('wf_pinned', params()), pinData: { start: [{ json: { handle: 'helm/charts', files: [FILE] } }] } };
    as(owner, () => store.saveWorkflow(pinned as never));
    const run = await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_pinned')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ handle: 'helm/charts', files: [FILE] }) }));
    expect(calls[0].origin.files).toBeUndefined();
    expect(outputs(run)[0]).toMatchObject({ verification: 'skipped' });
    expect(String(outputs(run)[0].reason)).toContain('Pin data');
  });

  it('an unset port fails the item with the message', async () => {
    as(owner, () => store.saveWorkflow(workflowOf('wf_unset', params())));
    const run = await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_unset')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ handle: 'helm/charts' }) }));
    expect(outputs(run)[0]).toMatchObject({ drafted: false, error: 'Practices are not loaded' });
  });

  it('as an agent’s tool it names the agent, sends no files and is described as only drafting', async () => {
    const { calls, port } = fakePort();
    setPracticesPort(port);
    const request: ExecuteRequest = {
      protocol: 'landflow.plugin/v1',
      executionId: 'ex_tool',
      workflowId: 'agent:ag_1',
      mode: 'tool',
      node: { id: 'n1', name: 'Draft Practice', type: 'core.practiceDraft', typeVersion: 1 },
      parameters: { ...params({ handle: 'helm/charts', files: JSON.stringify([FILE]) }) } as JsonObject,
      itemParameters: [params({ handle: 'helm/charts', files: JSON.stringify([FILE]) }) as JsonObject],
      inputs: [items({})],
    };
    const response = await runNode(practiceDraftNode, request);
    expect(response.error).toBeUndefined();
    expect(calls[0].origin).toMatchObject({ source: 'learned', agentId: 'ag_1' });
    expect(calls[0].origin.workflowId).toBeUndefined();
    expect(calls[0].origin.files).toBeUndefined();
    expect(response.outputs[0][0].json).toMatchObject({ verification: 'skipped' });
    expect(practiceDraftNode.description.toolDescription).toContain('only drafts');
  });
});
