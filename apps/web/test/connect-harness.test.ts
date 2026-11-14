/**
 * Connect your harness (docs/connect-your-harness.md): the setup text for each harness, the key the page makes (who may
 * create which scopes), the admin's switch that forbids automatic sending, and the markup of the page's three steps and
 * the four collapsed MCP sections.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConnectSteps } from '@/components/connect/connect-harness';
import { HARNESS_IDS, KEY_PLACEHOLDER, harnessKeyBody, originOf, snippetFor, toolNames } from '@/components/connect/harness-snippets';
import { McpSections } from '@/components/settings/mcp-sections';
import { TOOL_SCOPES } from '@/lib/shared/mcp';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-connect-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { scopeRefusal } = await import('@/lib/server/auth/api-keys');
const keysRoute = await import('@/app/api/api-keys/route');
const settingsRoute = await import('@/app/api/settings/route');

const owner = await createUser({ email: 'owner@connect.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const member = await createUser({ email: 'mia@connect.test', name: 'Mia', role: 'member', password: 'member-password-1' });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const URL_ = 'https://landflow.example.test/api/mcp';
const TOKEN = 'lf_made-up-test-key-0123456789';
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const makeKey = async (body: unknown) => keysRoute.POST(req('POST', '/api/api-keys', body));

describe('snippets', () => {
  it('every harness puts the URL and the key in, the key once per snippet', () => {
    for (const id of HARNESS_IDS) {
      const snippets = snippetFor(id, { url: URL_, token: TOKEN });
      expect(snippets.length).toBeGreaterThan(0);
      for (const s of snippets) {
        expect(occurrences(s.text, TOKEN), `${id}: ${s.label}`).toBeLessThanOrEqual(1);
        if (s.label !== 'The landflow-brain mod') expect(s.text).toContain(s.label === 'The mod’s options' ? 'https://landflow.example.test\n' : URL_);
      }
      expect(snippets.filter((s) => s.text.includes(TOKEN)).length).toBeGreaterThan(0);
      expect(snippets.map((s) => s.text).join('\n')).not.toContain(KEY_PLACEHOLDER);
    }
  });

  it('shows a placeholder until a key is made', () => {
    for (const id of HARNESS_IDS) expect(snippetFor(id, { url: URL_ }).some((s) => s.text.includes(KEY_PLACEHOLDER))).toBe(true);
  });

  it('claude-code: the command, a .mcp.json entry that parses, the mod and its options', () => {
    const [command, file, mod, options] = snippetFor('claude-code', { url: URL_, token: TOKEN });
    expect(command?.text).toBe(`claude mcp add --transport http landflow ${URL_} --header "Authorization: Bearer ${TOKEN}"`);
    expect(JSON.parse(file!.text)).toEqual({ mcpServers: { landflow: { type: 'http', url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    expect(mod?.text).toBe('claude plugin install apps/web/claude-plugins/landflow-brain');
    expect(options?.text).toBe(`url: https://landflow.example.test\nkey: ${TOKEN}\nrepos: owner/name\nmode: review`);
  });

  it('the JSON harnesses parse, each in its own shape', () => {
    const header = { Authorization: `Bearer ${TOKEN}` };
    expect(JSON.parse(snippetFor('cursor', { url: URL_, token: TOKEN })[0]!.text)).toEqual({ mcpServers: { landflow: { url: URL_, headers: header } } });
    expect(JSON.parse(snippetFor('gemini', { url: URL_, token: TOKEN })[0]!.text)).toEqual({ mcpServers: { landflow: { httpUrl: URL_, headers: header } } });
    expect(JSON.parse(snippetFor('vscode', { url: URL_, token: TOKEN })[0]!.text)).toEqual({ servers: { landflow: { type: 'http', url: URL_, headers: header } } });
    expect(JSON.parse(snippetFor('generic', { url: URL_, token: TOKEN })[1]!.text)).toEqual({ mcpServers: { landflow: { type: 'http', url: URL_, headers: header } } });
  });

  it('codex is a TOML table with a quoted URL and an inline header table', () => {
    // No TOML parser is a dependency here, so the three lines are checked by their shape.
    const lines = snippetFor('codex', { url: URL_, token: TOKEN })[0]!.text.split('\n');
    expect(lines).toEqual(['[mcp_servers.landflow]', `url = "${URL_}"`, `http_headers = { Authorization = "Bearer ${TOKEN}" }`]);
  });

  it('the origin comes off the endpoint, and tools/list answers read as JSON or as an event', () => {
    expect(originOf('http://localhost:3000/api/mcp')).toBe('http://localhost:3000');
    expect(originOf('http://localhost:3000/api/mcp/')).toBe('http://localhost:3000');
    const answer = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'my_briefing' }, { name: 'record_work' }] } };
    expect(toolNames(JSON.stringify(answer))).toEqual(['my_briefing', 'record_work']);
    expect(toolNames(`event: message\ndata: ${JSON.stringify(answer)}\n\n`)).toEqual(['my_briefing', 'record_work']);
    expect(toolNames('<html>')).toBeUndefined();
  });
});

describe('the key', () => {
  it('the page asks for the brain scopes, 90 days, and what was ticked', () => {
    expect(harnessKeyBody('claude-code')).toEqual({ label: 'Harness · Claude Code', scopes: ['brain:read', 'brain:write'], expiresInDays: 90 });
    expect(harnessKeyBody('cursor', ['workflows:read', 'run']).scopes).toEqual(['brain:read', 'brain:write', 'workflows:read', 'run']);
  });

  it('refuses admin and SCIM scopes to a member, with the reason; allows the rest', () => {
    expect(scopeRefusal({ role: 'member' }, ['brain:read', 'brain:write'])).toBeUndefined();
    expect(scopeRefusal({ role: 'member' }, ['workflows:read', 'workflows:write', 'run', 'executions:read'])).toBeUndefined();
    expect(scopeRefusal({ role: 'member' }, ['admin'])).toMatchObject({ status: 403, reason: expect.stringContaining('admin scope') });
    expect(scopeRefusal({ role: 'member' }, ['scim'])).toMatchObject({ status: 403 });
    expect(scopeRefusal({ role: 'admin' }, ['admin', 'run'])).toBeUndefined();
    expect(scopeRefusal({ role: 'owner' }, ['scim', 'run'])).toMatchObject({ status: 400 });
  });

  it('a member creates a brain key and a workflows:read key, not an admin one; an owner may', async () => {
    enableTestAuth(member);
    const brain = await makeKey(harnessKeyBody('claude-code'));
    expect(brain.status).toBe(201);
    const body = (await brain.json()) as { token: string; key: { scopes: string[]; label: string; expiresAt?: string } };
    expect(body.token).toMatch(/^lf_/);
    expect(body.key).toMatchObject({ label: 'Harness · Claude Code', scopes: ['brain:read', 'brain:write'] });
    expect(body.key.expiresAt).toBeTruthy();
    expect((await makeKey(harnessKeyBody('cursor', ['workflows:read', 'run']))).status).toBe(201);
    const refused = await makeKey({ label: 'Mine', scopes: ['admin'] });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain('Only owners and admins');
    enableTestAuth(owner);
    expect((await makeKey({ label: 'Everything', scopes: ['admin'] })).status).toBe(201);
  });
});

describe('the admin switch', () => {
  it('round-trips through settings, and a member may not set it', async () => {
    enableTestAuth(owner);
    const read = async () => ((await (await settingsRoute.GET(req('GET', '/api/settings'))).json()) as { settings: { brain?: { workAutoSend: string } } }).settings.brain?.workAutoSend ?? 'allowed';
    expect(await read()).toBe('allowed');
    expect((await settingsRoute.PATCH(req('PATCH', '/api/settings', { brain: { workAutoSend: 'forbidden' } }))).status).toBe(200);
    expect(await read()).toBe('forbidden');
    enableTestAuth(member);
    expect((await settingsRoute.PATCH(req('PATCH', '/api/settings', { brain: { workAutoSend: 'allowed' } }))).status).toBe(403);
    expect(await read()).toBe('forbidden');
    enableTestAuth(owner);
    expect((await settingsRoute.PATCH(req('PATCH', '/api/settings', { brain: { workAutoSend: 'allowed' } }))).status).toBe(200);
    expect(await read()).toBe('allowed');
  });
});

describe('markup', () => {
  const ESCAPED_PLACEHOLDER = KEY_PLACEHOLDER.replace('<', '&lt;').replace('>', '&gt;');
  const steps = (props: Partial<Parameters<typeof ConnectSteps>[0]> = {}) =>
    renderToStaticMarkup(createElement(ConnectSteps, { harness: 'claude-code', onHarness() {}, scopes: [], onScopes() {}, days: 90, onDays() {}, onMake() {}, making: false, mcpUrl: URL_, onTest() {}, testing: false, ...props }));

  it('the page has three steps, one per section, and every harness card', () => {
    const html = steps();
    for (const label of ['Pick your harness', 'Make a key', 'Copy the setup']) expect(html).toContain(label);
    expect(html.match(/<section /g)).toHaveLength(3);
    for (const label of ['Claude Code', 'Cursor', 'Codex CLI', 'Gemini CLI', 'VS Code', 'Any MCP client']) expect(html).toContain(label);
    expect(html).toContain('Read workflows');
    expect(html).toContain('Test connection');
    expect(html).toContain(ESCAPED_PLACEHOLDER);
  });

  it('with a key, the setup holds it and the test button is on', () => {
    const html = steps({ token: TOKEN, test: { ok: true, message: 'Connected: 25 tools' } });
    expect(html).toContain(TOKEN);
    expect(html).not.toContain(ESCAPED_PLACEHOLDER);
    expect(html).toContain('Connected: 25 tools');
    expect(html).not.toContain('<button disabled=""');
  });

  it('MCP settings is four collapsed sections, and the switch row is for admins', () => {
    const page = (canManage: boolean) => renderToStaticMarkup(createElement(McpSections, { canManage, gatewayMode: 'off', access: 'ACCESS', clients: 'CLIENTS', tools: 'TOOLS', gateway: 'GATEWAY' }));
    const html = page(true);
    for (const title of ['Access token', 'Connected clients', 'Tools', 'Gateway']) expect(html).toContain(title);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(4);
    expect(html.match(/Learn more/g)).toHaveLength(4);
    for (const body of ['ACCESS', 'CLIENTS', 'TOOLS', 'GATEWAY']) expect(html).not.toContain(body);
    expect(html).toContain(`${Object.keys(TOOL_SCOPES).length} tools`);
    expect(html).toContain('Work from local tools');
    expect(page(false)).not.toContain('Work from local tools');
  });

  it('a waiting approval opens Tools and says so on its header', () => {
    const html = renderToStaticMarkup(createElement(McpSections, { canManage: true, gatewayMode: 'off', pendingApprovals: 2, access: 'ACCESS', clients: 'CLIENTS', tools: 'TOOLS', gateway: 'GATEWAY' }));
    expect(html).toContain('2 waiting for approval');
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toContain('TOOLS');
    expect(html).not.toContain('ACCESS');
  });
});
