/**
 * The Learn practices template (docs/templates.md#built-in-learn-practices) runs end to end: the GitHub plugin's own node
 * in-process against its in-memory fake GitHub (a few made-up files), a scripted model, and a fake practices port. A flow
 * an owner saved and ran drafts with citations the port marks verified; one a member saved drafts with none verified. The
 * template validates against the recorded plugin manifests like the other built-in ones. No network beyond loopback.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin, type IPlugin, type NodeItem } from '@landflow/sdk';
import type { LanguageModel } from '@landflow/engine';
import { GitHub, githubApi } from '../../../plugins/github/src/nodes/github';
import { FakeGitHub, TOKEN } from '../../../plugins/github/test/fake-github';
import { startFakeApi, type FakeApi } from '../../../plugins/github/test/helpers';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-flow-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const templates = await import('@/lib/server/templates');
const { runWorkflow } = await import('@/lib/server/runner');
const { createUser } = await import('@/lib/server/auth/users');
const { withAuth } = await import('@/lib/server/auth/context');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const { normalizeWorkflow, validateWorkflow } = await import('@/lib/server/mcp/workflows');
const { items } = await import('./helpers');
import type { PracticeDraftInput } from '@/lib/shared/practices';
import type { PracticeDraftOrigin, PracticesPort } from '@/lib/server/practices/port';

const githubManifest = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/plugin-manifests/github.json'), 'utf8'));

// A scripted chat model sub-node in place of the template's Ollama one.
let reply = '[]';
const prompts: string[] = [];
const scripted = defineNode({
  description: { name: 'scripted', displayName: 'Scripted Model', description: 'Replies from a script', version: 1, kind: 'subnode', supplies: 'ai_languageModel', categories: ['AI'], inputs: [], outputs: [{ type: 'ai_languageModel', displayName: 'Model' }], properties: [] },
  supplyData: (): LanguageModel => ({
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      prompts.push(String(input.messages.at(-1)?.content ?? ''));
      return { text: reply, toolCalls: [], stopReason: 'stop' };
    },
  }),
});

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(definePlugin({ info: githubManifest.plugin, nodes: [GitHub], credentialTypes: [githubApi], iconDir: new URL('../../../plugins/github/icons/', import.meta.url) }) as IPlugin);
registry.registerBuiltin(definePlugin({ info: { id: 'test', name: 'Test', version: '1.0.0', language: 'typescript' }, nodes: [scripted] }) as IPlugin);

const owner = await createUser({ email: 'owner@practices-flow.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@practices-flow.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const as = <T,>(user: typeof owner, fn: () => T): T => withAuth({ principal: { user, via: 'test' } }, fn);

const CHART = 'apiVersion: v2\nname: web\nversion: 0.1.0\n';
const CLAUDE = 'Charts live in deploy/helm.\nService names are lowercase.\n';
const fake = new FakeGitHub();
let api: FakeApi;
let slot = '';

function seedRepository() {
  fake.reset();
  const files = {
    'deploy/helm/web/Chart.yaml': fake.addBlob(CHART),
    'deploy/helm/web/values.yaml': fake.addBlob('replicas: 2\n'),
    'deploy/logo.png': fake.addBlob(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    'deploy/big.yaml': fake.addBlob('a: b\n'.repeat(6000)),
    'CLAUDE.md': fake.addBlob(CLAUDE),
  };
  fake.refs.set('main', fake.addCommit('Seed', fake.addTree(files), []));
}

beforeAll(async () => {
  api = await startFakeApi(fake.handle);
  slot = credentials.create({ name: 'GitHub (test)', type: 'github.githubApi', data: { accessToken: TOKEN, baseUrl: `${api.url}/api/v3` } }).id;
});
afterAll(async () => {
  await api.close();
  setPracticesPort(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

interface Call {
  input: PracticeDraftInput;
  origin: PracticeDraftOrigin;
}
let calls: Call[] = [];
beforeEach(() => {
  seedRepository();
  calls = [];
  prompts.length = 0;
  const port: PracticesPort = {
    enabled: () => true,
    approved: () => [],
    record: () => {},
    draft(input, origin) {
      calls.push({ input, origin });
      const citations = (input.citations ?? []).map((c) => ({ ...c, verified: Boolean(origin.files?.some((f) => f.repo === c.repo && f.sha === c.sha && f.path === c.path && f.content.includes(c.excerpt))) }));
      const id = `pr_${calls.length}`;
      return { practice: { id, handle: input.handle } as never, version: { practiceId: id, version: 1, tainted: true, citations } as never };
    },
  };
  setPracticesPort(port);
});

const practice = (over: Record<string, unknown> = {}) => ({
  handle: 'helm/chart-location',
  title: 'Charts live under deploy/helm',
  strength: 'required',
  topics: ['helm', 'devops'],
  paths: ['deploy/**'],
  summary: 'Put a service’s chart in deploy/helm/<service>.',
  body: 'One chart per service.',
  citations: [{ path: 'deploy/helm/web/Chart.yaml', lines: [2, 2], excerpt: 'name: web' }, { path: 'CLAUDE.md', lines: [1, 1], excerpt: 'Charts live in deploy/helm.' }, { path: 'CLAUDE.md', excerpt: 'something the file never said' }],
  ...over,
});

/** Use the template as `user` with the slot picked and the model swapped for the scripted one. */
async function install(user: typeof owner) {
  const used = await as(user, () => templates.useTemplate('practices-learn-github', { credentials: { 'github-contents': slot } }));
  const workflow = store.getWorkflow(used.workflow!.id)!;
  const nodes = workflow.nodes.map((n) => {
    if (n.name === 'Ollama Chat Model') return { ...n, type: 'test.scripted', parameters: {} };
    if (n.name === 'What to read') return { ...n, parameters: { ...n.parameters, json: JSON.stringify({ reads: [{ owner: 'acme', repository: 'widgets', paths: ['deploy/helm/web/', 'deploy/', 'CLAUDE.md'] }] }) } };
    return n;
  });
  as(user, () => store.saveWorkflow({ ...workflow, nodes }));
  return store.getWorkflow(workflow.id)!;
}

async function start(workflow: Awaited<ReturnType<typeof install>>, user: typeof owner) {
  const id = workflow.nodes.find((n) => n.name === 'Start')!.id;
  const record = await as(user, () => runWorkflow({ workflow, mode: 'manual', startNodeId: id, triggerItems: items({}) }));
  const out = (name: string): NodeItem[] => record.runData[workflow.nodes.find((n) => n.name === name)!.id]?.at(-1)?.outputs.flat() ?? [];
  return { record, out };
}

describe('the template', () => {
  it('validates against the recorded plugin manifests, with the GitHub plugin’s own credential slot', () => {
    const template = templates.BUILTIN_TEMPLATES.find((t) => t.id === 'practices-learn-github')!;
    expect(template.name).toBe('Learn practices from GitHub');
    expect(template.categories).toEqual(['productivity', 'data']);
    expect(template.credentials.map((c) => ({ id: c.id, type: c.type }))).toEqual([{ id: 'github-contents', type: 'github.githubApi' }]);
    expect(template.nodeTypes).toEqual(expect.arrayContaining(['core.practiceDraft', 'github.github']));
    expect(validateWorkflow({ ...normalizeWorkflow(structuredClone(template.workflow)), id: 'wf_template' }).errors).toEqual([]);
  });

  it('as an owner reads the files at the default branch’s commit and drafts with verified citations', async () => {
    reply = JSON.stringify([practice()]);
    const { record, out } = await start(await install(owner), owner);
    expect(record.error?.message).toBeUndefined();
    expect(record.status).toBe('success');

    // The files: the directory's text files and CLAUDE.md, each read at the commit; the listing of deploy/ drops the logo and the 30 KB file, and a path that is a file is read directly.
    expect(out('Files to read').map((i) => i.json.path).sort()).toEqual(['CLAUDE.md', 'deploy/helm/web/Chart.yaml', 'deploy/helm/web/values.yaml']);
    const sent = prompts[0];
    expect(sent).toContain('name: web');
    expect(sent).toContain('Charts live in deploy/helm.');
    expect(sent).not.toContain('a: b\na: b');
    expect(sent).not.toContain('PNG');
    const commit = fake.refs.get('main')!;

    expect(calls).toHaveLength(1);
    const { input, origin } = calls[0];
    expect(input).toMatchObject({ handle: 'helm/chart-location', level: 'org', strength: 'required', repos: ['acme/widgets'], topics: ['helm', 'devops'] });
    // The citation the file never held was dropped before the node; the others carry the repository and commit.
    expect(input.citations).toEqual([
      { repo: 'acme/widgets', sha: commit, path: 'deploy/helm/web/Chart.yaml', lines: [2, 2], excerpt: 'name: web' },
      { repo: 'acme/widgets', sha: commit, path: 'CLAUDE.md', lines: [1, 1], excerpt: 'Charts live in deploy/helm.' },
    ]);
    expect(origin.source).toBe('learned');
    expect(origin.files?.map((f) => f.path).sort()).toEqual(expect.arrayContaining(['CLAUDE.md', 'deploy/helm/web/Chart.yaml']));
    expect(out('Draft Practice')[0].json).toMatchObject({ practiceId: 'pr_1', verified: 2, verification: 'checked', tainted: true });
  });

  it('in a flow a member saved it still drafts, but no citation is verified', async () => {
    reply = JSON.stringify([practice()]);
    const { record, out } = await start(await install(alice), owner);
    expect(record.status).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0].origin.files).toBeUndefined();
    expect(out('Draft Practice')[0].json).toMatchObject({ verified: 0, verification: 'skipped' });
  });

  it('citation entries that are not objects, and a bad lines value, do not stop the draft', async () => {
    reply = JSON.stringify([practice({ topics: ['Helm Charts', 'devops'], citations: [null, 'text', { path: 'CLAUDE.md', lines: ['a'], excerpt: 'Charts live in deploy/helm.' }] })]);
    const { record } = await start(await install(owner), owner);
    expect(record.status).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0].input.topics).toEqual(['devops']);
    expect(calls[0].input.citations).toHaveLength(1);
    expect(calls[0].input.citations![0]).toMatchObject({ path: 'CLAUDE.md', excerpt: 'Charts live in deploy/helm.' });
    expect(calls[0].input.citations![0].lines).toBeUndefined();
  });

  it('an answer that is not JSON drafts nothing and the run still ends', async () => {
    reply = 'Sorry, I cannot.';
    const { record, out } = await start(await install(owner), owner);
    expect(record.status).toBe('success');
    expect(calls).toEqual([]);
    expect(out('Draft Practice')).toEqual([]);
  });
});
