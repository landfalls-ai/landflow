/**
 * The practices join (constitution lesson 7, docs/practices.md): PR01's store reached through the real port that
 * practices/register sets, walked end to end by every side that otherwise tests with a fake port. A member drafts through an
 * API key (tainted), the member's approve is refused, the owner approves after reading the sources, the applicable route and
 * `practices_for` over MCP deliver it, a cite writes a `cited` row, and the Draft Practice node in an owner's flow drafts a
 * version whose citation is verified against the files it read. No fake port, no model, no network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { PracticeVersion, PracticeView } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The real registration, the way lib/server/runtime.ts loads it: nothing below sets a port of its own.
await import('@/lib/server/practices/register');
const { practicesPort } = await import('@/lib/server/practices/port');
const { storePort } = await import('@/lib/server/practices/register');
const { createUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { withAuth } = await import('@/lib/server/auth/context');
const { applicationsOf, versionsOf } = await import('@/lib/server/practices/store');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { items } = await import('./helpers');
const listRoute = await import('@/app/api/practices/route');
const approveRoute = await import('@/app/api/practices/[id]/approve/route');
const applicableRoute = await import('@/app/api/practices/applicable/route');
const citeRoute = await import('@/app/api/practices/cite/route');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@practices-join.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const member = await createUser({ email: 'member@practices-join.test', name: 'Member', role: 'member', password: 'member-password-1' });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type User = typeof owner;
const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://join.test${url}`, { method, headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const idOf = (id: string) => ({ params: Promise.resolve({ id }) });

const REPO = 'acme/widgets';
const FILE = { repo: REPO, sha: 'abc1234', path: 'deploy/helm/web/Chart.yaml', content: 'apiVersion: v2\nname: web\n' };
const CITATION = { repo: REPO, sha: FILE.sha, path: FILE.path, lines: [2, 2], excerpt: 'name: web' };

describe('the practices join', () => {
  it('runs on the store port that practices/register sets', () => {
    expect(practicesPort()).toBe(storePort);
  });

  it('draft by key → refused member approve → owner approve → applicable → practices_for → cite', async () => {
    // A member drafts through an API key: tainted, learned (it cites a repository), never verified from a request.
    enableTestAuth(member);
    const key = createApiKey(member, { label: 'join', scopes: ['brain:write'] }).token;
    const drafted = await listRoute.POST(
      req(
        'POST',
        '/api/practices',
        { handle: 'helm/chart-location', level: 'org', title: 'Charts live under deploy/helm', strength: 'required', topics: ['helm'], repos: [REPO], paths: ['deploy/helm/**'], summary: 'Charts live in deploy/helm/<service>/', body: 'One chart per service.', citations: [CITATION] },
        { authorization: `Bearer ${key}` },
      ),
    );
    expect(drafted.status).toBe(201);
    const { practice, version } = (await drafted.json()) as { practice: PracticeView; version: PracticeVersion };
    expect(version).toMatchObject({ version: 1, source: 'learned', tainted: true });
    expect(version.citations[0]).toMatchObject({ verified: false });
    expect(storePort.approved({ projectIds: 'all' }).map((p) => p.handle)).not.toContain('helm/chart-location');

    // The member may not approve it, even their own draft.
    const refused = await approveRoute.POST(req('POST', `/api/practices/${practice.id}/approve`, { version: 1, reviewedSources: true }), idOf(practice.id));
    expect(refused.status).toBe(403);

    // The owner approves only after saying they read it against its sources.
    enableTestAuth(owner);
    const unread = await approveRoute.POST(req('POST', `/api/practices/${practice.id}/approve`, { version: 1 }), idOf(practice.id));
    expect(unread.status).toBe(409);
    const approved = await approveRoute.POST(req('POST', `/api/practices/${practice.id}/approve`, { version: 1, reviewedSources: true }), idOf(practice.id));
    expect(approved.status).toBe(200);
    const sha = versionsOf(practice.id).find((v) => v.version === 1)!.sha256;
    expect(storePort.approved({ projectIds: [] })).toEqual([expect.objectContaining({ id: practice.id, handle: 'helm/chart-location', version: 1, sha256: sha })]);

    // The applicable route lists it for the repository, and not for another one.
    enableTestAuth(member);
    const applicable = (await (await applicableRoute.GET(req('GET', `/api/practices/applicable?repo=${REPO}&path=deploy/helm/web/values.yaml`))).json()) as { practices: Array<{ handle: string }>; text: string };
    expect(applicable.practices.map((p) => p.handle)).toEqual(['helm/chart-location']);
    expect(applicable.text).toContain('[helm/chart-location@1] required: Charts live in deploy/helm/<service>/');
    const elsewhere = (await (await applicableRoute.GET(req('GET', '/api/practices/applicable?repo=acme/other'))).json()) as { practices: unknown[] };
    expect(elsewhere.practices).toEqual([]);

    // practices_for over MCP, as the same member, returns it too.
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer({ id: member.id, role: member.role }).connect(serverSide);
    const client = new Client({ name: 'practices-join', version: '1.0.0' });
    await client.connect(clientSide);
    const result = (await client.callTool({ name: 'practices_for', arguments: { repo: REPO, path: 'deploy/helm/web/Chart.yaml', task: 'add a helm chart' } })) as { content: Array<{ text: string }> };
    const answer = JSON.parse(result.content[0]!.text) as { practices: Array<{ handle: string; version: number }>; text: string };
    expect(answer.practices).toEqual([expect.objectContaining({ handle: 'helm/chart-location', version: 1 })]);
    expect(answer.text).toContain('[helm/chart-location@1]');

    // A cite writes a `cited` row for the member.
    const cited = await citeRoute.POST(req('POST', '/api/practices/cite', { text: 'Done.\nPractices followed: [helm/chart-location@1], [nope/missing@2]', repo: REPO }));
    expect(cited.status).toBe(200);
    expect(await cited.json()).toEqual({ recorded: ['helm/chart-location@1'], unknown: ['nope/missing@2'] });
    const rows = applicationsOf(practice.id, 50).applications;
    expect(rows.filter((r) => r.kind === 'cited')).toEqual([expect.objectContaining({ kind: 'cited', version: 1, userId: member.id, repo: REPO })]);
    expect(rows.filter((r) => r.kind === 'delivered').length).toBeGreaterThanOrEqual(2);
  });

  it('the Draft Practice node in an owner’s flow drafts a version with a verified citation', async () => {
    const workflow = {
      id: 'wf_join_learn',
      name: 'Learn practices (join)',
      active: false,
      nodes: [
        { id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} },
        {
          id: 'draft',
          name: 'Draft',
          type: 'core.practiceDraft',
          typeVersion: 1,
          position: [260, 0] as [number, number],
          parameters: {
            handle: 'helm/values-files',
            title: 'Values files sit beside the chart',
            level: 'org',
            strength: 'recommended',
            topics: 'helm',
            repositories: REPO,
            paths: 'deploy/helm/**',
            summary: 'Keep values.yaml next to Chart.yaml.',
            body: 'One values.yaml per chart.',
            checks: '[]',
            citations: JSON.stringify([CITATION]),
            files: '{{ $json.files }}',
          },
        },
      ],
      connections: [{ id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'draft', targetIndex: 0 }],
    };
    const as = <T,>(user: User, fn: () => T): T => withAuth({ principal: { user, via: 'test' } }, fn);
    as(owner, () => store.saveWorkflow(workflow));
    const run = await as(owner, () => runWorkflow({ workflow: store.getWorkflow('wf_join_learn')!, mode: 'manual', startNodeId: 'start', triggerItems: items({ files: [FILE] }) }));
    expect(run.status).toBe('success');
    const out = run.runData.draft?.at(-1)?.outputs[0]?.[0]?.json as Record<string, unknown>;
    expect(out).toMatchObject({ handle: 'helm/values-files', version: 1, tainted: true, verified: 1, verification: 'checked' });
    const saved = versionsOf(String(out.practiceId));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source: 'learned', tainted: true });
    expect(saved[0]!.citations).toEqual([expect.objectContaining({ path: FILE.path, verified: true })]);
    // A draft reaches no agent until a person approves it.
    expect(storePort.approved({ projectIds: 'all' }).map((p) => p.handle)).not.toContain('helm/values-files');
  });
});
