/**
 * Promotion beyond workflows, with two instances in one process (development and staging, each with its own data
 * directory and singletons) and a local bare Git repository: development promotes the definitions of the credentials
 * its workflows use (name, type, non-secret fields; a secret field left empty or mapped to a `$secrets` reference,
 * never its value) and the rows of a data table it opted in; staging's pull creates the missing credentials and
 * replaces the table's rows. Then four-eyes on promotion: a promotion becomes a request another admin approves (not
 * the requester, not a member), which promotes only what was previewed (stale otherwise), and can be rejected or
 * withdrawn.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { EnvironmentView, PromotionRequestView, PromotionResult } from '@/lib/shared/secrets';
import type { SourceControlPullResult } from '@/lib/shared/sync';

vi.setConfig({ testTimeout: 60_000 });

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

const bare = temp('landflow-promote-data-bare-');
sh(['init', '-q', '--bare', bare]);

Object.assign(process.env, { LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });
delete process.env.LANDFLOW_GIT_TOKEN;

type Env = Record<string, string | undefined>;

async function boot(env: Env) {
  const map = new Map<string, unknown>();
  (globalThis as { __landflow?: Map<string, unknown> }).__landflow = map;
  applyEnv(env);
  vi.resetModules();
  const m = {
    store: (await import('@/lib/server/store')).store,
    credentials: (await import('@/lib/server/credentials/vault')).credentials,
    dataTables: (await import('@/lib/server/datatables')).dataTables,
    sync: await import('@/lib/server/sync'),
    users: await import('@/lib/server/auth/users'),
    testAuth: await import('@/lib/server/auth/test-bypass'),
    governance: await import('@/lib/server/governance/policy'),
    audit: await import('@/lib/server/audit/store'),
    sourceControl: await import('@/app/api/source-control/route'),
    push: await import('@/app/api/source-control/push/route'),
    environment: await import('@/app/api/environment/route'),
    promote: await import('@/app/api/environment/promote/route'),
    pull: await import('@/app/api/environment/pull/route'),
    requests: await import('@/app/api/environment/promotion-requests/route'),
    approve: await import('@/app/api/environment/promotion-requests/[id]/approve/route'),
    reject: await import('@/app/api/environment/promotion-requests/[id]/reject/route'),
    cancel: await import('@/app/api/environment/promotion-requests/[id]/cancel/route'),
  };
  m.testAuth.enableTestAuth();
  await (await import('@/lib/server/bootstrap')).ensureBootstrapped();
  for (const workflow of m.store.listWorkflows()) m.store.deleteWorkflow(workflow.id);
  return { env, map, m };
}
type Instance = Awaited<ReturnType<typeof boot>>;

function applyEnv(env: Env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function use(instance: Instance) {
  (globalThis as { __landflow?: Map<string, unknown> }).__landflow = instance.map;
  applyEnv(instance.env);
  return instance.m;
}

const json = (path: string, method: string, body?: unknown) =>
  new Request(`http://promotion-data.test${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const read = async <T>(response: Response) => ({ status: response.status, body: (await response.json()) as T & { error?: string } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name: id, type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });

let dev: Instance;
let staging: Instance;
type User = Awaited<ReturnType<Instance['m']['users']['createUser']>>;
let alice: User;
let bob: User;
let carol: User;
let countries = '';

async function as<T>(user: User | undefined, fn: () => Promise<T>): Promise<T> {
  const m = use(dev);
  m.testAuth.enableTestAuth(user);
  try {
    return await fn();
  } finally {
    m.testAuth.enableTestAuth();
  }
}
const promote = (body: Record<string, unknown>, user?: User) => as(user, async () => read<PromotionResult & { approvalRequired?: boolean; request?: PromotionRequestView }>(await use(dev).promote.POST(json('/api/environment/promote', 'POST', body))));
const pull = async (body: Record<string, unknown> = {}) => read<SourceControlPullResult>(await use(staging).pull.POST(json('/api/environment/pull', 'POST', body)));
const push = async (message: string) => expect((await use(dev).push.POST(json('/api/source-control/push', 'POST', { message }))).status).toBe(200);
const decide = (verb: 'approve' | 'reject' | 'cancel', id: string, user: User, comment?: string) =>
  as(user, async () => {
    const m = use(dev);
    const route = verb === 'approve' ? m.approve : verb === 'reject' ? m.reject : m.cancel;
    return read<{ request: PromotionRequestView; result?: PromotionResult }>(await route.POST(json(`/api/environment/promotion-requests/${id}/${verb}`, 'POST', comment === undefined ? {} : { comment }), params(id)));
  });
const branchFile = (path: string) => sh(['show', `refs/heads/staging:${path}`], bare);

beforeAll(async () => {
  dev = await boot({ LANDFLOW_DATA_DIR: temp('landflow-promote-data-dev-'), LANDFLOW_ENVIRONMENT: 'development', LANDFLOW_ENVIRONMENT_PROTECTED: undefined });
  staging = await boot({ LANDFLOW_DATA_DIR: temp('landflow-promote-data-staging-'), LANDFLOW_ENVIRONMENT: 'staging', LANDFLOW_ENVIRONMENT_PROTECTED: 'true' });
  const m = use(dev);
  alice = await m.users.createUser({ email: 'alice@promote.test', name: 'Alice', role: 'admin', password: 'alice-password-1' });
  bob = await m.users.createUser({ email: 'bob@promote.test', name: 'Bob', role: 'admin', password: 'bob-password-1' });
  carol = await m.users.createUser({ email: 'carol@promote.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
});

afterAll(() => {
  use(dev).governance.updateGovernancePolicy({ fourEyes: { enabled: false } });
});

describe('credentials and data table rows', () => {
  it('development opts a table in, maps a secret field, pushes and previews', async () => {
    const m = use(dev);
    expect((await m.sourceControl.PUT(json('/api/source-control', 'PUT', { repository: bare, branch: 'development' }))).status).toBe(200);
    const key = m.credentials.create({ name: 'API key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key', value: 'dev-secret-111111' } });
    const mapped = m.credentials.create({ name: 'Partner key', type: 'core.httpHeaderAuth', data: { name: 'X-Partner', value: 'dev-secret-222222' } });
    const table = m.dataTables().createTable({ name: 'Countries', columns: [{ name: 'code', type: 'string' }, { name: 'rate', type: 'number' }] });
    countries = table.id;
    m.dataTables().insertRows(table.id, [{ code: 'FR', rate: 20 }, { code: 'DE', rate: 19 }]);
    const logs = m.dataTables().createTable({ name: 'Logs', columns: [{ name: 'line', type: 'string' }] });
    m.dataTables().insertRows(logs.id, [{ line: 'dev only' }]);
    m.store.saveWorkflow({
      id: 'wf_calls',
      name: 'Calls',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'core.httpRequest', { method: 'GET', url: 'http://127.0.0.1:9/x', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, { credentials: { httpHeaderAuth: { id: key.id, name: key.name } } }),
        node('Partner', 'core.httpRequest', { method: 'GET', url: 'http://127.0.0.1:9/y', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, { credentials: { httpHeaderAuth: { id: mapped.id, name: mapped.name } } }),
      ],
      connections: [{ id: 'e1', type: 'main', source: 'Start', sourceIndex: 0, target: 'Call', targetIndex: 0 }],
    } as Workflow);

    const saved = await read<EnvironmentView>(
      await m.environment.PUT(
        json('/api/environment', 'PUT', {
          rowTables: ['Countries'],
          secretMappings: [{ type: 'core.httpHeaderAuth', name: 'Partner key', field: 'value', value: '{{ $secrets.vault.partner.key }}', environment: 'staging' }],
        }),
      ),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.rowTables).toEqual([{ id: table.id, name: 'Countries' }]);
    expect(saved.body.secretMappings).toEqual([{ type: 'core.httpHeaderAuth', name: 'Partner key', field: 'value', value: '{{ $secrets.vault.partner.key }}', environment: 'staging' }]);
    // A mapping must read $secrets (a literal would copy a secret), and the table must exist.
    expect((await m.environment.PUT(json('/api/environment', 'PUT', { secretMappings: [{ type: 'core.httpHeaderAuth', name: 'API key', field: 'value', value: 'plain-secret' }] }))).status).toBe(400);
    expect((await m.environment.PUT(json('/api/environment', 'PUT', { rowTables: ['No such table'] }))).status).toBe(404);
    await push('Initial');

    const preview = await promote({ target: 'staging', dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.credentials).toEqual([
      { name: 'API key', type: 'core.httpHeaderAuth', status: 'added', secretFields: ['value'], mapped: [] },
      { name: 'Partner key', type: 'core.httpHeaderAuth', status: 'added', secretFields: ['value'], mapped: ['value'] },
    ]);
    expect(preview.body.tables).toEqual([{ id: table.id, name: 'Countries', path: 'data-tables/countries.rows.json', rows: 2, status: 'added' }]);
    const rowsFile = preview.body.files.find((f) => f.path === 'data-tables/countries.rows.json')!;
    expect(rowsFile).toMatchObject({ status: 'A' });
    expect(rowsFile.diff).toContain('+      "code": "FR",');
    const credentialsFile = preview.body.files.find((f) => f.path === 'credentials.json')!;
    expect(credentialsFile.diff).toContain('+        "value": "{{ $secrets.vault.partner.key }}"');
    expect(preview.body.digest).toMatch(/^[0-9a-f]{64}$/);
    // Secret values never appear, nor the rows of a table that isn't opted in.
    expect(JSON.stringify(preview.body)).not.toMatch(/dev-secret-|dev only/);

    // Leaving the definitions out, and the rows (`rowTables: []`), is the old promotion.
    const bare_ = await promote({ target: 'staging', dryRun: true, credentials: false, rowTables: [] });
    expect(bare_.body.credentials).toEqual([]);
    expect(bare_.body.tables).toEqual([]);
    expect(bare_.body.files.find((f) => f.path === 'credentials.json')!.diff).not.toContain('"data"');
  });

  it('promotes them: the branch holds definitions and rows, never a secret value', async () => {
    const promoted = await promote({ target: 'staging' });
    expect(promoted.body).toMatchObject({ promoted: true, conflicts: 0 });
    const credentialsFile = JSON.parse(branchFile('credentials.json')) as { credentials: unknown[] };
    expect(credentialsFile.credentials).toEqual([
      { name: 'API key', type: 'core.httpHeaderAuth', data: { name: 'X-Api-Key' }, secretFields: ['value'] },
      { name: 'Partner key', type: 'core.httpHeaderAuth', data: { name: 'X-Partner', value: '{{ $secrets.vault.partner.key }}' }, secretFields: ['value'] },
    ]);
    expect(JSON.parse(branchFile('data-tables/countries.rows.json'))).toEqual({ id: countries, name: 'Countries', rows: [{ code: 'FR', rate: 20 }, { code: 'DE', rate: 19 }] });
    const tree = sh(['ls-tree', '-r', '--name-only', 'refs/heads/staging'], bare);
    expect(tree).not.toContain('logs.rows.json');
    expect(sh(['log', '-p', 'refs/heads/staging'], bare)).not.toMatch(/dev-secret-/);
    expect(sh(['log', '-1', '--format=%B', 'refs/heads/staging'], bare)).toMatch(/- credential added: API key \(core\.httpHeaderAuth\)\n- credential added: Partner key[^\n]*\n- rows added: Countries \(2\)/);
  });

  it('staging pulls: missing credentials are created from their definitions and the rows land', async () => {
    const m = use(staging);
    expect((await m.sourceControl.PUT(json('/api/source-control', 'PUT', { repository: bare, branch: 'staging' }))).status).toBe(200);
    // Staging has its own rows in a table of that name: the promoted rows replace them.
    const preview = await pull({ dryRun: true });
    expect(preview.status).toBe(200);
    const changes = preview.body.changes.map((c) => `${c.action} ${c.kind} ${c.name}${c.fields ? ` [${c.fields.join(', ')}]` : ''}`);
    expect(changes).toEqual(
      expect.arrayContaining([
        'create dataTable Countries',
        'create tableRows Countries [2 rows]',
        'create credential API key [core.httpHeaderAuth, value (empty)]',
        'create credential Partner key [core.httpHeaderAuth]',
        'create workflow Calls',
      ]),
    );
    expect(preview.body.warnings.join('\n')).toMatch(/credential “API key” \(core\.httpHeaderAuth\) is created without value: fill it in on this instance/);
    expect(preview.body.warnings.join('\n')).not.toMatch(/isn't on this instance/);

    const pulled = await pull();
    expect(pulled.body.applied).toBe(true);
    expect(pulled.body.errors).toEqual([]);
    const created = m.credentials.list().filter((c) => c.type === 'core.httpHeaderAuth');
    expect(created.map((c) => c.name).sort()).toEqual(['API key', 'Partner key']);
    const apiKey = m.credentials.get(created.find((c) => c.name === 'API key')!.id)!;
    expect(apiKey.data).toEqual({ name: 'X-Api-Key' });
    expect(apiKey.secrets).toEqual([]);
    const partner = m.credentials.get(created.find((c) => c.name === 'Partner key')!.id)!;
    // A `$secrets` reference is no secret: it shows, and resolves against staging's providers.
    expect(partner.data).toEqual({ name: 'X-Partner', value: '{{ $secrets.vault.partner.key }}' });
    // The pulled workflow points at them.
    const workflow = m.store.getWorkflow('wf_calls')!;
    expect(workflow.nodes.find((n) => n.id === 'Call')!.credentials!.httpHeaderAuth.id).toBe(apiKey.id);
    expect(workflow.nodes.find((n) => n.id === 'Partner')!.credentials!.httpHeaderAuth.id).toBe(partner.id);
    const rows = m.dataTables().listRows(countries, { sortBy: 'id', sortDirection: 'asc' }).rows;
    expect(rows.map((r) => [r.code, r.rate])).toEqual([['FR', 20], ['DE', 19]]);

    // Pulling again changes nothing; staging fills the secret in, and the next pull leaves its credential alone.
    expect((await pull({ dryRun: true })).body.changes).toEqual([]);
    m.credentials.update(apiKey.id, { data: { value: 'staging-secret-333333' } });
    m.dataTables().insertRows(countries, [{ code: 'XX', rate: 0 }]);
    const again = await pull({ dryRun: true });
    expect(again.body.changes.map((c) => `${c.action} ${c.kind} ${c.name}`)).toEqual(['update tableRows Countries']);
    expect((await pull()).body.applied).toBe(true);
    expect(m.dataTables().listRows(countries).rows.map((r) => r.code)).toEqual(['FR', 'DE']);
    expect(m.credentials.testData('core.httpHeaderAuth', {}, apiKey.id).value).toBe('staging-secret-333333');
  });

  it('a pull never takes a secret value from a file', async () => {
    const m = use(staging);
    const files = [
      { path: 'landflow-sync.json', content: '{ "format": "landflow-sync/v1" }\n' },
      { path: 'credentials.json', content: JSON.stringify({ credentials: [{ name: 'Smuggled', type: 'core.httpHeaderAuth', data: { name: 'X-S', value: 'literal-secret-444444' }, secretFields: ['value'] }] }) },
    ];
    const plan = m.sync.planSync(files);
    expect(plan.changes).toContainEqual(expect.objectContaining({ kind: 'credential', action: 'create', name: 'Smuggled', fields: ['core.httpHeaderAuth', 'value (empty)'] }));
    expect(plan.warnings.join('\n')).toMatch(/“Smuggled”: value holds a value instead of a \$secrets reference: left out/);
    await m.sync.applySync(files);
    const smuggled = m.credentials.list().find((c) => c.name === 'Smuggled')!;
    expect(m.credentials.get(smuggled.id)!.data).toEqual({ name: 'X-S' });
    expect(m.credentials.testData('core.httpHeaderAuth', {}, smuggled.id).value).toBeUndefined();
    m.credentials.delete(smuggled.id);
  });
});

describe('four-eyes on promotion', () => {
  let first: PromotionRequestView;

  it('a promotion becomes a request; the requester and members can’t approve; another admin promotes it', async () => {
    const m = use(dev);
    m.governance.updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'member', unpublish: true, notifyEmail: false, channelIds: [] } });
    m.dataTables().insertRows(countries, [{ code: 'IT', rate: 22 }]);
    const before = sh(['rev-parse', 'refs/heads/staging'], bare);

    // A preview is still a preview.
    expect((await promote({ target: 'staging', dryRun: true }, alice)).body).toMatchObject({ dryRun: true, tables: [expect.objectContaining({ name: 'Countries', rows: 3, status: 'modified' })] });
    const asked = await promote({ target: 'staging', message: 'Add Italy' }, alice);
    expect(asked.status).toBe(202);
    expect(asked.body.approvalRequired).toBe(true);
    first = asked.body.request!;
    expect(first).toMatchObject({ status: 'pending', source: 'development', target: 'staging', message: 'Add Italy', requestedBy: alice.id, requestedByName: 'Alice', canApprove: false, canCancel: true });
    expect(first.preview.tables).toEqual([expect.objectContaining({ name: 'Countries', rows: 3, status: 'modified' })]);
    expect(sh(['rev-parse', 'refs/heads/staging'], bare)).toBe(before);

    const listed = await as(bob, async () => read<{ requests: PromotionRequestView[]; fourEyes: boolean }>(await use(dev).requests.GET(json('/api/environment/promotion-requests', 'GET'))));
    expect(listed.body.fourEyes).toBe(true);
    expect(listed.body.requests).toEqual([expect.objectContaining({ id: first.id, canApprove: true })]);
    expect((await as(carol, async () => use(dev).requests.GET(json('/api/environment/promotion-requests', 'GET')))).status).toBe(403);

    expect((await decide('approve', first.id, alice)).status).toBe(403);
    expect((await decide('approve', first.id, carol)).status).toBe(403);
    const approved = await decide('approve', first.id, bob, 'Looks right');
    expect(approved.status).toBe(200);
    expect(approved.body.result).toMatchObject({ promoted: true });
    expect(approved.body.request).toMatchObject({ status: 'approved', decidedBy: bob.id, decidedByName: 'Bob', comment: 'Looks right', commit: approved.body.result!.commit });
    expect(sh(['rev-parse', 'refs/heads/staging'], bare)).toBe(approved.body.result!.commit);
    const message = sh(['log', '-1', '--format=%B', 'refs/heads/staging'], bare);
    expect(message).toMatch(/^Add Italy/);
    expect(message).toContain('Promoted by Alice, approved by Bob');
    expect((JSON.parse(branchFile('data-tables/countries.rows.json')) as { rows: unknown[] }).rows).toHaveLength(3);
    expect((await decide('approve', first.id, bob)).status).toBe(409);

    const actions = m.audit.queryEvents({ action: ['promotion_request.*'] }).events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['promotion_request.create', 'promotion_request.approve']));
  });

  it('goes stale when what it would write changes before the approval', async () => {
    const m = use(dev);
    m.dataTables().insertRows(countries, [{ code: 'ES', rate: 21 }]);
    const asked = await promote({ target: 'staging' }, alice);
    expect(asked.status).toBe(202);
    // The rows change after the request: the approval would promote something nobody reviewed.
    m.dataTables().insertRows(countries, [{ code: 'PT', rate: 23 }]);
    const stale = await decide('approve', asked.body.request!.id, bob);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/out of date/);
    const listed = await as(bob, async () => read<{ requests: PromotionRequestView[] }>(await use(dev).requests.GET(json('/api/environment/promotion-requests?status=all', 'GET'))));
    expect(listed.body.requests.find((r) => r.id === asked.body.request!.id)).toMatchObject({ status: 'stale', reason: expect.stringMatching(/changed since it was previewed/) });
  });

  it('is replaced by a newer request, rejected by an approver or withdrawn by the requester', async () => {
    const one = (await promote({ target: 'staging' }, alice)).body.request!;
    const two = (await promote({ target: 'staging', message: 'Second try' }, alice)).body.request!;
    const all = await as(bob, async () => read<{ requests: PromotionRequestView[] }>(await use(dev).requests.GET(json('/api/environment/promotion-requests?status=all', 'GET'))));
    expect(all.body.requests.find((r) => r.id === one.id)).toMatchObject({ status: 'canceled', reason: 'Replaced by a newer request' });
    expect((await decide('reject', two.id, alice)).status).toBe(403);
    const rejected = await decide('reject', two.id, bob, 'Not today');
    expect(rejected.body.request).toMatchObject({ status: 'rejected', comment: 'Not today' });

    const three = (await promote({ target: 'staging' }, alice)).body.request!;
    const withdrawn = await decide('cancel', three.id, alice);
    expect(withdrawn.body.request).toMatchObject({ status: 'canceled', decidedBy: alice.id });
    expect((await decide('approve', three.id, bob)).status).toBe(409);

    // Four-eyes off: promotion is direct again.
    use(dev).governance.updateGovernancePolicy({ fourEyes: { enabled: false } });
    expect((await promote({ target: 'staging' }, alice)).body).toMatchObject({ promoted: true });
  });
});
