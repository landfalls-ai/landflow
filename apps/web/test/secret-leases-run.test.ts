/**
 * Leased dynamic secrets through whole runs (C30) against the fake Vault that issues leases: a flow whose nodes use one
 * credential that references `database/creds/report-reader` gets one user for the run (AS-1), the user is removed when
 * the run ends however it ends (AS-2, AS-3, cancel) and not while it waits, two runs get two users (AS-5), the password
 * is nowhere in what the run keeps (AS-7), and a run that never reaches the node issues nothing (AS-9).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, defineNode, definePlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-leases-run-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_SECRETS_CACHE_TTL: '60' });
delete process.env.LANDFLOW_ENVIRONMENT;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { ensureExecutionReactions } = await import('@/lib/server/execution-reactions');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { runWorkflow, cancelExecution } = await import('@/lib/server/runner');
const { resumeExecution } = await import('@/lib/server/runner/resume');
const { cancelWaitingExecution } = await import('@/lib/server/runner/stop');
const secrets = await import('@/lib/server/secrets');

const bao = fakeVaultLeases();
const PATH = 'database/creds/report-reader';

/** What each node of the test plugin saw: its name and the user it was handed. */
const seen: Array<{ node: string; user: string }> = [];
const gate = { closed: false, release: undefined as (() => void) | undefined, reached: undefined as (() => void) | undefined };

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'leasetest', name: 'Lease test nodes', version: '0.0.1', description: 'Test nodes' },
    credentialTypes: [
      defineCredentialType({
        name: 'leaseDb',
        displayName: 'Lease DB',
        properties: [
          { name: 'user', displayName: 'User', type: 'string' },
          { name: 'password', displayName: 'Password', type: 'string', typeOptions: { password: true } },
        ],
      }),
    ],
    nodes: [
      defineNode({
        description: { name: 'whoami', displayName: 'Who am I', description: 'Reads its credential', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], credentials: [{ name: 'leaseDb', required: true }], properties: [] },
        async execute(c) {
          const data = c.getCredentials<{ user: string; password: string }>('leaseDb');
          seen.push({ node: c.getNode().name, user: data.user });
          c.logger.info(`connected with ${data.password}`);
          if (gate.closed) {
            gate.reached?.();
            await new Promise<void>((resolve) => (gate.release = resolve));
          }
          return [[{ json: { user: data.user, password: data.password } }]];
        },
      }),
      defineNode({
        description: { name: 'boom', displayName: 'Boom', description: 'Fails', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
        execute() {
          throw new Error('boom');
        },
      }),
    ],
  }),
);

let credentialId = '';
beforeAll(async () => {
  await ensureBootstrapped();
  ensureExecutionReactions();
  await bao.start();
  secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/' } });
  credentialId = credentials.create({
    name: 'Report DB',
    type: 'leasetest.leaseDb',
    data: { user: `{{ $secrets.bao['${PATH}'].username }}`, password: `{{ $secrets.bao['${PATH}'].password }}` },
  }).id;
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  await bao.stop();
});

type TestNode = { id: string; name: string; type: string; typeVersion: number; position: [number, number]; parameters: Record<string, unknown>; credentials?: Record<string, unknown> };
const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<TestNode> = {}): TestNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const whoami = (id: string) => node(id, 'leasetest.whoami', {}, { credentials: { leaseDb: { id: credentialId, name: 'Report DB' } } });
const chain = (id: string, nodes: TestNode[]): Workflow =>
  store.saveWorkflow({
    id,
    name: id,
    nodes: [node('Start', 'core.manualTrigger'), ...nodes],
    connections: nodes.map((n, i) => ({ id: `e${i}`, type: 'main' as const, source: i ? nodes[i - 1].id : 'Start', sourceIndex: 0, target: n.id, targetIndex: 0 })),
  } as Workflow);

const leaseOf = (executionId: string) => database().get<Record<string, string | null>>('SELECT * FROM secret_leases WHERE execution_id = ?', executionId);
/** The lease ends in the reaction to the run's end, not inside the run: wait for it. */
const revoked = (executionId: string) => vi.waitFor(() => expect(leaseOf(executionId)?.state).toBe('revoked'), { timeout: 10_000, interval: 25 });
const storedRows = (executionId: string) =>
  JSON.stringify([
    database().all('SELECT * FROM executions WHERE id = ?', executionId),
    database().all('SELECT * FROM execution_steps WHERE execution_id = ?', executionId),
    database().all('SELECT * FROM execution_checkpoints WHERE execution_id = ?', executionId),
  ]);

describe('a run that uses a dynamic credential', () => {
  it('issues one lease for two nodes, both connect as the same user (AS-1), and the user is removed when the run ends (AS-2)', async () => {
    bao.reset();
    seen.length = 0;
    const execution = await runWorkflow({ workflow: chain('wf_lease_two', [whoami('First'), whoami('Second')]), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('success');
    expect(bao.state().issued).toHaveLength(1);
    const issued = bao.state().issued[0];
    expect(seen.map((s) => s.user)).toEqual([issued.username, issued.username]);
    await revoked(execution.executionId);
    expect(bao.state().active).toEqual({});
    expect(bao.state().revoked).toEqual([issued.leaseId]);
    expect(leaseOf(execution.executionId)).toMatchObject({ state: 'revoked', lease_id: null, lease_values: null, ended_by: 'finish', workflow_id: 'wf_lease_two' });
  });

  it('removes the user when the run fails at the second node too (AS-3)', async () => {
    bao.reset();
    const execution = await runWorkflow({ workflow: chain('wf_lease_fail', [whoami('First'), node('Boom', 'leasetest.boom')]), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    await revoked(execution.executionId);
    expect(bao.state().active).toEqual({});
  });

  it('issues nothing when the run fails before it reaches the node (AS-9)', async () => {
    bao.reset();
    const execution = await runWorkflow({ workflow: chain('wf_lease_before', [node('Boom', 'leasetest.boom'), whoami('Never')]), mode: 'manual', startNodeId: 'Start' });
    expect(execution.status).toBe('error');
    expect(bao.state().issued).toHaveLength(0);
    expect(leaseOf(execution.executionId)).toBeUndefined();
  });

  it('gives two runs at the same time two users (AS-5)', async () => {
    bao.reset();
    seen.length = 0;
    const workflow = chain('wf_lease_pair', [whoami('Only')]);
    const [a, b] = await Promise.all([runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' }), runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' })]);
    expect([a.status, b.status]).toEqual(['success', 'success']);
    expect(bao.state().issued).toHaveLength(2);
    expect(new Set(seen.map((s) => s.user)).size).toBe(2);
    await revoked(a.executionId);
    await revoked(b.executionId);
    expect(bao.state().active).toEqual({});
  });

  it('keeps the password out of everything the run keeps and logs (AS-7)', async () => {
    bao.reset();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    let execution;
    try {
      execution = await runWorkflow({ workflow: chain('wf_lease_redact', [whoami('Only')]), mode: 'manual', startNodeId: 'Start' });
    } finally {
      spy.mockRestore();
    }
    const { password, username, leaseId } = bao.state().issued[0];
    expect(execution.status).toBe('success');
    const output = execution.runData.Only[0].outputs?.[0]?.[0]?.json as { user: string; password: string };
    expect(output.password).toBe(secrets.REDACTED);
    for (const text of [storedRows(execution.executionId), JSON.stringify(store.getExecution(execution.executionId)), JSON.stringify(execution), lines.join('')]) {
      expect(text).not.toContain(password);
      expect(text).not.toContain(username);
      expect(text).not.toContain(leaseId);
    }
    await revoked(execution.executionId);
  });

  it('keeps the lease while the run waits, uses the same user after it, and removes it at the end', async () => {
    bao.reset();
    seen.length = 0;
    const wait = node('Wait', 'core.wait', { resume: 'timeInterval', amount: 1, unit: 'hours' }, { typeVersion: 2 });
    const waiting = await runWorkflow({ workflow: chain('wf_lease_wait', [whoami('Before'), wait, whoami('After')]), mode: 'manual', startNodeId: 'Start' });
    expect(waiting.status).toBe('waiting');
    expect(leaseOf(waiting.executionId)?.state).toBe('active');
    expect(bao.state().revoked).toEqual([]);
    const resumed = await resumeExecution(waiting.executionId, { kind: 'time' });
    expect(resumed.status).toBe('success');
    expect(new Set(seen.map((s) => s.user)).size).toBe(1);
    expect(seen).toHaveLength(2);
    expect(bao.state().issued).toHaveLength(1);
    await revoked(waiting.executionId);
    expect(bao.state().active).toEqual({});
  });

  it('removes the lease of a run that is cancelled while it waits', async () => {
    bao.reset();
    const wait = node('Wait', 'core.wait', { resume: 'timeInterval', amount: 1, unit: 'hours' }, { typeVersion: 2 });
    const waiting = await runWorkflow({ workflow: chain('wf_lease_wait_cancel', [whoami('Before'), wait]), mode: 'manual', startNodeId: 'Start' });
    expect(waiting.status).toBe('waiting');
    expect(cancelWaitingExecution(waiting.executionId)).toBe(true);
    await revoked(waiting.executionId);
    expect(bao.state().active).toEqual({});
    expect(store.getExecution(waiting.executionId)?.status).toBe('canceled');
  });

  it('removes the lease of a run that is cancelled while a node holds it', async () => {
    bao.reset();
    gate.closed = true;
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    const running = runWorkflow({ workflow: chain('wf_lease_cancel', [whoami('Held'), node('Next', 'core.noOp')]), mode: 'manual', startNodeId: 'Start' });
    await reached;
    const executionId = database().get<{ id: string }>("SELECT id FROM executions WHERE workflow_id = 'wf_lease_cancel' ORDER BY started_at DESC")!.id;
    expect(leaseOf(executionId)?.state).toBe('active');
    cancelExecution(executionId);
    gate.closed = false;
    gate.release?.();
    const execution = await running;
    expect(execution.status).toBe('canceled');
    await revoked(executionId);
    expect(bao.state().active).toEqual({});
  });

  it('fails the node, naming the path, when the store will not issue', async () => {
    bao.reset();
    const credential = credentials.create({ name: 'Missing role', type: 'leasetest.leaseDb', data: { user: "{{ $secrets.bao['database/creds/missing'].username }}", password: 'x' } });
    const execution = await runWorkflow({
      workflow: chain('wf_lease_refused', [node('Only', 'leasetest.whoami', {}, { credentials: { leaseDb: { id: credential.id, name: 'Missing role' } } })]),
      mode: 'manual',
      startNodeId: 'Start',
    });
    expect(execution.status).toBe('error');
    expect(JSON.stringify(execution)).toMatch(/bao\['database\/creds\/missing'\]/);
    expect(leaseOf(execution.executionId)).toBeUndefined();
  });
});
