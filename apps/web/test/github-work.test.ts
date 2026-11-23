/**
 * GitHub into the brain (docs/features/integrations.md#github-into-the-brain): each supported delivery maps to the right
 * work kind with a stable sourceId, logins become emails only through the People table, no review text or long body
 * enters, the node drops what is not a work fact, and the template and kinds file agree with the mapper.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-github-work-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { githubToWork, parsePeople, GITHUB_WORK_KINDS } = await import('@/lib/server/brain/github-work');
const { githubWorkEventNode } = await import('@/lib/server/nodes/github-work');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates/builtin');
const { corePlugin } = await import('@/lib/server/nodes');

const dir = join(import.meta.dirname, 'fixtures', 'github');
const delivery = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { event: string; body: unknown; headers: Record<string, string> };
const map = (name: string, people = {}) => {
  const d = delivery(name);
  return githubToWork(d.event, d.body, people);
};

describe('githubToWork', () => {
  const cases: Array<[string, string, string]> = [
    ['opened', 'work.pr_opened', 'acme-demo/widgets#42:opened'],
    ['merged', 'work.pr_merged', 'acme-demo/widgets#42:merged'],
    ['closed', 'work.pr_closed', 'acme-demo/widgets#43:closed'],
    ['review-requested', 'work.review_requested', 'acme-demo/widgets#42:review_requested:octo-lead'],
    ['review-approved', 'work.pr_reviewed', 'acme-demo/widgets#42:reviewed:9001'],
    ['review-changes', 'work.pr_reviewed', 'acme-demo/widgets#42:reviewed:9002'],
    ['run-failed', 'work.ci_failed', 'acme-demo/widgets#42:ci_failed:7001:2'],
    ['run-succeeded', 'work.ci_passed', 'acme-demo/widgets#42:ci_passed:7002:1'],
    ['status-failed', 'work.ci_failed', 'acme-demo/widgets@abc1234:ci_failed:5001:1'],
  ];
  it.each(cases)('maps %s to %s', (name, kind, sourceId) => {
    const item = map(name);
    expect(item).toMatchObject({ kind, sourceId, source: 'github', repo: 'acme-demo/widgets' });
    expect(item!.occurredAt).toMatch(/^2026-11-1\d/);
    expect(map(name)!.sourceId).toBe(sourceId);
  });

  it('carries review state, waited time and CI facts', () => {
    expect(map('review-approved')).toMatchObject({ reviewState: 'approved', waitedMs: 4 * 3_600_000, prNumber: 42 });
    expect(map('review-changes')!.reviewState).toBe('changes_requested');
    expect(map('run-failed')!.ci).toEqual({ conclusion: 'failure', durationMs: 270_000, attempt: 2 });
    expect(map('merged')).toMatchObject({ state: 'merged', actor: 'octo-lead' });
  });

  it('ignores a push and anything that is not a work fact', () => {
    expect(map('push')).toBeNull();
    expect(githubToWork('pull_request', { action: 'labeled', pull_request: { number: 1 }, repository: { full_name: 'a/b' } })).toBeNull();
    expect(githubToWork('status', { state: 'pending', repository: { full_name: 'a/b' } })).toBeNull();
    expect(githubToWork('workflow_run', { action: 'completed', workflow_run: { conclusion: 'cancelled' }, repository: { full_name: 'a/b' } })).toBeNull();
    expect(githubToWork('issues', null)).toBeNull();
  });

  it('sets the actor email only through the People table', () => {
    expect(map('opened')).toMatchObject({ actor: 'octo-dev' });
    expect(map('opened')).not.toHaveProperty('actorEmail');
    expect(map('opened', parsePeople('{"Octo-Dev": "dev@example.com"}'))).toMatchObject({ actor: 'octo-dev', actorEmail: 'dev@example.com' });
    expect(parsePeople('not json')).toEqual({});
  });

  it('keeps no review text and clips the description to 300 redacted characters', () => {
    expect(JSON.stringify(map('review-approved'))).not.toContain('rename this variable');
    const opened = map('opened')!;
    expect(opened.summary!.length).toBeLessThanOrEqual(300);
    expect(opened.summary).not.toContain('dev@example.com');
    expect(JSON.stringify(map('push'))).not.toContain('secret code');
  });
});

describe('GitHub to Work Event node', () => {
  it('outputs one item per work delivery and drops the rest', async () => {
    const items = ['opened', 'push', 'review-approved'].map((name) => ({ json: delivery(name) as never }));
    const ctx = { getInputData: () => items, getNodeParameter: () => '{"octo-lead": "lead@example.com"}' };
    const [out] = (await githubWorkEventNode.execute!.call(ctx as never, ctx as never)) as Array<Array<{ json: Record<string, unknown>; pairedItem?: unknown }>>;
    expect(out.map((i) => i.json.kind)).toEqual(['work.pr_opened', 'work.pr_reviewed']);
    // Each output points back at the delivery it came from (the push in between is skipped, not renumbered).
    expect(out.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
    expect(out[1]!.json.actorEmail).toBe('lead@example.com');
  });

  it('reads the event from the delivery header when the item has no event field', async () => {
    const d = delivery('opened');
    const ctx = { getInputData: () => [{ json: { body: d.body, headers: d.headers } }], getNodeParameter: () => '{}' };
    const [out] = (await githubWorkEventNode.execute!.call(ctx as never, ctx as never)) as Array<unknown[]>;
    expect(out).toHaveLength(1);
  });
});

describe('the work-github template and kinds', () => {
  it('validates: known node types, the plugin named, the trigger first', () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'work-github')!;
    expect(t.name).toBe('Work from GitHub into the second brain');
    const core = new Set(corePlugin.nodes.map((n) => `core.${n.description.name}`));
    for (const type of t.nodeTypes) expect(type.startsWith('productivity.') || core.has(type), type).toBe(true);
    expect(t.nodeTypes).toContain('productivity.githubWebhookTrigger');
    expect(t.credentials.map((c) => c.id)).toEqual(['github']);
    expect(t.setup.join(' ')).toContain('productivity');
  });

  it('keeps a repository under the same system page id as recorded work (repoEntityId)', async () => {
    const { ExpressionResolver } = await import('@landflow/engine');
    const { repoEntityId } = await import('@/lib/server/brain/work');
    const t = BUILTIN_TEMPLATES.find((x) => x.id === 'work-github')!;
    const entityId = t.workflow.nodes.find((n) => n.id === 'repo')!.parameters.entityId;
    for (const repo of ['acme-demo/widgets', 'Acme/My_Repo.js', `org/${'x'.repeat(80)}`, 'a--b/c..d']) {
      const resolver = new ExpressionResolver({ items: [{ json: { repo } }], nodeOutputs: {}, workflow: { id: 'w', name: 'w' }, execution: { id: 'e', mode: 'manual' }, parameters: {} });
      expect(resolver.resolveValue(entityId, 0), repo).toBe(repoEntityId(repo));
    }
  });

  it('declares every kind the mapper emits, and the fields of the GitHub-only kinds', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '../../../deploy/brain/work-kinds.json'), 'utf8')) as { fields: Array<{ name: string }>; kinds: Array<{ kind: string; fields?: Array<{ name: string }> }> };
    const declared = new Map(file.kinds.map((k) => [k.kind, new Set((k.fields ?? file.fields).map((f) => f.name))]));
    for (const kind of GITHUB_WORK_KINDS) expect(declared.has(kind), kind).toBe(true);
    for (const name of readdirSync(dir).map((f) => f.replace('.json', ''))) {
      const item = map(name);
      if (!item || ['work.pr_opened', 'work.pr_merged'].includes(item.kind)) continue;
      for (const key of Object.keys(item)) {
        if (key === 'ci') for (const f of ['ciConclusion', 'ciDurationMs', 'ciAttempt']) expect(declared.get(item.kind)!.has(f), `${item.kind} ${f}`).toBe(true);
        else if (key !== 'actorEmail' && key !== 'kind') expect(declared.get(item.kind)!.has(key), `${item.kind} ${key}`).toBe(true);
      }
    }
    for (const fields of declared.values()) expect(fields.size).toBeLessThanOrEqual(20);
  });
});
