/**
 * GitHub's MCP server as an agent's tool (lib/server/mcp/github.ts, docs/a2a.md): a fake server that lists the real tool names
 * of github-mcp-server v2.0.2 (merge, push and the rest included), reached through a Bearer Auth credential from the vault.
 * Read gets the read tools, review adds the review and comment ones, and nothing that merges or writes code is ever offered.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Agent, AgentConfig, McpServerToolConfig } from '@/lib/shared/agents';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-github-mcp-'));
const previous = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { closeMcpClients } = await import('@/lib/server/mcp/client');
const { buildToolset } = await import('@/lib/server/agents/tools');
const { kagentTools } = await import('@/lib/server/kagent/deploy');
const { agentConnections } = await import('@/lib/server/agents/connections');
const { GITHUB_NEVER_TOOLS, GITHUB_READ_TOOLS, GITHUB_REVIEW_TOOLS, githubAllowedTools, githubMcpUrl } = await import('@/lib/server/mcp/github');
const { agentStore } = await import('@/lib/server/agents/store');
registry.registerBuiltin(corePlugin);

// Stands in for the GitHub token: Landflow sends it as the bearer, the server never sees anything else.
const TOKEN = 'ghp_' + 'x'.repeat(36);
const LISTED = [...GITHUB_READ_TOOLS, ...GITHUB_REVIEW_TOOLS, ...GITHUB_NEVER_TOOLS, 'get_me', 'star_repository', 'dismiss_notification'];
const called: string[] = [];
const seen: Array<string | undefined> = [];

function fakeGithub() {
  const server = new McpServer({ name: 'github-mcp-server', version: 'v2.0.2' });
  for (const name of LISTED) {
    server.registerTool(name, { description: `fake ${name}` }, async () => {
      called.push(name);
      return { content: [{ type: 'text', text: `${name} ok` }] };
    });
  }
  return server;
}

const handler = createMcpHandler(() => fakeGithub());
let origin = '';
const remote = createServer(async (req, res) => {
  seen.push(req.headers.authorization);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const response = await handler.fetch(new Request(`${origin}${req.url}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeMcpClients();
  await handler.close();
  remote.closeAllConnections();
  await new Promise<void>((resolve) => remote.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});

const credential = () => credentials.create({ name: 'GitHub token', type: 'core.httpBearerAuth', data: { token: TOKEN } });

function githubTool(access: McpServerToolConfig['access'] | undefined, extra: Partial<McpServerToolConfig> = {}): McpServerToolConfig {
  const c = credential();
  return {
    id: `tool_gh_${access}`,
    type: 'mcp',
    name: 'GitHub MCP',
    preset: 'github',
    ...(access && { access }),
    // The agent's own settings can't widen it: these filters are ignored for the preset.
    parameters: { endpointUrl: origin + '/', include: 'all' },
    credentials: { httpBearerAuth: { id: c.id, name: c.name } },
    ...extra,
  };
}

const agentWith = (tools: AgentConfig['tools']) => {
  const config = { name: 'Reviewer', skills: [], memory: { crossSession: false }, settings: {}, tools } as unknown as AgentConfig;
  return { agent: { id: 'ag_gh', ...config } as unknown as Agent, config };
};

describe('the allow-lists', () => {
  it('keep every merge, push and code-writing tool out of both levels', () => {
    for (const access of ['read', 'review', undefined, 'bogus']) {
      const allowed = githubAllowedTools(access);
      for (const never of GITHUB_NEVER_TOOLS) expect(allowed.has(never), `${never} at ${String(access)}`).toBe(false);
      expect(allowed.has('merge_pull_request')).toBe(false);
      expect(allowed.has('create_or_update_file')).toBe(false);
    }
    expect(GITHUB_READ_TOOLS.some((n) => GITHUB_NEVER_TOOLS.includes(n))).toBe(false);
    expect(GITHUB_REVIEW_TOOLS.some((n) => GITHUB_NEVER_TOOLS.includes(n))).toBe(false);
  });

  it('give review only the read tools plus the review ones, and anything unknown the read level', () => {
    expect(githubAllowedTools('read').has('pull_request_review_write')).toBe(false);
    expect(githubAllowedTools('review').has('pull_request_review_write')).toBe(true);
    expect(githubAllowedTools('review').has('add_comment_to_pending_review')).toBe(true);
    expect([...githubAllowedTools('review')].sort()).toEqual([...GITHUB_READ_TOOLS, ...GITHUB_REVIEW_TOOLS].sort());
    expect(githubAllowedTools('anything')).toEqual(githubAllowedTools('read'));
  });

  it('name the bundled server by default', () => {
    expect(githubMcpUrl()).toBe('http://landflow-github-mcp:8082/');
  });
});

describe('an agent with GitHub MCP', () => {
  it('read: only the read tools, though the server lists many more', async () => {
    const { agent, config } = agentWith([githubTool('read')]);
    const { tools, unavailable } = await buildToolset(agent, config);
    expect(unavailable).toEqual([]);
    expect(tools.map((t) => t.name).sort()).toEqual([...GITHUB_READ_TOOLS].sort());
    expect(tools[0]).toMatchObject({ kind: 'node', nodeType: 'core.mcpClientTool' });
    expect(seen.every((h) => h === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('defaults to read when no access is set', async () => {
    const { agent, config } = agentWith([githubTool(undefined)]);
    const { tools } = await buildToolset(agent, config);
    expect(tools.map((t) => t.name).sort()).toEqual([...GITHUB_READ_TOOLS].sort());
  });

  it('review: read plus review and comment tools, never merge or write', async () => {
    const { agent, config } = agentWith([githubTool('review')]);
    const { tools } = await buildToolset(agent, config);
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([...GITHUB_READ_TOOLS, ...GITHUB_REVIEW_TOOLS].sort());
    for (const never of [...GITHUB_NEVER_TOOLS, 'star_repository']) expect(names).not.toContain(never);
    const review = tools.find((t) => t.name === 'add_comment_to_pending_review')!;
    expect(await review.invoke({}, {} as Parameters<typeof review.invoke>[1])).toEqual({ output: 'add_comment_to_pending_review ok' });
    expect(called).toContain('add_comment_to_pending_review');
    expect(called).not.toContain('merge_pull_request');
  });

  it('cannot widen the list with include settings, and sends the credential as a bearer even if the settings say otherwise', async () => {
    const { agent, config } = agentWith([githubTool('read', { parameters: { endpointUrl: origin + '/', include: 'selected', includeTools: ['merge_pull_request'], authentication: 'none' } })]);
    const { tools, unavailable } = await buildToolset(agent, config);
    expect(unavailable).toEqual([]);
    expect(tools.map((t) => t.name)).not.toContain('merge_pull_request');
    expect(tools.map((t) => t.name).sort()).toEqual([...GITHUB_READ_TOOLS].sort());
  });

  it('serves kagent the same cut (the agents’ MCP endpoint builds its tools with kagentTools)', async () => {
    const { agent, config } = agentWith([githubTool('review')]);
    const { tools } = await kagentTools(agent, config);
    expect(tools.map((t) => t.name)).toContain('pull_request_review_write');
    expect(tools.map((t) => t.name)).not.toContain('merge_pull_request');
  });

  it('is a notice, not tools, without a working credential', async () => {
    const bad = credentials.create({ name: 'Wrong', type: 'core.httpBearerAuth', data: { token: 'nope' } });
    const { agent, config } = agentWith([githubTool('read', { credentials: { httpBearerAuth: { id: bad.id, name: bad.name } } })]);
    const { tools, unavailable } = await buildToolset(agent, config);
    expect(tools).toEqual([]);
    expect(unavailable[0]).toMatch(/^GitHub MCP:/);
  });
});

describe('Run Trace connections', () => {
  it('shows GitHub MCP with the GitHub mark and what it is for', () => {
    const reviewer = agentStore.publish(agentStore.create({ name: 'Reviewer', tools: [githubTool('review')] }).id)!;
    const reader = agentStore.publish(agentStore.create({ name: 'Planner', tools: [githubTool('read')] }).id)!;
    expect(agentConnections(reviewer, { model: true })).toEqual([{ kind: 'tool', name: 'GitHub MCP', detail: 'Tool · pull requests, reviews, line comments', icon: 'brand:github', from: 'agent' }]);
    expect(agentConnections(reader, { model: true })[0]).toMatchObject({ name: 'GitHub MCP', icon: 'brand:github', detail: expect.stringContaining('read only') });
  });
});
