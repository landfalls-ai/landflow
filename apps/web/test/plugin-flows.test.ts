/**
 * The flows the bundled plugins ship (`plugins/<name>/flows/*.json`, installed into Templates by the marketplace): each is
 * a template file that validates against the node registry (core nodes plus the bundled plugins as their processes
 * describe themselves), with every credential reference on a declared slot and every Data Table node on a declared
 * table, and the repo's marketplace lists them.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IPlugin } from '@landflow/sdk';
import type { TemplateFile } from '@/lib/shared/templates';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-plugin-flows-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const templates = await import('@/lib/server/templates');
const { fileSchema } = await import('@/lib/server/templates/schema');
const { normalizeWorkflow, validateWorkflow } = await import('@/lib/server/mcp/workflows');
const { workflowSchema } = await import('@/lib/server/schemas');
const { loadPlugin } = await import('@/lib/server/marketplace/plugin');
const { readerFor } = await import('@/lib/server/marketplace/reader');
const { runWorkflow } = await import('@/lib/server/runner');

const fixtures = join(import.meta.dirname, 'fixtures', 'plugin-manifests');
registry.registerBuiltin(corePlugin);
for (const file of readdirSync(fixtures)) {
  const manifest = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  registry.registerBuiltin({
    info: manifest.plugin,
    nodes: manifest.nodes.map((description: unknown) => ({ description, execute: async () => [[]] })),
    credentialTypes: manifest.credentialTypes,
    composites: manifest.composites,
  } as unknown as IPlugin);
}

const repo = join(import.meta.dirname, '..', '..', '..');
const flows = readdirSync(join(repo, 'plugins')).flatMap((plugin) => {
  const dir = join(repo, 'plugins', plugin, 'flows');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [`${plugin}/flows/${f}`, JSON.parse(readFileSync(join(dir, f), 'utf8')) as TemplateFile] as const) : [];
});
const qualified = (nodeType: string, key: string) => (key.includes('.') ? key : `${nodeType.split('.')[0]}.${key}`);

describe('plugin flows', () => {
  it('ship with the Landfall, triage, threat-intel, Linear, Attio, Fathom and Clickland plugins', () => {
    expect(flows.map(([path]) => path).sort()).toEqual([
      'attio/flows/work-attio.json',
      'clickland/flows/clickland-alert-triage.json',
      'clickland/flows/clickland-observability-assistant.json',
      'fathom/flows/work-fathom.json',
      'landfall/flows/landflow-failures-to-landfall.json',
      'landfall/flows/landflow-heartbeat.json',
      'landfall/flows/learn-from-closed-rooms.json',
      'linear/flows/work-linear.json',
      'threat-intel/flows/ioc-lookup.json',
      'triage/flows/alert-triage-to-landfall.json',
      'triage/flows/phishing-report-triage.json',
      'triage/flows/triage-digest.json',
    ]);
  });

  it.each(flows)('%s validates against the node registry', (path, file) => {
    expect(fileSchema.safeParse(file).success).toBe(true);
    const t = file.template;
    const workflow = { ...normalizeWorkflow(structuredClone(t.workflow)), id: 'wf_flow' };
    const result = validateWorkflow(workflow);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(workflowSchema.safeParse({ ...t.workflow, id: 'wf_flow' }).success).toBe(true);
    // Every reference points at a declared slot of the type the node asks for, and every slot is used.
    const refs = t.workflow.nodes.flatMap((n) => Object.entries(n.credentials ?? {}).map(([key, ref]) => ({ node: n, key, ...ref })));
    for (const ref of refs) {
      const slot = t.credentials.find((s) => s.id === ref.id);
      expect(slot, `${path}: ${ref.node.name} → ${ref.id}`).toBeDefined();
      expect(slot!.type).toBe(qualified(ref.node.type, ref.key));
      const resolved = registry.resolve(ref.node.type);
      expect('error' in resolved ? [] : (resolved.descriptor.credentials ?? []).map((c) => c.name)).toContain(ref.key);
      expect(registry.credentialType(slot!.type), slot!.type).toBeDefined();
    }
    for (const slot of t.credentials) expect(refs.some((r) => r.id === slot.id), `${path}: unused slot ${slot.id}`).toBe(true);
    expect(templates.slotCredentials(t.workflow, t.credentials).slots.map((s) => s.id)).toEqual(t.credentials.map((s) => s.id));
    for (const node of t.workflow.nodes.filter((n) => n.type === 'core.dataTable')) {
      expect(t.dataTables.map((d) => d.name), `${path}: ${node.name}`).toContain(node.parameters.dataTableId);
    }
    for (const group of t.workflow.groups ?? []) expect(group.nodeIds.every((id) => t.workflow.nodes.some((n) => n.id === id))).toBe(true);
    // The first node is a trigger, and the preview a share page shows is usable here.
    expect(registry.nodeTypes().find((n) => n.type === t.workflow.nodes[0].type)?.descriptor.kind).toBe('trigger');
    expect(templates.previewTemplate(file).problems).toEqual([]);
  });

  it('read as a local marketplace: each plugin’s node plugin and flows, nothing to warn about', async () => {
    process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL = '1';
    try {
      const manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: Array<{ name: string; source: string; flows?: string[] }> };
      for (const entry of manifest.plugins) {
        const loaded = await loadPlugin(readerFor({ kind: 'local', root: repo, path: entry.source.slice(2) }), entry);
        expect(loaded.warnings, entry.name).toEqual([]);
        expect(loaded.nodePlugin?.id, entry.name).toBe(entry.name);
        expect(loaded.flows.map((f) => `./${f.path}`).sort(), entry.name).toEqual([...(entry.flows ?? [])].sort());
      }
    } finally {
      delete process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL;
    }
  });

  it('are listed in the repo’s marketplace', () => {
    const manifest = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: Array<{ name: string; source: string; flows?: string[] }> };
    for (const [path] of flows) {
      const [plugin, ...rest] = path.split('/');
      const entry = manifest.plugins.find((p) => p.source === `./plugins/${plugin}`);
      expect(entry, plugin).toBeDefined();
      expect(entry!.flows, path).toContain(`./${rest.join('/')}`);
    }
  });
});

describe('Clickland alert triage', () => {
  // Clickland marks a delivery for an alert it routed straight to Landfall with `route: "direct"`: Landfall has opened
  // that room already, so the flow must stop before the triage agent and the Slack post.
  it('drops a delivery Clickland routed straight to Landfall, before the agent', async () => {
    const file = flows.find(([path]) => path === 'clickland/flows/clickland-alert-triage.json')![1];
    const workflow = { ...normalizeWorkflow(structuredClone(file.template.workflow)), id: 'wf_clickland_triage' };
    const trigger = workflow.nodes.find((n) => n.type === 'clickland.clicklandAlertTrigger')!;
    const first = workflow.connections.filter((c) => c.type === 'main' && c.source === trigger.id);
    expect(first).toHaveLength(1);
    const gate = workflow.nodes.find((n) => n.id === first[0].target)!;
    expect(gate.type).toBe('core.filter');
    expect(workflow.connections.find((c) => c.type === 'main' && c.source === gate.id)?.target).toBe('agent');

    const delivery = (route?: string) => ({
      json: { type: 'alert.firing', id: 'evt_1', alert: { id: 'al_1', name: 'Checkout errors' }, value: 12, ...(route && { route }) },
    });
    const record = await runWorkflow({
      workflow,
      mode: 'trigger',
      triggerOutput: { nodeId: trigger.id, items: [delivery('direct'), delivery(), delivery('flow')] },
      destinationNodeId: gate.id,
    });
    expect(record.status).toBe('success');
    const passed = record.runData[gate.id]?.at(-1)?.outputs[0] ?? [];
    expect(passed.map((item) => item.json.route ?? null)).toEqual([null, 'flow']);
  });
});
