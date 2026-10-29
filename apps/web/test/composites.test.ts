/**
 * Composites (docs/composites.md): the matchers, the contract checks against the shipped AI triage frame (clean, then
 * broken one way at a time), binding, inserting a type's starter, proposing a type from a plain group, the saved shape
 * (normalisation prunes bindings to nodes that are gone) and the scopes the runner hands the executor.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompositeTypeDescriptor, NodeDescriptor } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-composites-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { workflowSchema } = await import('@/lib/server/schemas');
const { normalizeGroups } = await import('@/lib/shared/groups');
const c = await import('@/lib/shared/composites');

// Node descriptors as the registry would hold them: core plus the bundled plugins' fixtures.
const descriptors = new Map<string, NodeDescriptor>();
for (const node of corePlugin.nodes) descriptors.set(`core.${node.description.name}`, node.description);
const fixtures = join(import.meta.dirname, 'fixtures', 'plugin-manifests');
const composites: Array<{ type: string; descriptor: CompositeTypeDescriptor }> = [];
for (const file of readdirSync(fixtures)) {
  const manifest = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  for (const node of manifest.nodes) descriptors.set(`${manifest.plugin.id}.${node.name}`, node);
  for (const composite of manifest.composites ?? []) composites.push({ type: `${manifest.plugin.id}.${composite.name}`, descriptor: composite });
}
const lookup = c.compositeLookup(descriptors, composites);
const aiTriage = lookup.composite('triage.aiTriage')!;

const repo = join(import.meta.dirname, '..', '..', '..');
const triageFlow = (): Workflow => {
  const file = JSON.parse(readFileSync(join(repo, 'plugins/triage/flows/alert-triage-to-landfall.json'), 'utf8'));
  return { id: 'wf_triage', name: 'Triage', ...file.template.workflow };
};
const frame = (wf: Workflow) => wf.groups!.find((g) => g.composite)!;
const report = (wf: Workflow) => c.compositeReports(wf, lookup).find((r) => r.groupId === frame(wf).id)!;

describe('matchers', () => {
  const chain = descriptors.get('core.chainLlm')!;
  const model = descriptors.get('core.anthropicChatModel')!;

  it('AND the fields given and take one of anyOf', () => {
    expect(c.nodeMatches('core.chainLlm', chain, { kind: 'action', category: 'AI', input: 'ai_languageModel' })).toBe(true);
    expect(c.nodeMatches('core.anthropicChatModel', model, { kind: 'action', category: 'AI', input: 'ai_languageModel' })).toBe(false);
    expect(c.nodeMatches('core.anthropicChatModel', model, { supplies: 'ai_languageModel' })).toBe(true);
    expect(c.nodeMatches('core.set', descriptors.get('core.set'), { anyOf: [{ type: 'core.set' }, { supplies: 'ai_tool' }] })).toBe(true);
    expect(c.nodeMatches('core.set', descriptors.get('core.set'), { type: 'core.set', category: 'AI' })).toBe(false);
  });

  it('read capabilities, and judge only `type` when the plugin is offline', () => {
    expect(c.nodeMatches('threat-intel.iocEnrich', descriptors.get('threat-intel.iocEnrich'), { capability: ['ioc.enrich', 'ioc.lookup'] })).toBe(true);
    expect(c.nodeMatches('threat-intel.iocEnrich', undefined, { capability: 'ioc.enrich' })).toBe(false);
    expect(c.nodeMatches('triage.triageDecision', undefined, { type: 'triage.triageDecision' })).toBe(true);
  });

  it('keep nodes and nested composites apart', () => {
    expect(c.nodeMatches('core.set', descriptors.get('core.set'), { composite: 'triage.aiTriage' })).toBe(false);
    expect(c.compositeMatches('triage.aiTriage', { composite: ['triage.aiTriage', 'local.x'] })).toBe(true);
    expect(c.compositeMatches('triage.aiTriage', { type: 'core.set' })).toBe(false);
    expect(c.takesCompositeOnly({ composite: 'triage.aiTriage' })).toBe(true);
    expect(c.takesCompositeOnly({ anyOf: [{ composite: 'a.b' }, { type: 'core.set' }] })).toBe(false);
  });

  it('read as a few words', () => {
    expect(c.describeMatcher({ supplies: 'ai_languageModel' })).toBe('a chat model');
    expect(c.describeMatcher({ type: 'triage.triageDecision' }, lookup)).toBe('Triage Decision');
    expect(c.describeMatcher({ capability: ['ioc.enrich', 'ioc.lookup'] })).toBe('a node that can ioc.enrich or ioc.lookup');
    expect(c.describeMatcher({})).toBe('any node');
  });
});

describe('checks', () => {
  it('pass on the shipped AI triage frame', () => {
    const r = report(triageFlow());
    expect(r.descriptor?.name).toBe('aiTriage');
    expect(r.issues).toEqual([]);
    expect(r.slots.map((s) => [s.name, s.filled, s.ok])).toEqual([
      ['extract', ['iocs'], true],
      ['enrich', ['enrich'], true],
      ['reasoner', ['verdict'], true],
      ['model', ['model'], true],
      ['decision', ['decide'], true],
    ]);
    expect(r.free).toEqual(['join']);
    expect(r.outputs.map((p) => [p.name, p.nodeId, p.index, p.wired])).toEqual([
      ['open', 'decide', 0, true],
      ['attach', 'decide', 1, true],
      ['ask', 'decide', 2, true],
    ]);
    expect(r.rules.every((rule) => rule.ok)).toBe(true);
  });

  it('pass on the phishing flow too', () => {
    const file = JSON.parse(readFileSync(join(repo, 'plugins/triage/flows/phishing-report-triage.json'), 'utf8'));
    const issues = c.compositeIssues({ id: 'wf', name: 'Phishing', ...file.template.workflow }, lookup);
    expect(issues).toEqual([]);
  });

  it('find an empty required slot when the model goes', () => {
    const wf = triageFlow();
    wf.nodes = wf.nodes.filter((n) => n.id !== 'model');
    wf.connections = wf.connections.filter((x) => x.source !== 'model');
    wf.groups = normalizeGroups(wf.groups, wf.nodes.map((n) => n.id));
    const issues = report(wf).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'slot-empty', slot: 'model', message: 'AI model is empty: add a chat model' });
  });

  it('want the reasoner to continue on error, with the fix', () => {
    const wf = triageFlow();
    wf.nodes = wf.nodes.map((n) => (n.id === 'verdict' ? { ...n, onError: 'stop' } : n));
    const [issue] = report(wf).issues;
    expect(issue).toMatchObject({ severity: 'error', code: 'on-error', nodeId: 'verdict', fix: { kind: 'onError', nodeId: 'verdict', value: 'continue' } });
    expect(report(wf).rules.find((r) => r.rule === 'onError')).toMatchObject({ ok: false, label: 'Enrichment and Reasoner continue on error' });
  });

  it('want the model connected to the reasoner', () => {
    const wf = triageFlow();
    wf.connections = wf.connections.filter((x) => x.type !== 'ai_languageModel');
    expect(report(wf).issues.map((i) => i.code)).toEqual(['feeds']);
  });

  it('warn (not block) on a connection leaving the frame past its outputs', () => {
    const wf = triageFlow();
    wf.connections.push({ id: 'leak', type: 'main', source: 'verdict', sourceIndex: 0, target: 'record', targetIndex: 0 });
    const issues = report(wf).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'sealed', nodeId: 'verdict' });
  });

  it('find a path that skips the decision', () => {
    const wf = triageFlow();
    wf.connections = wf.connections.filter((x) => !(x.source === 'join' && x.target === 'decide'));
    expect(report(wf).issues.map((i) => i.code)).toContain('reaches');
  });

  it('reject a node in the wrong slot, a second decision, and free nodes in a closed type', () => {
    const wf = triageFlow();
    const g = frame(wf);
    g.composite = c.bindSlot(g.composite!, 'decision', 'join');
    const codes = report(wf).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['slot-full', 'slot-mismatch']));
    const mismatch = report(wf).issues.find((i) => i.code === 'slot-mismatch')!;
    expect(mismatch.fix).toEqual({ kind: 'unbind', slot: 'decision', id: 'join' });

    const closed = c.compositeLookup(descriptors, [{ type: 'triage.aiTriage', descriptor: { ...aiTriage, closed: true } }]);
    expect(c.compositeIssues(triageFlow(), closed).map((i) => [i.code, i.nodeId])).toEqual([['closed', 'join']]);
  });

  it('warn when the type is unknown or the pinned version is gone', () => {
    expect(c.compositeIssues(triageFlow(), c.compositeLookup(descriptors, []))).toMatchObject([{ severity: 'warning', code: 'unknown-type' }]);
    const wf = triageFlow();
    frame(wf).composite!.version = 9;
    expect(report(wf).issues).toMatchObject([{ severity: 'warning', code: 'version', fix: { kind: 'upgrade', version: 1 } }]);
    const v2 = c.compositeLookup(descriptors, [{ type: 'triage.aiTriage', descriptor: { ...aiTriage, version: 2 }, all: [{ ...aiTriage, version: 2 }, aiTriage] }]);
    expect(c.compositeReports(triageFlow(), v2)[0]).toMatchObject({ version: 1, latestVersion: 2, issues: [] });
  });
});

describe('binding', () => {
  it('auto-binds a node that obviously fills a slot', () => {
    const wf = triageFlow();
    const g = frame(wf);
    g.composite = c.unbindSlot(g.composite!, 'model');
    expect(c.slotOf(g.composite, 'model')).toBeUndefined();
    expect(c.slotOf(c.autoBind(wf, g.id, 'model', lookup), 'model')).toBe('model');
    // A merge fits no slot: left free.
    expect(c.autoBind(wf, g.id, 'join', lookup)).toBeUndefined();
  });

  it('lists the slots that would take a node, unfilled required first', () => {
    const wf = triageFlow();
    const g = frame(wf);
    g.composite = c.unbindSlot(g.composite!, 'model');
    const r = report(wf);
    expect(c.slotsFor(r, 'core.anthropicChatModel', descriptors.get('core.anthropicChatModel')).map((s) => s.name)).toEqual(['model']);
    expect(c.slotsFor(r, 'core.anthropicChatModel', descriptors.get('core.anthropicChatModel'))[0].filled).toEqual([]);
  });

  it('knows which composite a node is in', () => {
    const wf = triageFlow();
    expect(c.compositeOfNode(wf, 'verdict')?.id).toBe(frame(wf).id);
    expect(c.compositeOfNode(wf, 'hook')).toBeUndefined();
  });

  it('prunes bindings to nodes that left', () => {
    const pruned = c.pruneComposite({ type: 't.x', version: 1, slots: { a: ['n1', 'gone'], b: ['gone'] }, fallback: [{ target: 'gone' }, { target: 'n2' }] }, ['n1'], ['n1', 'n2']);
    expect(pruned).toEqual({ type: 't.x', version: 1, slots: { a: ['n1'] }, fallback: [{ target: 'n2' }] });
  });
});

describe('inserting and proposing', () => {
  it('instantiates the starter with fresh ids, unique names and its slots bound', () => {
    let n = 0;
    const made = c.instantiateComposite('triage.aiTriage', aiTriage, { x: 1000, y: 500 }, { takenNames: ['AI verdict', 'Extract IOCs'], newId: () => `id${++n}`, groupId: 'group_9' });
    expect(made.nodes.map((x) => x.type)).toEqual(['triage.extractIocs', 'core.chainLlm', 'core.anthropicChatModel', 'core.merge', 'triage.triageDecision']);
    expect(new Set(made.nodes.map((x) => x.name)).size).toBe(5);
    expect(made.nodes.find((x) => x.type === 'triage.extractIocs')!.name).toBe('Extract IOCs 2');
    expect(made.nodes.find((x) => x.type === 'core.chainLlm')!.onError).toBe('continue');
    expect(made.nodes[0].position).toEqual([1080, 600]);
    expect(made.connections).toHaveLength(5);
    expect(made.group.composite).toMatchObject({ type: 'triage.aiTriage', version: 1 });
    const wf: Workflow = { id: 'wf', name: 'New', nodes: made.nodes, connections: made.connections, groups: [made.group] };
    // No enrichment (optional) and no wiring out yet: the starter checks clean.
    expect(c.compositeIssues(wf, lookup)).toEqual([]);
  });

  it('gives an empty frame for a type without a starter', () => {
    const made = c.instantiateComposite('t.bare', { ...aiTriage, starter: undefined }, { x: 0, y: 0 }, { takenNames: [], newId: () => 'x', groupId: 'g' });
    expect(made.nodes).toEqual([]);
    expect(made.group).toMatchObject({ nodeIds: [], width: 520, height: 300 });
  });

  it('proposes a type from a plain group that the group then passes', () => {
    const wf = triageFlow();
    const g = frame(wf);
    delete g.composite;
    const proposed = c.proposeComposite(wf, g.id, lookup)!;
    const d = proposed.descriptor;
    expect(d.name).toBe('aiTriageFailOpen');
    expect(d.slots.map((s) => s.name)).toEqual(['extractIocs', 'iocEnrich', 'basicLlmChain', 'anthropicChatModel', 'merge', 'triageDecision']);
    expect(d.slots.find((s) => s.name === 'anthropicChatModel')!.accepts).toEqual({ supplies: 'ai_languageModel' });
    expect(d.outputs?.map((p) => [p.slot, p.index])).toEqual([
      ['triageDecision', 0],
      ['triageDecision', 1],
      ['triageDecision', 2],
    ]);
    expect(d.rules).toEqual([
      { rule: 'feeds', from: 'anthropicChatModel', to: 'basicLlmChain', via: 'ai_languageModel' },
      { rule: 'onError', slots: ['iocEnrich', 'basicLlmChain'], value: 'continue' },
    ]);
    expect(d.starter?.nodes).toHaveLength(6);
    const typed = { ...g, composite: { type: 'local.aiTriageFailOpen', version: 1, slots: proposed.slots } };
    const own = c.compositeLookup(descriptors, [{ type: 'local.aiTriageFailOpen', descriptor: d }]);
    expect(c.compositeIssues({ ...wf, groups: wf.groups!.map((x) => (x.id === g.id ? typed : x)) }, own)).toEqual([]);
  });

  it('makes identifiers from labels', () => {
    expect(c.identifierFrom('AI triage (fail-open)')).toBe('aiTriageFailOpen');
    expect(c.identifierFrom('3 step')).toBe('composite3Step');
  });
});

describe('saved shape', () => {
  it('validates and keeps the composite through normalisation', () => {
    const wf = triageFlow();
    expect(workflowSchema.safeParse(wf).success).toBe(true);
    const groups = normalizeGroups(wf.groups, wf.nodes.map((n) => n.id));
    expect(groups.find((g) => g.composite)?.composite?.slots.reasoner).toEqual(['verdict']);
  });

  it('drops bindings to nodes that are gone and a composite without a type', () => {
    const groups = normalizeGroups(
      [
        { id: 'g1', name: 'A', nodeIds: ['a'], position: [0, 0], width: 400, height: 300, composite: { type: 't.x', version: 1, slots: { s: ['a', 'zz'], t: ['zz'] }, fallback: [{ target: 'zz' }] } },
        { id: 'g2', name: 'B', nodeIds: ['b'], position: [0, 0], width: 400, height: 300, composite: { type: '', version: 1, slots: {} } },
      ],
      ['a', 'b'],
    );
    expect(groups[0].composite).toEqual({ type: 't.x', version: 1, slots: { s: ['a'] } });
    expect(groups[1].composite).toBeUndefined();
  });
});

describe('scopes', () => {
  it('come only from types that ask for frame-wide handling', () => {
    expect(c.compositeScopes(triageFlow(), lookup)).toEqual([]);
    const fallback = c.compositeLookup(descriptors, [{ type: 'triage.aiTriage', descriptor: { ...aiTriage, onError: 'fallback', timeoutSeconds: 30, properties: [{ name: 'tone', displayName: 'Tone', type: 'string', default: 'calm' }] } }]);
    const wf = triageFlow();
    frame(wf).composite!.fallback = [{ target: 'record' }];
    const [scope] = c.compositeScopes(wf, fallback);
    expect(scope).toMatchObject({ id: frame(wf).id, type: 'triage.aiTriage', onError: 'fallback', fallback: [{ target: 'record', targetIndex: 0 }], timeoutSeconds: 30, params: { tone: 'calm' } });
    expect(scope.nodeIds.sort()).toEqual(['decide', 'enrich', 'iocs', 'join', 'model', 'verdict']);
  });
});
