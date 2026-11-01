/**
 * GET /api/executions/:id/changes: the repository and branch come from the run's GitHub steps and journal, the comparison
 * is the GitHub plugin's Repository → Compare (faked here) with the flow's own credential, and the answer is kept per run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExecuteRequest, ExecuteResponse } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-changes-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { defineCredentialType, definePlugin } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { journalOf, releaseJournal, resetJournals } = await import('@/lib/server/journal');
const { store } = await import('@/lib/server/store');
const { GET } = await import('@/app/api/executions/[id]/changes/route');

afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// Only the credential type is real; the plugin's node is faked below.
registry.registerBuiltin(
  definePlugin({
    info: { id: 'github', name: 'GitHub', version: '1.0.0', language: 'typescript' },
    credentialTypes: [
      defineCredentialType({
        name: 'githubApi',
        displayName: 'GitHub API',
        properties: [
          { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.github.com' },
        ],
      }),
    ],
    nodes: [],
  }),
);

const TOKEN = 'ghp_fake-token-for-the-test';
const credential = credentials.create({ name: 'GitHub', type: 'github.githubApi', data: { accessToken: TOKEN, baseUrl: 'https://api.github.test' } });
const github = (id: string, owner: string, repository: string, withCredential = true): WorkflowNode => ({
  id,
  name: id,
  type: 'github.github',
  typeVersion: 1,
  position: [0, 0],
  parameters: { resource: 'branch', operation: 'create', owner, repository },
  ...(withCredential && { credentials: { githubApi: { id: credential.id, name: credential.name } } }),
});

/** Stands in for the plugin: answers Repository → Compare like the real one and records what it was asked. */
const asked: ExecuteRequest[] = [];
const compare = (files = 2) => ({
  base: 'main',
  head: 'agents/x-1',
  status: 'ahead',
  aheadBy: 2,
  behindBy: 0,
  totalCommits: 2,
  url: 'https://github.com/acme/widgets/compare/main...agents/x-1',
  files: Array.from({ length: files }, (_, n) => ({ path: `src/file-${n}.ts`, status: 'added', additions: 3, deletions: 0, previousPath: null, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' })),
  truncated: false,
});
function fakePlugin(answer: () => ExecuteResponse | Promise<ExecuteResponse>) {
  return vi.spyOn(registry, 'resolve').mockImplementation(
    () =>
      ({
        type: 'github.github',
        pluginId: 'github',
        transport: 'http',
        descriptor: { name: 'github', displayName: 'GitHub', credentials: [{ name: 'githubApi', required: true }], properties: [] },
        execute: async (request: ExecuteRequest) => {
          asked.push(request);
          return answer();
        },
      }) as never,
  );
}
const ok = (json: object): ExecuteResponse => ({ outputs: [[{ json: json as never }]] });

/** A finished run whose journal has a Create branch step, as run 2's does. */
function makeRun(id: string, nodes: WorkflowNode[], extra: (record: (e: never) => void) => void = () => {}) {
  const wf = store.saveWorkflow({ id: `wf_${id}`, name: id, nodes, connections: [] });
  const now = new Date().toISOString();
  store.saveExecution({ executionId: id, workflowId: wf.id, workflowName: id, mode: 'manual', status: 'success', startedAt: now, finishedAt: now, durationMs: 1, runData: {}, executionOrder: [] });
  const journal = journalOf(id, { workflowId: wf.id });
  journal.record({ type: 'span.started', spanId: 'node:branch:0', kind: 'step', name: 'Create branch', actor: { id: 'workflow', name: id, type: 'system' }, attrs: { nodeType: 'github.github' } });
  journal.record({ type: 'span.ended', spanId: 'node:branch:0', status: 'success', output: { branch: 'agents/x-1', ref: 'refs/heads/agents/x-1', sha: 'abc1234' } });
  extra((e) => journal.record(e as never));
  releaseJournal(id);
}
const call = async (id: string) => {
  const response = await GET(new Request(`http://localhost/api/executions/${id}/changes`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

describe('GET /api/executions/:id/changes', () => {
  it('compares the run’s branch with the base through the plugin, with the flow’s own credential', async () => {
    makeRun('ex_ok', [github('branch', 'acme', 'widgets')], (record) => {
      record({ type: 'span.started', spanId: 'node:pr:0', kind: 'step', name: 'Open PR', actor: { id: 'workflow', name: 'ex_ok', type: 'system' }, attrs: { nodeType: 'github.github' } } as never);
      record({ type: 'span.ended', spanId: 'node:pr:0', status: 'success', output: { number: 2, head: 'agents/x-1', base: 'develop', url: 'https://github.com/acme/widgets/pull/2' } } as never);
    });
    const spy = fakePlugin(() => ok(compare()));
    asked.length = 0;
    const { status, body } = await call('ex_ok');
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, repository: { owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets' }, branch: { base: 'main', head: 'agents/x-1', aheadBy: 2, truncated: false } });
    expect(body.branch.files).toHaveLength(2);
    expect(body.branch.files[0]).toMatchObject({ path: 'src/file-0.ts', status: 'added', additions: 3, deletions: 0, patch: expect.stringContaining('+a') });
    expect(asked).toHaveLength(1);
    expect(asked[0].parameters).toMatchObject({ resource: 'repository', operation: 'compare', owner: 'acme', repository: 'widgets', compareBase: 'develop', compareHead: 'agents/x-1' });
    // The credential is the flow's own, handed to the plugin and never to the browser.
    expect(asked[0].credentials?.githubApi).toMatchObject({ accessToken: TOKEN });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    spy.mockRestore();
  });

  it('keeps the answer per run', async () => {
    makeRun('ex_cached', [github('branch', 'acme', 'widgets')]);
    const spy = fakePlugin(() => ok(compare(1)));
    asked.length = 0;
    const first = await call('ex_cached');
    const second = await call('ex_cached');
    expect(asked).toHaveLength(1);
    expect(second.body).toEqual(first.body);
    spy.mockRestore();
  });

  it('says why it cannot answer, without calling GitHub: no step, no credential, no branch, no repository', async () => {
    const spy = fakePlugin(() => ok(compare()));
    asked.length = 0;
    makeRun('ex_nogithub', []);
    expect((await call('ex_nogithub')).body).toEqual({ available: false, reason: 'This run has no GitHub step.', noGitHub: true });
    makeRun('ex_nocred', [github('branch', 'acme', 'widgets', false)]);
    expect((await call('ex_nocred')).body.reason).toMatch(/no credential/);
    const wf = store.saveWorkflow({ id: 'wf_nobranch', name: 'nobranch', nodes: [github('branch', 'acme', 'widgets')], connections: [] });
    const now = new Date().toISOString();
    store.saveExecution({ executionId: 'ex_nobranch', workflowId: wf.id, workflowName: 'nobranch', mode: 'manual', status: 'success', startedAt: now, finishedAt: now, durationMs: 1, runData: {}, executionOrder: [] });
    journalOf('ex_nobranch', { workflowId: wf.id }).record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'nobranch', actor: { id: 'workflow', name: 'nobranch', type: 'system' } });
    releaseJournal('ex_nobranch');
    expect((await call('ex_nobranch')).body.reason).toBe('The run does not say which branch it worked on.');
    makeRun('ex_noparams', [github('branch', '{{ $json.owner }}', '{{ $json.repo }}')]);
    expect((await call('ex_noparams')).body.reason).toBe('The run does not say which repository it worked on.');
    expect(asked).toHaveLength(0);
    spy.mockRestore();
  });

  it('answers available: false with GitHub’s own message when the comparison fails, and does not keep it', async () => {
    makeRun('ex_refused', [github('branch', 'acme', 'widgets')]);
    let calls = 0;
    const spy = fakePlugin(() => {
      calls++;
      return { outputs: [[]], error: { message: 'GitHub API error 404: Not Found', description: 'Check owner, repository, branch and path.', itemIndex: 0 } } as ExecuteResponse;
    });
    expect((await call('ex_refused')).body).toEqual({ available: false, reason: 'GitHub API error 404: Not Found Check owner, repository, branch and path.' });
    await call('ex_refused');
    expect(calls).toBe(2);
    spy.mockRestore();
  });

  it('404s for a run that does not exist', async () => {
    expect((await call('ex_missing')).status).toBe(404);
  });
});
