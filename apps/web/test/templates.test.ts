/**
 * The templates library: every built-in template validates against the node registry (core nodes plus the bundled
 * plugins, from recorded manifests in fixtures/plugin-manifests), search and categories, using a template (credential
 * slots remapped and checked, data tables created, URL paths made unique), "Save as template" leaving credentials,
 * pinned data and instance details out, export and import, delete, templates with missing or blocked nodes, remote
 * templates from an n8n-compatible API (a local server answering with recorded fixtures, never the network), and the
 * /api/templates routes.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IPlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';
import type { TemplateDetail, TemplateFile, TemplateSummary } from '@/lib/shared/templates';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-templates-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_TEMPLATES_URL;

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const templates = await import('@/lib/server/templates');
const { clearRemoteCache } = await import('@/lib/server/templates/remote');
const { normalizeWorkflow, validateWorkflow } = await import('@/lib/server/mcp/workflows');
const { credentials } = await import('@/lib/server/credentials/vault');
const { dataTables } = await import('@/lib/server/datatables/service');
const { folders } = await import('@/lib/server/folders');
const { store } = await import('@/lib/server/store');
const { updateGovernancePolicy } = await import('@/lib/server/governance/policy');
const { workflowSchema } = await import('@/lib/server/schemas');
const listRoute = await import('@/app/api/templates/route');
const itemRoute = await import('@/app/api/templates/[id]/route');
const useRoute = await import('@/app/api/templates/[id]/use/route');

// The bundled plugins as their running processes describe themselves; nodes that never run here.
const fixtures = join(import.meta.dirname, 'fixtures', 'plugin-manifests');
registry.registerBuiltin(corePlugin);
for (const file of readdirSync(fixtures)) {
  const manifest = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  registry.registerBuiltin({
    info: manifest.plugin,
    nodes: manifest.nodes.map((description: unknown) => ({ description, execute: async () => [[]] })),
    credentialTypes: manifest.credentialTypes,
  } as unknown as IPlugin);
}

const { BUILTIN_TEMPLATES, TemplateError } = templates;
const qualified = (nodeType: string, key: string) => (key.includes('.') ? key : `${nodeType.split('.')[0]}.${key}`);
const refs = (workflow: Pick<Workflow, 'nodes'>) => workflow.nodes.flatMap((n) => Object.entries(n.credentials ?? {}).map(([key, ref]) => ({ node: n, key, ...ref })));

async function rejects(promise: Promise<unknown> | (() => unknown), status: number): Promise<InstanceType<typeof TemplateError>> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (caught) {
    expect(caught).toBeInstanceOf(TemplateError);
    expect((caught as InstanceType<typeof TemplateError>).status).toBe(status);
    return caught as InstanceType<typeof TemplateError>;
  }
  throw new Error('expected a TemplateError');
}

describe('built-in templates', () => {
  it('ships at least 15, with unique ids, categories, setup steps and a broad mix of nodes', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(BUILTIN_TEMPLATES.length);
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.description.length, t.id).toBeGreaterThan(40);
      expect(t.categories.length, t.id).toBeGreaterThan(0);
      expect(t.setup.length, t.id).toBeGreaterThan(0);
    }
    const types = new Set(BUILTIN_TEMPLATES.flatMap((t) => t.workflow.nodes.map((n) => n.type)));
    for (const type of [
      'core.aiAgent',
      'core.ollamaChatModel',
      'core.openAiChatModel',
      'core.anthropicChatModel',
      'core.vectorStoreSqlite',
      'core.webhook',
      'core.respondToWebhook',
      'core.schedule',
      'core.formTrigger',
      'core.dataTable',
      'core.errorTrigger',
      'messaging.slack',
      'messaging.telegram',
      'google.gmail',
      'productivity.github',
    ]) {
      expect(types, type).toContain(type);
    }
    // Some templates show canvas groups and notes.
    expect(BUILTIN_TEMPLATES.some((t) => t.workflow.groups?.length)).toBe(true);
    expect(BUILTIN_TEMPLATES.some((t) => t.workflow.stickyNotes?.length)).toBe(true);
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))('%s validates against the node registry', (_id, t) => {
    const workflow = { ...normalizeWorkflow(structuredClone(t.workflow)), id: 'wf_template' };
    const result = validateWorkflow(workflow);
    expect(result.errors).toEqual([]);
    // No unknown parameters, nothing loose, no missing required values or sub-nodes.
    expect(result.warnings).toEqual([]);
    expect(workflowSchema.safeParse({ ...t.workflow, id: 'wf_template' }).success).toBe(true);
    // Every reference points at a declared slot of the right type, for a credential the node asks for.
    for (const ref of refs(t.workflow)) {
      const slot = t.credentials.find((s) => s.id === ref.id);
      expect(slot, `${t.id}: ${ref.node.name} → ${ref.id}`).toBeDefined();
      expect(slot!.type).toBe(qualified(ref.node.type, ref.key));
      const resolved = registry.resolve(ref.node.type);
      expect('error' in resolved ? [] : (resolved.descriptor.credentials ?? []).map((c) => c.name)).toContain(ref.key);
      expect(registry.credentialType(slot!.type), slot!.type).toBeDefined();
    }
    for (const slot of t.credentials) expect(refs(t.workflow).some((r) => r.id === slot.id), `${t.id}: unused slot ${slot.id}`).toBe(true);
    // Every credential a node requires (for its parameters) already points at a slot: slotting adds nothing.
    expect(templates.slotCredentials(t.workflow, t.credentials).slots).toEqual(t.credentials);
    // Data Table nodes name a table the template declares.
    for (const node of t.workflow.nodes.filter((n) => n.type === 'core.dataTable')) {
      expect(t.dataTables.map((d) => d.name), `${t.id}: ${node.name}`).toContain(node.parameters.dataTableId);
    }
    // Groups hold nodes of the template.
    for (const group of t.workflow.groups ?? []) expect(group.nodeIds.every((id) => t.workflow.nodes.some((n) => n.id === id))).toBe(true);
  });

  it('are all usable here, with node types triggers first and slots naming their nodes', async () => {
    for (const t of BUILTIN_TEMPLATES) {
      const detail = (await templates.getTemplate(t.id))!;
      expect(detail.usable, `${t.id}: ${JSON.stringify(detail.problems)}`).toBe(true);
      expect(registry.nodeTypes().find((n) => n.type === detail.nodeTypes[0])?.descriptor.kind, t.id).toBe('trigger');
      for (const slot of detail.credentials) expect(slot.nodes?.length, `${t.id}: ${slot.id}`).toBeGreaterThan(0);
    }
  });

  it('searches by name, description and node type, and filters by category', async () => {
    const ids = (list: TemplateSummary[]) => list.map((t) => t.id);
    expect(ids((await templates.listTemplates({ search: 'telegram' })).templates)).toEqual(expect.arrayContaining(['uptime-monitor-telegram', 'telegram-ai-bot', 'error-alerts']));
    expect(ids((await templates.listTemplates({ search: 'gmail triage' })).templates)).toEqual(['gmail-ai-triage']);
    const sales = (await templates.listTemplates({ category: 'sales' })).templates;
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((t) => t.categories.includes('sales'))).toBe(true);
    const listing = await templates.listTemplates();
    expect(listing.remote).toEqual({ enabled: false });
    expect(listing.templates.find((t) => t.id === 'ollama-chat-agent')).not.toHaveProperty('workflow');
  });
});

describe('using a template', () => {
  let openai: string;
  let slack: string;
  let github: string;

  beforeAll(() => {
    openai = credentials.create({ name: 'OpenAI prod', type: 'core.openAiApi', data: { apiKey: 'sk-test' } }).id;
    slack = credentials.create({ name: 'Team Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-test' } }).id;
    github = credentials.create({ name: 'GitHub bot', type: 'productivity.githubApi', data: { accessToken: 'ghp_test' } }).id;
  });

  it('remaps credential slots to the credentials picked, and leaves unpicked ones empty', async () => {
    const folder = folders.create({ name: 'From templates' });
    const result = await templates.useTemplate('github-issue-triage', { folderId: folder.id, name: 'Issue triage', credentials: { github, openai } });
    const saved = store.getWorkflow(result.workflow.id)!;
    expect(saved).toMatchObject({ name: 'Issue triage', folderId: folder.id, active: false });
    const byName = (name: string) => saved.nodes.find((n) => n.name === name)!;
    expect(byName('New issue').credentials).toEqual({ githubApi: { id: github, name: 'GitHub bot' } });
    expect(byName('Comment triage').credentials).toEqual({ githubApi: { id: github, name: 'GitHub bot' } });
    expect(byName('OpenAI Chat Model').credentials).toEqual({ openAiApi: { id: openai, name: 'OpenAI prod' } });
    // Slack wasn't picked: no reference at all (never a slot id), and a warning says so.
    expect(byName('Tell the team').credentials).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(/Slack bot: no credential picked/);
    expect(JSON.stringify(saved)).not.toMatch(/"id":"(github|openai|slack)"/);
    // Defaults were filled in like the editor would.
    expect(byName('Tell the team').parameters).toHaveProperty('otherOptions');
  });

  it('refuses a credential of the wrong type or one that doesn’t exist', async () => {
    const wrong = await rejects(templates.useTemplate('github-issue-triage', { credentials: { github: slack } }), 400);
    expect(wrong.message).toMatch(/messaging\.slackApi credential; this needs productivity\.githubApi/);
    await rejects(templates.useTemplate('github-issue-triage', { credentials: { openai: 'cred_nope' } }), 400);
    await rejects(templates.useTemplate('nope'), 404);
    await rejects(templates.useTemplate('github-issue-triage', { folderId: 'fd_nope' }), 404);
  });

  it('creates the data tables it needs (once), points its nodes at them and makes webhook paths unique', async () => {
    const first = await templates.useTemplate('webhook-json-api', {});
    expect(first.createdTables).toEqual(['Orders']);
    const orders = dataTables().findTable('Orders')!;
    expect(orders.columns.map((c) => [c.name, c.type])).toEqual([
      ['email', 'string'],
      ['item', 'string'],
      ['quantity', 'number'],
      ['received_at', 'date'],
    ]);
    const save = first.workflow.nodes.find((n) => n.type === 'core.dataTable')!;
    expect(save.parameters.dataTableId).toBe(orders.id);
    expect(first.workflow.nodes.find((n) => n.type === 'core.webhook')!.parameters.path).toBe('orders');
    const second = await templates.useTemplate('webhook-json-api', {});
    expect(second.createdTables).toEqual([]);
    expect(second.workflow.nodes.find((n) => n.type === 'core.webhook')!.parameters.path).toBe('orders-2');
    expect(second.workflow.nodes.find((n) => n.type === 'core.dataTable')!.parameters.dataTableId).toBe(orders.id);
    // The saved workflow validates and keeps the template's groups when it has some.
    const rag = await templates.useTemplate('support-agent-rag', {});
    expect(rag.workflow.groups?.map((g) => g.name)).toEqual(['Ingest documents', 'Answer questions']);
    expect(validateWorkflow(rag.workflow).errors).toEqual([]);
  });
});

describe('save as template', () => {
  let source: Workflow;
  let slackId: string;

  beforeAll(() => {
    slackId = credentials.create({ name: 'Ops Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-ops' } }).id;
    const table = dataTables().createTable({ name: 'Incidents', columns: [{ name: 'title', type: 'string' }] });
    const folder = folders.create({ name: 'Ops' });
    source = store.saveWorkflow({
      id: 'wf_source',
      name: 'Ops alerts',
      description: 'Alert the ops channel',
      active: true,
      folderId: folder.id,
      tags: ['ops'],
      settings: { errorWorkflowId: 'wf_errors', timezone: 'Europe/Berlin', callerPolicy: 'list', callerIds: ['wf_a'] },
      nodes: [
        { id: 'hook', name: 'Hook', type: 'core.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'ops-alert' } },
        { id: 'log', name: 'Log', type: 'core.dataTable', typeVersion: 1, position: [260, 0], parameters: { operation: 'insert', dataTableId: table.id, mappingMode: 'autoMapInputData' } },
        { id: 'post', name: 'Post', type: 'messaging.slack', typeVersion: 1, position: [520, 0], parameters: { channelId: '#ops', text: 'hi' }, credentials: { slackApi: { id: slackId, name: 'Ops Slack' } } },
        { id: 'tg', name: 'Telegram', type: 'messaging.telegram', typeVersion: 1, position: [520, 160], parameters: { chatId: '1', text: 'hi' } },
      ],
      connections: [
        { id: 'c1', type: 'main', source: 'hook', sourceIndex: 0, target: 'log', targetIndex: 0 },
        { id: 'c2', type: 'main', source: 'log', sourceIndex: 0, target: 'post', targetIndex: 0 },
        { id: 'c3', type: 'main', source: 'log', sourceIndex: 0, target: 'tg', targetIndex: 0 },
      ],
      pinData: { hook: [{ json: { secret: 'pinned-value' } }] },
      groups: [{ id: 'g1', name: 'Notify', nodeIds: ['post', 'tg'], position: [480, -60], width: 300, height: 400 }],
    });
  });

  it('turns credentials into slots and leaves pinned data, ids and instance details out', () => {
    const saved = templates.saveTemplate({ workflow: source as unknown as Record<string, unknown>, name: 'Ops alerts', description: '', categories: ['it-ops', 'bogus'], setup: ['Pick the channel', ' '] }, 'Ada');
    expect(saved).toMatchObject({ source: 'local', name: 'Ops alerts', description: 'Alert the ops channel', categories: ['it-ops'], setup: ['Pick the channel'], author: 'Ada', usable: true });
    expect(saved.id).toMatch(/^tpl_/);
    const text = JSON.stringify(saved);
    expect(text).not.toContain(slackId);
    expect(text).not.toContain('pinned-value');
    expect(text).not.toContain('wf_errors');
    expect(text).not.toContain('wf_source');
    expect(saved.workflow).not.toHaveProperty('pinData');
    expect(saved.workflow).not.toHaveProperty('active');
    expect(saved.workflow).not.toHaveProperty('folderId');
    expect(saved.workflow).not.toHaveProperty('tags');
    expect(saved.workflow.settings).toEqual({ timezone: 'Europe/Berlin' });
    expect(saved.workflow.groups).toEqual(source.groups);
    // One slot for the Slack credential that was set, one for the Telegram credential that wasn't.
    expect(saved.credentials.map((s) => [s.id, s.type, s.nodes])).toEqual([
      ['slackApi', 'messaging.slackApi', ['Post']],
      ['telegramApi', 'messaging.telegramApi', ['Telegram']],
    ]);
    expect(saved.workflow.nodes.find((n) => n.id === 'post')!.credentials).toEqual({ slackApi: { id: 'slackApi', name: saved.credentials[0].name } });
    // The data table goes by name, with its columns.
    expect(saved.dataTables).toEqual([{ name: 'Incidents', columns: [{ name: 'title', type: 'string' }] }]);
    expect(saved.workflow.nodes.find((n) => n.id === 'log')!.parameters.dataTableId).toBe('Incidents');
  });

  it('exports and imports templates, and deletes saved ones only', async () => {
    const builtin = (await templates.getTemplate('lead-form-gmail'))!;
    const file: TemplateFile = templates.templateFile(builtin);
    expect(file).toMatchObject({ kind: 'landflow/template', version: 1 });
    expect(file.template.credentials[0]).not.toHaveProperty('nodes');
    // Through JSON text, like a downloaded file.
    const imported = templates.importTemplate(JSON.stringify(file), 'Grace');
    expect(imported).toMatchObject({ source: 'local', name: builtin.name, author: 'Grace', usable: true });
    expect(imported.workflow.nodes).toEqual(builtin.workflow.nodes);
    expect(imported.credentials.map(({ nodes: _n, ...s }) => s)).toEqual(file.template.credentials);
    expect(imported.dataTables).toEqual(builtin.dataTables);
    // A reference to a credential the file doesn't declare becomes a slot; it is never kept as an id.
    const tampered = structuredClone(file);
    tampered.template.workflow.nodes[2].credentials = { googleOAuth2Api: { id: 'cred_real_id', name: 'Leaked' } };
    tampered.template.credentials = [];
    const cleaned = templates.importTemplate(tampered);
    expect(JSON.stringify(cleaned)).not.toContain('cred_real_id');
    expect(cleaned.credentials.map((s) => s.type)).toEqual(['google.googleOAuth2Api']);
    expect(() => templates.importTemplate({ kind: 'something-else' })).toThrow(/Not a Landflow template file/);
    expect(() => templates.importTemplate('{nope')).toThrow(/isn’t JSON/);

    await rejects(() => templates.deleteTemplate('lead-form-gmail'), 400);
    templates.deleteTemplate(imported.id);
    expect(await templates.getTemplate(imported.id)).toBeUndefined();
    await rejects(() => templates.deleteTemplate(imported.id), 404);
  });
});

describe('templates that can’t be used here', () => {
  it('shows missing node types and refuses to use them', async () => {
    const file: TemplateFile = {
      kind: 'landflow/template',
      version: 1,
      template: {
        name: 'Needs a plugin',
        description: '',
        categories: [],
        credentials: [],
        setup: [],
        dataTables: [],
        workflow: {
          id: '',
          name: 'Needs a plugin',
          nodes: [
            { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
            { id: 'b', name: 'Thing', type: 'acme.thing', typeVersion: 1, position: [260, 0], parameters: {} },
          ],
          connections: [{ id: 'c1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
        },
      },
    };
    const template = templates.importTemplate(file);
    expect(template.usable).toBe(false);
    expect(template.problems).toEqual([{ kind: 'missing', nodeType: 'acme.thing', message: 'Needs the acme plugin (acme.thing)' }]);
    const refused = await rejects(templates.useTemplate(template.id, {}), 409);
    expect(refused.details?.problems).toEqual(template.problems);
  });

  it('marks templates with nodes the governance policy blocks, until the policy allows them', async () => {
    updateGovernancePolicy({ nodes: { mode: 'block', types: ['messaging.telegram*'], plugins: [] } });
    try {
      const detail = (await templates.getTemplate('uptime-monitor-telegram'))!;
      expect(detail.usable).toBe(false);
      expect(detail.problems).toEqual([{ kind: 'blocked', nodeType: 'messaging.telegram', message: 'messaging.telegram is blocked on this instance' }]);
      const listed = (await templates.listTemplates({ search: 'telegram' })).templates;
      expect(listed.filter((t) => t.source === 'builtin' && !t.usable).map((t) => t.id).sort()).toEqual(['error-alerts', 'telegram-ai-bot', 'uptime-monitor-telegram']);
      await rejects(templates.useTemplate('telegram-ai-bot', {}), 409);
    } finally {
      updateGovernancePolicy({ nodes: { mode: 'off', types: [], plugins: [] } });
    }
    expect((await templates.getTemplate('uptime-monitor-telegram'))!.usable).toBe(true);
  });
});

describe('remote templates (n8n-compatible API)', () => {
  let server: Server;
  let base = '';
  const requests: string[] = [];
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'n8n-templates', name), 'utf8');

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body = url.pathname === '/api/templates/search' ? fixture('search.json') : url.pathname === '/api/templates/workflows/1750' ? fixture('workflow-1750.json') : undefined;
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
      res.end(body ?? '{"message":"not found"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    process.env.LANDFLOW_TEMPLATES_URL = `${base}/`;
    clearRemoteCache();
  });

  afterAll(async () => {
    delete process.env.LANDFLOW_TEMPLATES_URL;
    clearRemoteCache();
    await new Promise((resolve) => server.close(resolve));
  });

  it('lists remote templates when asked for them or searching', async () => {
    const listing = await templates.listTemplates({ source: 'remote' });
    expect(listing.remote).toMatchObject({ enabled: true, label: new URL(base).host, page: 1, hasMore: false });
    expect(listing.templates.map((t) => [t.id, t.source, t.author])).toEqual([
      ['n8n-1750', 'remote', 'n8n Team'],
      ['n8n-2291', 'remote', 'Ada'],
    ]);
    expect(listing.templates[0].nodeTypes).toEqual(['core.webhook', 'core.set', 'messaging.slack']);
    expect(requests.at(-1)).toBe('/api/templates/search?page=1&rows=30');
    // Searching includes them after the local and built-in matches; browsing without a search doesn't call out.
    const searched = await templates.listTemplates({ search: 'slack' });
    expect(searched.templates.at(-1)?.source).toBe('remote');
    expect(requests.at(-1)).toBe('/api/templates/search?page=1&rows=30&search=slack');
    const count = requests.length;
    await templates.listTemplates();
    expect(requests.length).toBe(count);
  });

  it('converts a remote workflow through the n8n importer, with its report and credential slots', async () => {
    const detail = (await templates.getTemplate('n8n-1750')) as TemplateDetail;
    expect(detail).toMatchObject({ source: 'remote', name: 'Post new form submissions to Slack', categories: ['marketing', 'sales'], usable: true });
    expect(detail.description).toContain('## What it does');
    expect(detail.report?.format).toBe('n8n');
    expect(detail.report?.placeholders.map((p) => p.name)).toEqual(['Airtop']);
    expect(detail.report?.warnings.join('\n')).toMatch(/credential slackApi dropped/);
    expect(detail.workflow.nodes.map((n) => n.type)).toEqual(['core.webhook', 'core.set', 'messaging.slack', 'core.noOp']);
    expect(detail.credentials.map((s) => [s.id, s.type, s.nodes])).toEqual([['slackApi', 'messaging.slackApi', ['Slack']]]);

    const slack = credentials.create({ name: 'Remote Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-remote' } }).id;
    const used = await templates.useTemplate('n8n-1750', { credentials: { slackApi: slack } });
    expect(used.report?.placeholders).toHaveLength(1);
    expect(used.workflow.nodes.find((n) => n.name === 'Slack')!.credentials).toEqual({ slackApi: { id: slack, name: 'Remote Slack' } });
    expect(used.workflow.nodes.find((n) => n.type === 'core.webhook')!.parameters.path).toBe('form-to-slack');
  });

  it('reports an unreachable API, and is off without LANDFLOW_TEMPLATES_URL', async () => {
    await rejects(templates.getTemplate('n8n-999'), 502);
    expect(await templates.getTemplate('n8n-abc')).toBeUndefined();
    process.env.LANDFLOW_TEMPLATES_URL = 'http://127.0.0.1:9/api';
    clearRemoteCache();
    const down = await templates.listTemplates({ source: 'remote' });
    expect(down.templates).toEqual([]);
    expect(down.remote.error).toBeTruthy();
    delete process.env.LANDFLOW_TEMPLATES_URL;
    expect((await templates.listTemplates({ source: 'remote' })).remote).toEqual({ enabled: false });
    expect(await templates.getTemplate('n8n-1750')).toBeUndefined();
    process.env.LANDFLOW_TEMPLATES_URL = `${base}/`;
  });
});

describe('/api/templates', () => {
  const call = async (route: (request: Request, ctx: never) => Promise<Response>, path: string, init: { method?: string; body?: unknown } = {}, id?: string) => {
    const request = new Request(`http://localhost:3000${path}`, {
      method: init.method ?? 'GET',
      ...(init.body !== undefined && { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
    });
    const response = await route(request, (id ? { params: Promise.resolve({ id }) } : undefined) as never);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };

  it('lists, shows, exports, saves, uses and deletes', async () => {
    const list = await call(listRoute.GET, '/api/templates?category=ai');
    expect(list.status).toBe(200);
    expect(list.body.templates.length).toBeGreaterThan(3);
    expect((await call(listRoute.GET, '/api/templates?source=nope')).status).toBe(400);

    const detail = await call(itemRoute.GET, '/api/templates/ollama-chat-agent', {}, 'ollama-chat-agent');
    expect(detail.body.template.workflow.nodes).toHaveLength(5);
    const file = await call(itemRoute.GET, '/api/templates/ollama-chat-agent?format=file', {}, 'ollama-chat-agent');
    expect(file.body.kind).toBe('landflow/template');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="private-ai-chat-with-ollama.template.json"');
    expect((await call(itemRoute.GET, '/api/templates/nope', {}, 'nope')).status).toBe(404);

    const saved = await call(listRoute.POST, '/api/templates', {
      method: 'POST',
      body: { workflow: { name: 'Tiny', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] }, name: 'Tiny template' },
    });
    expect(saved.status).toBe(201);
    const id = saved.body.template.id as string;
    const imported = await call(listRoute.POST, '/api/templates', { method: 'POST', body: { data: file.body } });
    expect(imported.status).toBe(201);
    expect((await call(listRoute.POST, '/api/templates', { method: 'POST', body: { data: { kind: 'x' } } })).status).toBe(400);

    const used = await call(useRoute.POST, `/api/templates/${id}/use`, { method: 'POST', body: { name: 'From tiny' } }, id);
    expect(used.status).toBe(201);
    expect(store.getWorkflow(used.body.workflow.id)?.name).toBe('From tiny');
    expect((await call(useRoute.POST, '/api/templates/nope/use', { method: 'POST', body: {} }, 'nope')).status).toBe(404);

    expect((await call(itemRoute.DELETE, `/api/templates/${id}`, { method: 'DELETE' }, id)).status).toBe(200);
    expect((await call(itemRoute.DELETE, '/api/templates/ollama-chat-agent', { method: 'DELETE' }, 'ollama-chat-agent')).status).toBe(400);
  });
});
