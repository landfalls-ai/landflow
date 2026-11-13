/**
 * Marketplace: frontmatter and source parsing, Claude Code → Landflow mapping, plugin reading,
 * install / uninstall bookkeeping against a fake GitHub, and a supervised node plugin built with
 * the SDK from a local fixture.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentStore } from '@/lib/server/agents/store';
import { parseFrontmatter, stringList } from '@/lib/server/marketplace/frontmatter';
import { agentFromClaude, mapModel, skillFromClaude } from '@/lib/server/marketplace/map';
import { loadPlugin, parseAgentFile, parseNodeManifest, plainDescription } from '@/lib/server/marketplace/plugin';
import { clearTreeCache, readerFor } from '@/lib/server/marketplace/reader';
import { linkGoSdk, portFree } from '@/lib/server/marketplace/node-plugins';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { marketplace } from '@/lib/server/marketplace/service';
import { parseMarketplaceInput, resolveSource } from '@/lib/server/marketplace/sources';
import { marketplaceStore } from '@/lib/server/marketplace/store';
import { localTemplates } from '@/lib/server/templates/store';
import type { ExploreResult, InstallConfirmation, InstallResult } from '@/lib/shared/marketplace';

// Its own data directory, set before the imports above run: in the shared one (vitest.config.ts) another file's
// marketplace state (the fetched Anthropic catalog, other marketplaces) made the list and explore tests flaky.
await vi.hoisted(async () => {
  const { mkdtempSync: makeDir } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  process.env.LANDFLOW_DATA_DIR = makeDir(joinPath(tmp(), 'landflow-marketplace-'));
});

describe('frontmatter', () => {
  it('reads Claude Code agent files', () => {
    const { data, body } = parseFrontmatter(`---
name: code-explorer
description: Deeply analyzes existing codebase features
tools: Glob, Grep, LS, Read, Bash(git log:*)
model: sonnet
color: yellow
---

You are an expert code analyst.

## Core Mission
Trace it.`);
    expect(data).toMatchObject({ name: 'code-explorer', model: 'sonnet', color: 'yellow' });
    expect(stringList(data.tools)).toEqual(['Glob', 'Grep', 'LS', 'Read', 'Bash(git log:*)']);
    expect(body).toBe('You are an expert code analyst.\n\n## Core Mission\nTrace it.');
  });

  it('handles block scalars, flow and block lists, quotes and nested maps', () => {
    const { data } = parseFrontmatter(`---
name: "agent-creator"
description: |
  Use this agent when the user asks to "create an agent".

  <example>
  user: "Create an agent"
  </example>
folded: >-
  one
  two
tools: ["Write", 'Read']
allowed-tools:
  - Bash(git add:*)
  - Read
metadata:
  version: 1.2
  author: Acme # comment
empty:
---
body`);
    expect(data.name).toBe('agent-creator');
    expect(data.description).toBe('Use this agent when the user asks to "create an agent".\n\n<example>\nuser: "Create an agent"\n</example>\n');
    expect(data.folded).toBe('one two');
    expect(stringList(data.tools)).toEqual(['Write', 'Read']);
    expect(stringList(data['allowed-tools'])).toEqual(['Bash(git add:*)', 'Read']);
    expect(data.metadata).toEqual({ version: 1.2, author: 'Acme' });
    expect(data.empty).toBeNull();
    expect(plainDescription(String(data.description))).toBe('Use this agent when the user asks to "create an agent".');
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseFrontmatter('# Just markdown\n')).toEqual({ data: {}, body: '# Just markdown' });
  });
});

describe('sources', () => {
  it('parses what users type as a marketplace', () => {
    expect(parseMarketplaceInput('anthropics/claude-plugins-official')).toEqual({ kind: 'github', owner: 'anthropics', repo: 'claude-plugins-official' });
    expect(parseMarketplaceInput('acme/tools@v2')).toEqual({ kind: 'github', owner: 'acme', repo: 'tools', ref: 'v2' });
    expect(parseMarketplaceInput('https://github.com/acme/tools.git')).toEqual({ kind: 'github', owner: 'acme', repo: 'tools' });
    expect(parseMarketplaceInput('https://github.com/acme/tools/tree/dev')).toEqual({ kind: 'github', owner: 'acme', repo: 'tools', ref: 'dev' });
    expect(parseMarketplaceInput('https://raw.githubusercontent.com/acme/tools/main/.claude-plugin/marketplace.json')).toEqual({ kind: 'github', owner: 'acme', repo: 'tools', ref: 'main' });
    expect(parseMarketplaceInput('https://example.com/marketplace.json')).toEqual({ kind: 'url', url: 'https://example.com/marketplace.json' });
    expect(() => parseMarketplaceInput('ftp://example.com/x')).toThrow(/http/);
    expect(() => parseMarketplaceInput('')).toThrow();
  });

  const gh = { kind: 'github' as const, owner: 'acme', repo: 'tools' };
  const sha = 'faf5305385de8afed9468904e8639be737aff39e';

  it('resolves plugin sources', () => {
    expect(resolveSource('./plugins/x', gh)).toEqual({ kind: 'github', owner: 'acme', repo: 'tools', ref: 'HEAD', path: 'plugins/x' });
    expect(resolveSource('./', gh)).toMatchObject({ kind: 'github', path: '' });
    expect(resolveSource('formatter', gh, './plugins')).toMatchObject({ path: 'plugins/formatter' });
    expect(resolveSource({ source: 'github', repo: 'org/one', ref: 'v1' }, gh)).toEqual({ kind: 'github', owner: 'org', repo: 'one', ref: 'v1', path: '' });
    expect(resolveSource({ source: 'url', url: 'https://github.com/org/two.git', sha }, gh)).toEqual({ kind: 'github', owner: 'org', repo: 'two', ref: sha, path: '', sha });
    expect(resolveSource({ source: 'git-subdir', url: 'https://github.com/org/mono.git', path: 'plugins/p', ref: 'main' }, gh)).toMatchObject({ owner: 'org', repo: 'mono', ref: 'main', path: 'plugins/p' });
    expect(resolveSource({ source: 'git-subdir', url: 'org/mono', path: 'p' }, gh)).toMatchObject({ owner: 'org', repo: 'mono', path: 'p' });
  });

  it('marks what it can’t fetch as unsupported', () => {
    expect(resolveSource('./../escape', gh)).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('..') });
    expect(resolveSource('plugins/x', gh)).toMatchObject({ kind: 'unsupported' });
    expect(resolveSource({ source: 'npm', package: 'x' }, gh)).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('npm') });
    expect(resolveSource({ source: 'url', url: 'https://gitlab.com/a/b.git' }, gh)).toMatchObject({ kind: 'unsupported', reason: expect.stringContaining('GitHub') });
    expect(resolveSource('./plugins/x', { kind: 'url', url: 'https://example.com/m.json' })).toMatchObject({ kind: 'unsupported' });
  });
});

describe('mapping', () => {
  it('maps Claude Code model aliases', () => {
    expect(mapModel('sonnet')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(mapModel('opus')).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(mapModel('haiku')).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(mapModel('inherit')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(mapModel('claude-opus-4-1')).toEqual({ provider: 'anthropic', model: 'claude-opus-4-1' });
    expect(mapModel('gpt-4o')).toBeUndefined();
    expect(mapModel(undefined)).toBeUndefined();
  });

  it('turns an agent file into an agent draft', () => {
    const file = parseAgentFile('agents/code-reviewer.md', `---\nname: code-reviewer\ndescription: Reviews code for bugs\ntools: Read, Grep\nmodel: opus\ncolor: green\n---\nYou review code.`);
    const skill = skillFromClaude({ dir: 'skills/x', name: 'checklist', description: 'Use when reviewing', body: '1. Look', allowedTools: [], references: [] });
    const config = agentFromClaude(file, { pluginId: 'reviewers@acme', skills: [skill] });
    expect(config).toMatchObject({
      name: 'Code Reviewer',
      icon: 'scan-search',
      color: '#22c55e',
      model: { provider: 'anthropic', model: 'claude-opus-5-5' },
      instructions: 'You review code.',
      skills: [{ name: 'checklist', whenToUse: 'Use when reviewing', instructions: '1. Look' }],
    });
    expect(config.description).toContain('Reviews code for bugs');
    expect(config.description).toContain('Installed from reviewers@acme.');
    expect(config.description).toContain('Claude Code tools not mapped: Read, Grep');
  });

  it('validates node plugin manifests', () => {
    expect(parseNodeManifest({ id: 'acme-nodes', start: ['tsx', 'main.ts'] })).toEqual({ id: 'acme-nodes', runtime: 'node', start: ['tsx', 'main.ts'] });
    expect(parseNodeManifest({ id: 'Bad Id', start: ['x'] })).toBeUndefined();
    expect(parseNodeManifest({ id: 'ok', start: 'tsx main.ts' })).toBeUndefined();
    expect(parseNodeManifest({ id: 'py', runtime: 'python', start: ['python3', 'main.py'], env: { GOOD: '1', bad: 'x' } })).toMatchObject({ runtime: 'python', env: { GOOD: '1' } });
  });
});

// ---------------------------------------------------------------------------
// A fake GitHub: the raw host and the trees API for one repo.
// ---------------------------------------------------------------------------

const REPO: Record<string, string> = {
  '.claude-plugin/marketplace.json': JSON.stringify({
    name: 'acme-tools',
    owner: { name: 'Acme' },
    plugins: [
      { name: 'reviewers', source: './plugins/reviewers', description: 'Code review agents', category: 'development' },
      { name: 'writing-skills', source: './', strict: false, skills: ['./skills/writing'], description: 'Writing skills' },
      { name: 'mcp-only', source: './plugins/mcp-only', description: 'Just an MCP server' },
      { name: 'npm-thing', source: { source: 'npm', package: 'x' } },
      { name: 'node-tools', source: './plugins/node-tools', description: 'Nodes', landflow: { id: 'acme-nodes', start: ['tsx', 'main.ts'] } },
      { name: 'soc-flows', source: './plugins/soc-flows', description: 'Triage flows', category: 'security', flows: ['./flows/triage.json', './extra'] },
    ],
  }),
  'plugins/reviewers/.claude-plugin/plugin.json': JSON.stringify({ name: 'reviewers', version: '1.2.0' }),
  'plugins/reviewers/README.md': '# Reviewers',
  'plugins/reviewers/agents/code-reviewer.md': '---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.',
  'plugins/reviewers/agents/test-analyzer.md': '---\nname: test-analyzer\ndescription: Checks tests\nmodel: haiku\n---\nYou analyze tests.',
  'plugins/reviewers/skills/review-checklist/SKILL.md': '---\nname: review-checklist\ndescription: Use when reviewing a pull request\n---\n1. Read the diff',
  'plugins/reviewers/skills/review-checklist/references/owasp.md': '# OWASP top 10',
  'plugins/reviewers/commands/review.md': '---\ndescription: Review\n---\nReview it',
  'plugins/reviewers/hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: [] } }),
  'skills/writing/SKILL.md': '---\nname: writing\ndescription: Use when drafting prose\n---\nWrite clearly.',
  'skills/other/SKILL.md': '---\nname: other\ndescription: Not listed\n---\nx',
  'plugins/mcp-only/.mcp.json': JSON.stringify({ github: { type: 'http', url: 'https://example.com/mcp' } }),
  'plugins/node-tools/landflow.plugin.json': JSON.stringify({ id: 'acme-nodes', start: ['tsx', 'main.ts'] }),
  'plugins/node-tools/main.ts': 'console.log("hi")',
  'plugins/soc-flows/flows/triage.json': flowFile('Alert triage', ['core.webhook', 'acme-soc.decide'], [{ id: 'soc', name: 'SOC API', type: 'core.httpHeaderAuth' }]),
  'plugins/soc-flows/flows/broken.json': JSON.stringify({ kind: 'landflow/template', version: 1, template: { name: '' } }),
  'plugins/soc-flows/extra/digest.json': flowFile('Triage digest', ['core.schedule']),
  'plugins/soc-flows/extra/nested/skip.json': flowFile('Not read', ['core.schedule']),
};

/** A Landflow template file whose workflow is a chain of `types`; the last node uses the credential slots. */
function flowFile(name: string, types: string[], credentials: Array<{ id: string; name: string; type: string }> = []) {
  const uses = Object.fromEntries(credentials.map((c) => [c.type, { id: c.id, name: c.name }]));
  const nodes = types.map((type, i) => ({ id: `n${i}`, name: `Node ${i}`, type, position: [i * 200, 0], parameters: {}, ...(i === types.length - 1 && credentials.length && { credentials: uses }) }));
  const connections = nodes.slice(1).map((n, i) => ({ id: `c${i}`, type: 'main', source: nodes[i].id, sourceIndex: 0, target: n.id, targetIndex: 0 }));
  return JSON.stringify({ kind: 'landflow/template', version: 1, template: { name, description: `${name} flow`, categories: ['security', 'incident-response'], credentials, workflow: { name, nodes, connections } } });
}

const requests: string[] = [];

function fakeGitHub(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requests.push(url.href);
  if (url.hostname === 'api.github.com' && url.pathname === '/repos/acme/tools/git/trees/HEAD') {
    const tree = Object.entries(REPO).map(([path, content]) => ({ path, type: 'blob', size: content.length }));
    return Promise.resolve(Response.json({ tree, truncated: false }));
  }
  const raw = /^\/acme\/tools\/HEAD\/(.+)$/.exec(url.pathname);
  if (url.hostname === 'raw.githubusercontent.com' && raw) {
    const content = REPO[decodeURIComponent(raw[1])];
    return Promise.resolve(content === undefined ? new Response('404: Not Found', { status: 404 }) : new Response(content));
  }
  return Promise.resolve(new Response('not found', { status: 404 }));
}

describe('install and uninstall', () => {
  beforeAll(() => vi.stubGlobal('fetch', vi.fn(fakeGitHub)));
  afterAll(() => vi.unstubAllGlobals());

  it('lists the Anthropic preset without fetching it', () => {
    const before = requests.length;
    expect(marketplace.list()).toEqual([expect.objectContaining({ id: 'mk_anthropic_official', preset: true, plugins: 0 })]);
    expect(requests.length).toBe(before);
  });

  let id = '';

  it('adds a marketplace and lists its catalog', async () => {
    const added = await marketplace.add('acme/tools');
    id = added.id;
    expect(added).toMatchObject({ name: 'acme-tools', owner: 'Acme', plugins: 6 });
    await expect(marketplace.add('https://github.com/acme/tools')).rejects.toThrow(/Already added/);
    const catalog = await marketplace.catalog(id);
    expect(catalog.categories).toEqual(['development', 'security']);
    const byName = Object.fromEntries(catalog.plugins.map((p) => [p.name, p]));
    expect(byName.reviewers).toMatchObject({ supported: true, installed: false, sourceLabel: './plugins/reviewers' });
    expect(byName['npm-thing']).toMatchObject({ supported: false, unsupportedReason: expect.stringContaining('npm') });
    expect(byName['node-tools'].landflow).toBe(true);
    expect(byName['soc-flows'].flows).toBe(2);
    expect(byName.reviewers.flows).toBe(0);
  });

  it('reads what a plugin contains', async () => {
    const detail = await marketplace.detail(id, 'reviewers');
    expect(detail.agents.map((a) => a.name)).toEqual(['code-reviewer', 'test-analyzer']);
    expect(detail.skills).toEqual([expect.objectContaining({ name: 'review-checklist', references: [{ name: 'owasp.md', content: '# OWASP top 10' }] })]);
    expect(detail.unsupported).toEqual([
      { kind: 'commands', items: ['review.md'] },
      { kind: 'hooks', items: ['PostToolUse'] },
    ]);
    expect(detail.readme).toBe('# Reviewers');
    expect(detail.manifest.version).toBe('1.2.0');
    // A plugin at the marketplace root loads only its listed skills.
    const writing = await marketplace.detail(id, 'writing-skills');
    expect(writing.skills.map((s) => s.name)).toEqual(['writing']);
    expect(writing.agents).toEqual([]);
  });

  it('pins a plugin for kagent’s Claude Code runtime to the commit its branch is at', async () => {
    const commit = 'c0ffee'.padEnd(40, '0');
    // Only this test answers the commits API: elsewhere a branch stays unpinned.
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return url.pathname === '/repos/acme/tools/commits/HEAD' ? Promise.resolve(new Response(commit)) : fakeGitHub(input);
    }));
    try {
      expect((await marketplace.detail(id, 'reviewers')).claudeManifest).toBe(true);
      expect(await marketplace.claudePlugin('reviewers@acme-tools')).toEqual({ id: 'reviewers@acme-tools', url: 'https://github.com/acme/tools.git', commit, path: 'plugins/reviewers' });
      // Claude Code loads a plugin whole only from its manifest.
      await expect(marketplace.claudePlugin('mcp-only@acme-tools')).rejects.toThrow('The plugin mcp-only@acme-tools has no .claude-plugin/plugin.json');
      await expect(marketplace.claudePlugin('reviewers@elsewhere')).rejects.toThrow('The plugin reviewers@elsewhere is in no added marketplace: add “elsewhere” on the Marketplace page');
    } finally {
      vi.stubGlobal('fetch', vi.fn(fakeGitHub));
    }
  });

  it('installs agents with the plugin’s skills and records what it created', async () => {
    const result = (await marketplace.install(id, 'reviewers')) as InstallResult;
    expect(result.installed).toMatchObject({ id: 'reviewers@acme-tools', version: '1.2.0', agents: [{ name: 'Code Reviewer' }, { name: 'Test Analyzer' }], skills: [{ name: 'review-checklist' }] });
    expect(result.notSupported.map((u) => u.kind)).toEqual(['commands', 'hooks']);
    const agents = result.installed.agents.map((a) => agentStore.get(a.id)!);
    expect(agents[0]).toMatchObject({ instructions: 'You review code.', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, skills: [{ name: 'review-checklist' }] });
    expect(agents[1].model).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(marketplace.skills().map((s) => [s.name, s.source.installedId])).toEqual([['review-checklist', 'reviewers@acme-tools']]);
    expect((await marketplace.catalog(id)).plugins.find((p) => p.name === 'reviewers')?.installed).toBe(true);
    await expect(marketplace.install(id, 'reviewers')).rejects.toThrow(/already installed/);
    expect(() => marketplace.remove(id)).toThrow(/Uninstall its plugins first/);

    const skillsOnly = (await marketplace.install(id, 'writing-skills')) as InstallResult;
    expect(skillsOnly.installed.agents).toEqual([]);
    expect(marketplace.skills().map((s) => s.name)).toEqual(['review-checklist', 'writing']);
  });

  it('refuses plugins with nothing Landflow can run, and asks before running code', async () => {
    await expect(marketplace.install(id, 'mcp-only')).rejects.toThrow(/Nothing in “mcp-only” runs in Landflow yet: it only has mcpServers \(1\)/);
    await expect(marketplace.install(id, 'npm-thing')).rejects.toThrow(/npm/);
    const confirm = (await marketplace.install(id, 'node-tools')) as InstallConfirmation;
    expect(confirm).toMatchObject({ needsConfirmation: true, command: 'tsx main.ts', repository: 'github.com/acme/tools/plugins/node-tools' });
    expect(marketplace.installed().map((p) => p.id)).toEqual(['reviewers@acme-tools', 'writing-skills@acme-tools']);
  });

  it('reads the flows a plugin ships and what each still needs', async () => {
    registry.registerBuiltin(corePlugin);
    const detail = await marketplace.detail(id, 'soc-flows');
    expect(detail.flows.map((f) => f.path)).toEqual(['extra/digest.json', 'flows/triage.json']);
    expect(detail.flows[1]).toMatchObject({ name: 'Alert triage', nodeCount: 2, nodeTypes: ['core.webhook', 'acme-soc.decide'], credentials: ['SOC API'], needs: ['acme-soc.decide'] });
    expect(detail.flows[0].needs).toEqual([]);
    // An invalid file is a warning, not a flow; a nested folder isn't read.
    expect(detail.warnings).toEqual([expect.stringContaining('flows/broken.json: not a Landflow template file')]);
    // Once another plugin provides the node, the cached detail says so too.
    const types = registry.nodeTypes();
    const installed = vi.spyOn(registry, 'nodeTypes').mockReturnValue([...types, { ...types[0], type: 'acme-soc.decide' }]);
    try {
      expect((await marketplace.detail(id, 'soc-flows')).flows[1].needs).toEqual([]);
    } finally {
      installed.mockRestore();
    }
    expect((await marketplace.detail(id, 'soc-flows')).flows[1].needs).toEqual(['acme-soc.decide']);
  });

  it('shows one flow read only for its share page, by marketplace name or id', async () => {
    const view = await marketplace.flow('acme-tools', 'soc-flows', 'flows/triage.json');
    expect(view.marketplace).toMatchObject({ id, name: 'acme-tools' });
    expect(view.link).toBe('/marketplace/flows/acme-tools/soc-flows/flows/triage.json?source=acme%2Ftools');
    expect(view.flows.map((f) => f.name)).toEqual(['Triage digest', 'Alert triage']);
    expect(view.template).toMatchObject({ name: 'Alert triage', nodeCount: 2, credentials: [{ id: 'soc', name: 'SOC API', nodes: ['Node 1'] }] });
    expect(view.template.workflow.connections).toHaveLength(1);
    expect(view.templateId).toBeUndefined();
    expect((await marketplace.flow(id, 'soc-flows', 'extra/digest.json')).template.name).toBe('Triage digest');
    expect((await marketplace.detail(id, 'soc-flows')).flows[0].link).toBe('/marketplace/flows/acme-tools/soc-flows/extra/digest.json?source=acme%2Ftools');
    await expect(marketplace.flow('nope', 'soc-flows', 'flows/triage.json')).rejects.toMatchObject({ status: 404, body: { missing: 'marketplace' } });
    await expect(marketplace.flow(id, 'soc-flows', 'flows/broken.json')).rejects.toMatchObject({ status: 404 });
    await expect(marketplace.flow(id, 'soc-flows', '../x.json')).rejects.toMatchObject({ status: 404 });
  });

  it('serves the share page’s data over HTTP', async () => {
    const route = await import('@/app/api/marketplaces/[id]/plugins/[name]/flow/route');
    const call = (ref: string, query: string) => route.GET(new Request(`http://localhost/api/marketplaces/${ref}/plugins/soc-flows/flow${query}`), { params: Promise.resolve({ id: ref, name: 'soc-flows' }) });
    const ok = await call('acme-tools', '?path=flows%2Ftriage.json');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { flow: { template: { name: string } } }).flow.template.name).toBe('Alert triage');
    expect((await call('acme-tools', '')).status).toBe(400);
    const missing = await call('elsewhere', '?path=flows%2Ftriage.json');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ missing: 'marketplace' });
  });

  it('explores every marketplace at once: plugins, the Landflow plugins’ flows, and what couldn’t be read', async () => {
    const route = await import('@/app/api/marketplaces/explore/route');
    const response = await route.GET(new Request('http://localhost/api/marketplaces/explore'));
    expect(response.status).toBe(200);
    const result = (await response.json()) as ExploreResult;
    const acme = result.plugins.filter((p) => p.marketplace.id === id);
    expect(acme.map((p) => p.name)).toEqual(['reviewers', 'writing-skills', 'mcp-only', 'npm-thing', 'node-tools', 'soc-flows']);
    const byName = Object.fromEntries(acme.map((p) => [p.name, p]));
    // A marketplace this small has every supported plugin read; an unsupported source isn't.
    expect(byName.reviewers).toMatchObject({ installed: true, marketplace: { id, name: 'acme-tools' }, read: { agents: 2, skills: 1 } });
    expect(byName['node-tools'].read).toMatchObject({ nodePlugin: { id: 'acme-nodes', runtime: 'node' }, agents: 0, skills: 0 });
    expect(byName['npm-thing'].read).toBeUndefined();
    expect(byName['node-tools'].registered).toBeUndefined();
    expect(result.flows.map((f) => [f.plugin, f.name])).toEqual([
      ['soc-flows', 'Triage digest'],
      ['soc-flows', 'Alert triage'],
    ]);
    expect(result.flows[1]).toMatchObject({ marketplace: { id, name: 'acme-tools' }, pluginInstalled: false, needs: ['acme-soc.decide'], link: '/marketplace/flows/acme-tools/soc-flows/flows/triage.json?source=acme%2Ftools' });
    expect(result.flows[1].templateId).toBeUndefined();
    expect(result.categories).toEqual(['development', 'security']);
    // The official marketplace can't be fetched here: reported, not fatal.
    expect(result.errors).toEqual([expect.objectContaining({ marketplaceId: 'mk_anthropic_official' })]);
  });

  it('installs a flows-only plugin as templates and removes them on uninstall', async () => {
    const result = (await marketplace.install(id, 'soc-flows')) as InstallResult;
    expect((await marketplace.flow('acme-tools', 'soc-flows', 'flows/triage.json')).templateId).toBe(result.installed.templates![1].id);
    expect(result.installed.templates?.map((t) => t.name)).toEqual(['Triage digest', 'Alert triage']);
    const templates = result.installed.templates!.map((t) => localTemplates.get(t.id)!);
    expect(templates[1]).toMatchObject({
      author: 'soc-flows@acme-tools',
      categories: ['security', 'incident-response'],
      origin: { kind: 'marketplace', installedId: 'soc-flows@acme-tools', plugin: 'soc-flows', marketplace: 'acme-tools', path: 'flows/triage.json' },
    });
    expect(templates[1].projectId).toBeUndefined();
    expect((await marketplace.explore()).flows.find((f) => f.path === 'flows/triage.json')).toMatchObject({ pluginInstalled: true, templateId: result.installed.templates![1].id });
    expect(await marketplace.uninstall('soc-flows@acme-tools')).toEqual({ removed: { agents: 0, skills: 0, nodePlugin: false, flows: 2 } });
    for (const t of result.installed.templates!) expect(localTemplates.get(t.id)).toBeUndefined();
  });

  it('uninstalls exactly what the install created', async () => {
    const mine = agentStore.create({ name: 'Mine' });
    const installed = marketplace.installed().find((p) => p.id === 'reviewers@acme-tools')!;
    expect(await marketplace.uninstall('reviewers@acme-tools')).toEqual({ removed: { agents: 2, skills: 1, nodePlugin: false } });
    for (const agent of installed.agents) expect(agentStore.get(agent.id)).toBeUndefined();
    expect(agentStore.get(mine.id)).toBeDefined();
    expect(marketplace.skills().map((s) => s.name)).toEqual(['writing']);
    await marketplace.uninstall('writing-skills@acme-tools');
    expect(marketplace.skills()).toEqual([]);
    expect(marketplace.installed()).toEqual([]);
    marketplace.remove(id);
    expect(marketplace.list().map((m) => m.id)).toEqual(['mk_anthropic_official']);
    expect(() => marketplace.remove('mk_anthropic_official')).toThrow(/built in/);
    agentStore.delete(mine.id);
  });
});

// ---------------------------------------------------------------------------
// A node plugin built with the SDK, from a local marketplace.
// ---------------------------------------------------------------------------

describe('node plugins', () => {
  const root = mkdtempSync(join(tmpdir(), 'landflow-mkt-'));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  beforeAll(() => {
    process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL = '1';
    // Don't announce to a host that may be running on :3000.
    process.env.LANDFLOW_MARKETPLACE_REGISTRY_URL = 'off';
    clearTreeCache();
    write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'local-fixture', plugins: [{ name: 'echo-nodes', source: './echo' }] }));
    write('echo/landflow.plugin.json', JSON.stringify({ id: 'echo-nodes', runtime: 'node', start: ['tsx', 'main.ts'] }));
    write('echo/package.json', JSON.stringify({ name: 'echo-nodes', type: 'module', dependencies: { '@landflow/sdk': 'workspace:*' } }));
    write(
      'echo/main.ts',
      `import { definePlugin, defineNode } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
const Echo = defineNode({
  description: { name: 'echo', displayName: 'Echo', description: 'Returns its input', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) { return ctx.getInputData(); },
});
const plugin = definePlugin({ info: { id: 'echo-nodes', name: 'Echo nodes', version: '0.0.1' }, nodes: [Echo] });
await serve(plugin, { http: 1 });
`,
    );
  });
  afterAll(() => {
    delete process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL;
    delete process.env.LANDFLOW_MARKETPLACE_REGISTRY_URL;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('counts a port held on every interface as taken', async () => {
    // macOS lets 127.0.0.1 bind beside a wildcard listener, so a loopback-only probe handed out busy ports.
    const held = createServer();
    await new Promise<void>((done) => held.listen(0, done));
    const { port } = held.address() as AddressInfo;
    try {
      expect(await portFree(port)).toBe(false);
    } finally {
      await new Promise((done) => held.close(done));
    }
    expect(await portFree(port)).toBe(true);
  });

  it('points a Go plugin’s relative SDK replace at the host’s copy', () => {
    write(
      'go-tools/go.mod',
      `module example.com/go-tools

go 1.22

require github.com/landflow/landflow/sdks/go v0.0.0

replace github.com/landflow/landflow/sdks/go => ../../sdks/go
replace example.com/other => ../other
`,
    );
    expect(linkGoSdk(join(root, 'go-tools'))).toBe(1);
    const mod = readFileSync(join(root, 'go-tools', 'go.mod'), 'utf8');
    expect(mod).toMatch(/replace github\.com\/landflow\/landflow\/sdks\/go => \/.+\/sdks\/go\n/);
    expect(mod).toContain('replace example.com/other => ../other');
    expect(linkGoSdk(join(root, 'go-tools'))).toBe(0);
    expect(linkGoSdk(join(root, 'echo'))).toBe(0);
  });

  it('reads a local plugin directory', async () => {
    const loaded = await loadPlugin(readerFor({ kind: 'local', root, path: 'echo' }), { name: 'echo-nodes' });
    expect(loaded.nodePlugin).toEqual({ id: 'echo-nodes', runtime: 'node', start: ['tsx', 'main.ts'] });
    expect(() => readerFor({ kind: 'local', root, path: '../..' })).toThrow(/escapes/);
  });

  it('downloads, links the SDK, runs, and stops the plugin on uninstall', { timeout: 60_000 }, async () => {
    const added = await marketplace.add(root);
    const result = (await marketplace.install(added.id, 'echo-nodes', { confirm: true })) as InstallResult;
    const node = result.installed.nodePlugin!;
    expect(node).toMatchObject({ pluginId: 'echo-nodes', command: 'tsx main.ts' });
    expect(node.port).toBeGreaterThanOrEqual(7250);
    expect(existsSync(join(node.dir, 'node_modules', '@landflow', 'sdk'))).toBe(true);
    // The process serves the plugin protocol on the port the host gave it.
    let health: { pluginId?: string } | undefined;
    for (let i = 0; i < 100 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${node.port}/landflow/v1/health`)
        .then((r) => (r.ok ? (r.json() as Promise<{ pluginId: string }>) : undefined))
        .catch(() => undefined);
      if (!health) await new Promise((r) => setTimeout(r, 300));
    }
    expect(health?.pluginId).toBe('echo-nodes');
    expect(marketplace.installed()[0].nodePlugin?.status?.state).toBe('running');
    expect(marketplace.logs('echo-nodes@local-fixture').join('\n')).toContain('$ ');

    expect(await marketplace.uninstall('echo-nodes@local-fixture')).toEqual({ removed: { agents: 0, skills: 0, nodePlugin: true } });
    expect(existsSync(node.dir)).toBe(false);
    const after = await fetch(`http://127.0.0.1:${node.port}/landflow/v1/health`).then(
      () => 'up',
      () => 'down',
    );
    expect(after).toBe('down');
    marketplace.remove(added.id);
    expect(marketplaceStore.installed()).toEqual([]);
  });
});
