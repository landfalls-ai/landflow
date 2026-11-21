/**
 * Connect your harness (docs/connect-your-harness.md): the setup text for each harness, the key the page makes (who may
 * create which scopes), the admin's switch that forbids automatic sending, and the markup of the page's three steps and
 * the four collapsed MCP sections.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConnectSteps } from '@/components/connect/connect-harness';
import { HARNESS_IDS, HARNESSES, KEY_PLACEHOLDER, harnessKeyBody, hookKeyBody, hookFilterScript, hookKeySnippet, hookSnippetFor, originOf, sendsStatus, snippetFor, toolNames } from '@/components/connect/harness-snippets';
import { McpSections } from '@/components/settings/mcp-sections';
import { HARNESS_REGISTRY } from '@landflow/protocol/harnesses';
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

describe('snippets: unchanged by the registry (C15 AS-2)', () => {
  it('all six harnesses give the same text as before the list moved to the registry', () => {
    for (const id of HARNESS_IDS) expect(snippetFor(id, { url: URL_, token: TOKEN })).toMatchSnapshot(id);
  });
});

describe('hookSnippetFor (C04)', () => {
  type Block = { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; async?: boolean }> }>> };
  const parse = (text: string) => (JSON.parse(text) as Block).hooks;
  it('one background command hook per event the registry lists, holding no key', () => {
    const snippet = hookSnippetFor({ url: URL_ });
    const block = parse(snippet.text);
    expect(Object.keys(block)).toEqual(Object.keys(HARNESS_REGISTRY.find((h) => h.id === 'claude-code')!.hookEvents!));
    for (const [event, groups] of Object.entries(block)) {
      const hook = groups[0]!.hooks[0]!;
      expect(hook.type, event).toBe('command');
      expect(hook.async, event).toBe(true);
      expect(hook.command, event).toMatch(/^node -e '/);
      expect(hook.command, event).toContain('https://landflow.example.test/api/harness/claude-code/hooks');
      expect(hook.command, event).toContain('process.env["LANDFLOW_HOOK_KEY"]');
      expect(hook.command, event).not.toContain('lf_');
      expect(hook.command.slice(9, -1), event).not.toContain("'");
    }
    expect(snippet.where).toContain('settings.local.json');
    expect(snippet.where).toMatch(/Never into the committed/);
  });
  it('the key goes in an environment variable line, with the placeholder until one is made', () => {
    expect(hookKeySnippet(TOKEN).text).toBe(`export LANDFLOW_HOOK_KEY=${TOKEN}`);
    expect(hookKeySnippet().text).toContain(KEY_PLACEHOLDER);
  });
  it('the hooks key may send live status and nothing else; the page key never has that scope', () => {
    expect(hookKeyBody()).toEqual({ label: 'Harness · Claude Code live status', scopes: ['harness:write'], expiresInDays: 30 });
    expect(harnessKeyBody('claude-code', ['harness:write', 'run']).scopes).toEqual(['brain:read', 'brain:write', 'run']);
    expect(sendsStatus('claude-code')).toBe(true);
    for (const h of HARNESSES.filter((x) => x.id !== 'claude-code')) expect(sendsStatus(h.id), h.id).toBe(false);
  });

  /** Runs the generated command for real: node reads an event on stdin and posts to a local server. */
  async function run(event: Record<string, unknown>, agentId?: string, env: Record<string, string> = { LANDFLOW_HOOK_KEY: 'lf_filter_test_key' }) {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      let data = '';
      request.on('data', (c) => (data += c));
      request.on('end', () => {
        received.push({ headers: request.headers, body: JSON.parse(data) });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const command = parse(hookSnippetFor({ url: `http://127.0.0.1:${port}/api/mcp`, ...(agentId && { agentId }) }).text).PreToolUse![0]!.hooks[0]!.command;
    await new Promise<void>((resolve) => {
      const child = spawn('sh', ['-c', command], { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', () => resolve());
      child.stdin.end(JSON.stringify(event));
    });
    await new Promise((resolve) => server.close(resolve));
    return received;
  }
  const FULL = { hook_event_name: 'PreToolUse', session_id: 's-1', tool_name: 'Bash', tool_input: { command: 'cat ~/secret.txt' }, tool_response: { out: 'top secret' }, prompt: 'my private prompt', cwd: '/Users/someone/project', transcript_path: '/Users/someone/.claude/t.jsonl', agent_type: 'code-reviewer:code-reviewer', permission_mode: 'default', duration_ms: 12 };

  it('the filter forwards names and ids only: no prompt, tool input or output, cwd, transcript path or agent_type', async () => {
    const [sent] = await run(FULL);
    expect(sent?.body).toEqual({ hook_event_name: 'PreToolUse', session_id: 's-1', tool_name: 'Bash', duration_ms: 12 });
    expect(JSON.stringify(sent?.body)).not.toMatch(/secret|private|someone|code-reviewer/);
    expect(sent?.headers.authorization).toBe('Bearer lf_filter_test_key');
    expect(sent?.headers['x-landflow-agent']).toBeUndefined();
    expect(sent?.headers['x-landflow-hook-seq']).toMatch(/^\d{10,18}$/);
  });
  it('an own session sends the error but not its details; an agent session sends both, cut to 300 characters', async () => {
    const event = { hook_event_name: 'StopFailure', session_id: 's-2', error: 'rate_limit', error_details: 'x'.repeat(900), last_assistant_message: 'a long reply' };
    const [own] = await run(event);
    expect(own?.body).toEqual({ hook_event_name: 'StopFailure', session_id: 's-2', error: 'rate_limit' });
    const [bound] = await run(event, 'agent_abc123');
    expect((bound?.body.error_details as string).length).toBe(300);
    expect(bound?.body.last_assistant_message).toBeUndefined();
  });
  it('forwards only strings and finite numbers: objects, arrays, booleans and null are dropped', async () => {
    const [sent] = await run({ hook_event_name: 'PostToolUse', session_id: 's-3', tool_name: { name: 'x' }, notification_type: ['a'], duration_ms: 12.5, error: true });
    expect(sent?.body).toEqual({ hook_event_name: 'PostToolUse', session_id: 's-3', duration_ms: 12.5 });
    const [none] = await run({ hook_event_name: 'PostToolUse', session_id: 's-4', duration_ms: null, error: 5 });
    expect(none?.body).toEqual({ hook_event_name: 'PostToolUse', session_id: 's-4', error: 5 });
  });
  it('refuses an origin or agent id a shell command could not carry', () => {
    for (const bad of ["https://x.test'; rm -rf ~; '", 'https://x.test/path', 'https://x.test ', 'not a url', 'https://x.test/']) expect(() => hookFilterScript(bad), bad).toThrow();
    for (const bad of ["a'b", 'a b', '', 'x'.repeat(101), 'a;b']) expect(() => hookFilterScript('https://x.test', bad), bad).toThrow();
    expect(() => hookFilterScript('https://x.test:8443', 'agent_abc-123')).not.toThrow();
  });
  it('picking an agent adds its id as a header and nothing else', async () => {
    const [sent] = await run(FULL, 'agent_abc123');
    expect(sent?.headers['x-landflow-agent']).toBe('agent_abc123');
    expect(sent?.body).not.toHaveProperty('agent_type');
  });
  it('parallel hooks get different order numbers', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => run({ ...FULL, session_id: `p-${i}` })));
    const seqs = runs.map((r) => r[0]?.headers['x-landflow-hook-seq']);
    expect(new Set(seqs).size).toBe(6);
  });
  it('exits quietly and sends nothing for input that is not JSON', async () => {
    const received = await run({ hook_event_name: 'PreToolUse', session_id: 'ok' });
    expect(received).toHaveLength(1);
  });
});

describe('snippets', () => {
  it('every harness puts the URL and the key in, the key once per snippet', () => {
    for (const id of HARNESS_IDS) {
      const snippets = snippetFor(id, { url: URL_, token: TOKEN });
      expect(snippets.length).toBeGreaterThan(0);
      for (const s of snippets) {
        expect(occurrences(s.text, TOKEN), `${id}: ${s.label}`).toBeLessThanOrEqual(1);
        if (s.label !== 'The landflow-brain mod' && s.label !== 'Or from a checkout') expect(s.text).toContain(s.label === 'The mod’s options' ? 'https://landflow.example.test\n' : URL_);
      }
      expect(snippets.filter((s) => s.text.includes(TOKEN)).length).toBeGreaterThan(0);
      expect(snippets.map((s) => s.text).join('\n')).not.toContain(KEY_PLACEHOLDER);
    }
  });

  it('shows a placeholder until a key is made', () => {
    for (const id of HARNESS_IDS) expect(snippetFor(id, { url: URL_ }).some((s) => s.text.includes(KEY_PLACEHOLDER))).toBe(true);
  });

  it('claude-code: the command, a .mcp.json entry that parses, the mod (marketplace, or a checkout) and its options', () => {
    const [command, file, mod, checkout, options] = snippetFor('claude-code', { url: URL_, token: TOKEN });
    expect(command?.text).toBe(`claude mcp add --transport http landflow ${URL_} --header "Authorization: Bearer ${TOKEN}"`);
    expect(JSON.parse(file!.text)).toEqual({ mcpServers: { landflow: { type: 'http', url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } } });
    expect(mod?.text).toBe('claude plugin marketplace add landfalls-ai/landflow\nclaude plugin install landflow-brain');
    expect(checkout?.text).toBe('claude plugin install apps/web/claude-plugins/landflow-brain');
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

  it('the page has three steps, one per section, and every harness card; Claude Code adds the live status step', () => {
    const html = steps({ harness: 'cursor' });
    for (const label of ['Pick your harness', 'Make a key', 'Copy the setup']) expect(html).toContain(label);
    expect(html.match(/<section /g)).toHaveLength(3);
    expect(html).not.toContain('Live status');
    const claude = steps({ sessions: [] });
    expect(claude.match(/<section /g)).toHaveLength(4);
    for (const text of ['Live status (optional)', 'Make a hook key', 'LANDFLOW_HOOK_KEY', 'settings.local.json', 'Your sessions', 'No open sessions yet']) expect(claude).toContain(text);
    for (const label of ['Claude Code', 'Cursor', 'Codex CLI', 'Gemini CLI', 'VS Code', 'Any MCP client']) expect(html).toContain(label);
    expect(html).toContain('Read workflows');
    expect(html).toContain('Test connection');
    expect(html).toContain(ESCAPED_PLACEHOLDER);
  });

  it('with a key, the setup holds it and the test button is on', () => {
    const html = steps({ harness: 'cursor', token: TOKEN, test: { ok: true, message: 'Connected: 25 tools' } });
    expect(html).toContain(TOKEN);
    expect(html).not.toContain(ESCAPED_PLACEHOLDER);
    expect(html).toContain('Connected: 25 tools');
    expect(html).not.toContain('<button disabled=""');
    // A long result wraps inside the card instead of running past it.
    const long = steps({ token: TOKEN, test: { ok: false, message: `Refused: ${'x'.repeat(200)}` } });
    expect(long).toMatch(/role="status" class="[^"]*min-w-0[^"]*\[overflow-wrap:anywhere\]/);
  });

  it('the Approvals card shows what the page polled: it fetches nothing itself', async () => {
    const { ApprovalsCard } = await import('@/components/settings/mcp-grants');
    const approval = { id: 'ap_1', tool: 'delete_rows', pluginId: 'tables', caller: 'Alice', summary: 'Delete 3 rows', status: 'pending', canDecide: true, createdAt: new Date().toISOString() };
    const html = renderToStaticMarkup(createElement(ApprovalsCard, { approvals: [approval] as never, load: async () => undefined }));
    expect(html).toContain('1 waiting');
    expect(html).toContain('delete_rows');
  });

  it('MCP settings is four collapsed sections, and the switch row is for admins', () => {
    const page = (canManage: boolean) => renderToStaticMarkup(createElement(McpSections, { canManage, gatewayMode: 'off', access: 'ACCESS', clients: 'CLIENTS', tools: 'TOOLS', gateway: 'GATEWAY' }));
    const html = page(true);
    for (const title of ['Access token', 'Connected clients', 'Tools', 'Gateway']) expect(html).toContain(title);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(4);
    expect(html.match(/Learn more/g)).toHaveLength(4);
    for (const body of ['ACCESS', 'CLIENTS', 'TOOLS', 'GATEWAY']) expect(html).not.toContain(body);
    expect(html).toContain(`${Object.keys(TOOL_SCOPES).length} instance tools`);
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
