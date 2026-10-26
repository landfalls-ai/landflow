#!/usr/bin/env node
// agentgateway spike (docs/transports.md, phase 0; findings in docs/mcp-gateway.md).
//
// Runs end to end against the mcp-gateway profile of deploy/compose.infra.yml and prints PASS / FAIL per check:
//   - two fake MCP upstream servers (Streamable HTTP) on 127.0.0.1:7600 (stateless) and :7601 (stateful, can emit
//     notifications/tools/list_changed), each recording the headers it receives; the gateway reaches them through
//     host.docker.internal;
//   - targets registered, listed, updated and deleted through the admin config API (mcp.target), with backendAuth and
//     CEL header transformations, and the time until a change shows in tools/list;
//   - tools/list and tools/call through http://127.0.0.1:54000/mcp, the headers the upstream sees;
//   - list-changed notifications (subscriptions/listen, the GET SSE stream; --stateful: the same with statefulMode: stateful);
//   - protocol versions negotiated with the client (2026-07-28 style without initialize, classic initialize) and the
//     upstream;
//   - --auth: mcpAuthentication against Keycloak (profile auth), a realm it creates and deletes (landflow-mcp-test*),
//     protected resource metadata, identity headers from the token, an mcpAuthorization rule;
//   - --file: the file fallback (storage mode file), targets edited in the mounted file, reload time.
//
//   node deploy/scripts/mcp-gateway-spike.mjs                  # core checks (needs the mcp-gateway profile up)
//   node deploy/scripts/mcp-gateway-spike.mjs --all            # core + stateful + auth + file (restarts the gateway container)
//   node deploy/scripts/mcp-gateway-spike.mjs --auth --file    # a subset
//   node deploy/scripts/mcp-gateway-spike.mjs --keep           # leave the fake upstreams and the targets in place
//
// Node 22, no dependencies: the fake upstreams and the client are raw JSON-RPC over fetch/http (the installed MCP SDK
// 1.32 does not speak 2026-07-28 yet).

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const args = new Set(process.argv.slice(2));
const runAll = args.has('--all');
const chosen = ['--core', '--stateful', '--auth', '--file'].some((f) => args.has(f));
const phases = { core: runAll || args.has('--core') || !chosen, stateful: runAll || args.has('--stateful'), auth: runAll || args.has('--auth'), file: runAll || args.has('--file') };
const keep = args.has('--keep');

const GATEWAY = process.env.LANDFLOW_MCP_GATEWAY_URL ?? 'http://127.0.0.1:54000';
const ADMIN = process.env.LANDFLOW_MCP_GATEWAY_ADMIN_URL ?? 'http://127.0.0.1:55000';
const KEYCLOAK = process.env.LANDFLOW_KEYCLOAK_URL ?? 'http://localhost:58080';
const KC_ADMIN = process.env.LANDFLOW_KEYCLOAK_ADMIN ?? 'admin';
const KC_ADMIN_PASSWORD = process.env.LANDFLOW_KEYCLOAK_ADMIN_PASSWORD ?? 'admin-dev-only';
const UPSTREAM_HOST = process.env.LANDFLOW_SPIKE_UPSTREAM_HOST ?? 'host.docker.internal';
const PORTS = { one: 7600, two: 7601 };
const GATEWAY_SECRET = 'spike-gateway-secret-' + randomUUID().slice(0, 8);
const REALM = 'landflow-mcp-test';
const RESOURCE = `${GATEWAY}/mcp`.replace('127.0.0.1', 'localhost');
const V2026 = '2026-07-28';

// ------------------------------------------------------------------------------------------------------ reporting

const results = [];
function report(ok, name, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function info(name, detail) { console.log(`INFO  ${name}${detail ? `  — ${detail}` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)); return s.length > n ? s.slice(0, n) + '…' : s; };

// --------------------------------------------------------------------------------------------- fake MCP upstreams
//
// Raw Streamable HTTP servers (no SDK: the installed @modelcontextprotocol/sdk 1.32 stops at 2025-11-25) that speak
// both eras: the classic initialize flow (one: stateless, two: sessions + GET SSE stream) and 2026-07-28
// (server/discover, per-request _meta, subscriptions/listen). Each records the headers and requests it receives and
// can emit notifications/tools/list_changed on every open stream (POST /__list-changed).

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', V2026];
/** What each fake upstream saw: headers of the last request, every request's method and protocol version. */
const seen = { one: { headers: null, requests: [] }, two: { headers: null, requests: [] } };
const upstreams = {};

const TOOLS = {
  one: [
    { name: 'echo', description: 'Returns the headers upstream one received', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
    { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  ],
  two: [
    { name: 'echo', description: 'Returns the headers upstream two received', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
    { name: 'hidden', description: 'A tool the authorization rule hides from agents outside the support group', inputSchema: { type: 'object', properties: {} } },
  ],
};

function callTool(name, tool, args, headers) {
  if (tool === 'echo') return { content: [{ type: 'text', text: JSON.stringify({ upstream: name, headers }) }], structuredContent: { upstream: name, headers } };
  if (tool === 'add') return { content: [{ type: 'text', text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } };
  if (tool === 'hidden') return { content: [{ type: 'text', text: 'you may see this' }] };
  return { content: [{ type: 'text', text: `unknown tool ${tool}` }], isError: true };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function sseStart(res, extraHeaders = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extraHeaders });
  res.flushHeaders?.();
}
const sseWrite = (res, msg) => res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);

/**
 * One fake upstream. `stateful` servers hand out Mcp-Session-Id on initialize and serve a GET SSE stream per session;
 * stateless ones answer every request on its own. Both answer 2026-07-28 requests.
 */
function startUpstream(name, port, { stateful }) {
  const record = seen[name];
  const sessions = new Set();
  const streams = new Set();          // open SSE streams (GET per session, and subscriptions/listen) that get list_changed
  const serverInfo = { name: `spike-${name}`, version: '0.0.1' };
  const modernMeta = { 'io.modelcontextprotocol/serverInfo': serverInfo };

  const httpServer = createServer(async (req, res) => {
    if (req.url?.startsWith('/__state')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ...record, sessions: sessions.size, streams: streams.size })); }
    if (req.url?.startsWith('/__list-changed')) {
      for (const s of streams) sseWrite(s.res, { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: s.subscriptionId !== undefined ? { _meta: { 'io.modelcontextprotocol/subscriptionId': s.subscriptionId } } : {} });
      return res.end(JSON.stringify({ notified: streams.size }));
    }
    record.headers = { ...req.headers };
    const sid = req.headers['mcp-session-id'];
    if (req.method === 'GET') {
      if (!stateful) { res.writeHead(405, { allow: 'POST' }); return res.end('stateless upstream: no GET stream'); }
      if (!sid || !sessions.has(sid)) { res.writeHead(sid ? 404 : 400); return res.end('session required'); }
      sseStart(res, { 'mcp-session-id': sid });
      const entry = { res };
      streams.add(entry);
      req.on('close', () => streams.delete(entry));
      return;
    }
    if (req.method === 'DELETE') { if (sid) sessions.delete(sid); res.writeHead(sid && stateful ? 200 : 405); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const body = await readBody(req);
    const messages = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const m of messages) {
      if (!m?.method) continue;
      const meta = m.params?._meta ?? {};
      const modern = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string';
      record.requests.push({ method: m.method, protocolVersion: m.params?.protocolVersion ?? meta['io.modelcontextprotocol/protocolVersion'], header: req.headers['mcp-protocol-version'], modern, sessionId: sid });
      if (m.id === undefined) continue;   // a notification
      const reply = (result) => replies.push({ jsonrpc: '2.0', id: m.id, result: modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta ?? {}), ...modernMeta } } : result });
      const error = (code, message) => replies.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
      switch (m.method) {
        case 'server/discover':
          reply({ supportedVersions: VERSIONS, capabilities: { tools: { listChanged: true } }, instructions: `fake upstream ${name}`, ttlMs: 0, cacheScope: 'private' });
          break;
        case 'initialize': {
          const asked = m.params?.protocolVersion;
          const version = VERSIONS.includes(asked) && asked !== V2026 ? asked : '2025-11-25';
          if (stateful) { const id = randomUUID(); sessions.add(id); res.setHeader('mcp-session-id', id); }
          reply({ protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo, instructions: `fake upstream ${name}` });
          break;
        }
        case 'ping': reply({}); break;
        case 'tools/list': reply({ tools: TOOLS[name], ttlMs: 0, cacheScope: 'private' }); break;
        case 'tools/call': reply(callTool(name, m.params?.name, m.params?.arguments ?? {}, record.headers)); break;
        case 'subscriptions/listen': {
          // a long-lived stream: the acknowledgement first, then notifications tagged with the subscription id (the request id)
          sseStart(res);
          sseWrite(res, { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': m.id }, notifications: { toolsListChanged: !!m.params?.notifications?.toolsListChanged } } });
          const entry = { res, subscriptionId: m.id };
          streams.add(entry);
          req.on('close', () => streams.delete(entry));
          return;
        }
        default: error(-32601, `Method not found: ${m.method}`);
      }
    }
    if (!replies.length) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replies.length === 1 ? replies[0] : replies));
  });
  return new Promise((ok) => httpServer.listen(port, '127.0.0.1', () => { upstreams[name] = { httpServer }; ok(); }));
}

// ------------------------------------------------------------------------------------------- HTTP / MCP helpers

async function http(url, init = {}, timeoutMs = 10_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}

/** Parses an SSE body into its JSON data events. */
function sseEvents(text) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (data) { try { out.push(JSON.parse(data)); } catch { out.push({ raw: data }); } }
  }
  return out;
}

let rpcId = 0;
/** One JSON-RPC request over Streamable HTTP; returns { status, message, headers, raw }. `style` 2026 adds the _meta fields. */
async function rpc(method, params = {}, { url = `${GATEWAY}/mcp`, headers = {}, style = 'classic', protocolVersion, sessionId, timeoutMs = 10_000 } = {}) {
  const id = ++rpcId;
  const p = { ...params };
  if (style === '2026') {
    p._meta = { ...(p._meta ?? {}), 'io.modelcontextprotocol/protocolVersion': protocolVersion ?? V2026, 'io.modelcontextprotocol/clientInfo': { name: 'landflow-spike', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  }
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
  if (protocolVersion && style !== '2026') h['mcp-protocol-version'] = protocolVersion;
  if (style === '2026') { h['mcp-protocol-version'] = protocolVersion ?? V2026; h['mcp-method'] = method; }
  if (sessionId) h['mcp-session-id'] = sessionId;
  const res = await http(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: p }) }, timeoutMs);
  let message = res.json;
  if (!message && res.headers.get('content-type')?.includes('text/event-stream')) message = sseEvents(res.text).find((m) => m.id === id) ?? sseEvents(res.text).at(-1);
  return { status: res.status, message, headers: res.headers, raw: res.text };
}

async function initialize(protocolVersion, extra = {}) {
  const r = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'landflow-spike', version: '0' } }, extra);
  const sessionId = r.headers.get('mcp-session-id') ?? undefined;
  if (r.message?.result && extra.url !== undefined || r.message?.result) {
    await http(extra.url ?? `${GATEWAY}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(extra.headers ?? {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => {});
  }
  return { ...r, sessionId };
}

async function toolNames(extra = {}) {
  const r = await rpc('tools/list', {}, extra);
  return { names: (r.message?.result?.tools ?? []).map((t) => t.name).sort(), r };
}

/** Polls tools/list until `predicate(names)` holds; returns the elapsed ms or -1. */
async function waitForTools(predicate, { timeoutMs = 15_000, extra = {} } = {}) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const { names } = await toolNames(extra).catch(() => ({ names: [] }));
    if (predicate(names)) return Math.round(performance.now() - t0);
    await sleep(50);
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------ admin API

const targetUrl = (name) => `http://${UPSTREAM_HOST}:${PORTS[name]}/mcp`;

/** The target value shape the sync will write (docs/transports.md "One target, as the sync writes it"), as verified here. */
function targetValue(name, { secret = GATEWAY_SECRET, set } = {}) {
  return {
    name,
    mcp: { host: targetUrl(name) },
    policies: {
      backendAuth: { key: { value: secret, location: { header: { name: 'x-landflow-gateway' } } } },
      transformations: { request: { set: set ?? {
        'x-landflow-spike': '"cel-ok"',
        'x-landflow-caller-iss': 'has(jwt.iss) ? jwt.iss : "anonymous"',
        'x-landflow-caller-sub': 'has(jwt.sub) ? jwt.sub : "anonymous"',
      }, remove: ['authorization'] } },
    },
  };
}

async function adminList() { return (await http(`${ADMIN}/api/config/resources/mcp.target`)).json?.resources ?? []; }
async function adminPut(values) {
  return http(`${ADMIN}/api/config/resources/mcp.target`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resources: values.map((value) => ({ value })) }) });
}
async function adminDelete(id) { return http(`${ADMIN}/api/config/resources/mcp.target/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
async function adminClear() { for (const r of await adminList()) if (['one', 'two', 'three'].includes(r.value?.name)) await adminDelete(r.id); }

async function waitForAdmin(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await http(`${ADMIN}/api/config/resources/mcp.target`, {}, 2_000).catch(() => null);
    if (r?.status === 200) return true;
    await sleep(300);
  }
  return false;
}

// ------------------------------------------------------------------------------------------ docker compose

function compose(composeArgs, env = {}) {
  const base = ['compose', '-p', 'landflow-infra', '-f', 'deploy/compose.infra.yml'];
  const r = spawnSync('docker', [...base, ...composeArgs], { cwd: repoRoot, env: { ...process.env, COMPOSE_BAKE: 'false', ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker compose ${composeArgs.join(' ')} failed: ${r.stderr}`);
  return r;
}
async function gatewayWith(overrides = [], env = {}) {
  const files = overrides.flatMap((f) => ['-f', f]);
  compose([...files, '--profile', 'mcp-gateway', 'up', '-d', '--force-recreate', 'mcp-gateway'], env);
  if (!(await waitForAdmin())) throw new Error('the gateway admin API did not come up');
}
function gatewayLogs(lines = 20) {
  const r = spawnSync('docker', ['logs', '--tail', String(lines), 'landflow-infra-mcp-gateway-1'], { encoding: 'utf8' });
  return (r.stdout + r.stderr).trim();
}

// ======================================================================================================= phases

async function phaseCore() {
  console.log('\n== core: admin API, routing, headers, timings, notifications, versions');
  if (!(await waitForAdmin(5_000))) throw new Error(`admin API not reachable at ${ADMIN}: start the mcp-gateway profile first`);
  await adminClear();

  // -- the admin API: create
  const putBoth = await adminPut([targetValue('one'), targetValue('two')]);
  report(putBoth.status === 200, 'admin: PUT /api/config/resources/mcp.target with two targets', `status ${putBoth.status} ${short(putBoth.text)}`);
  let list = await adminList();
  const byName = Object.fromEntries(list.map((r) => [r.value?.name, r]));
  report(!!byName.one && !!byName.two, 'admin: GET lists both targets with ids', short(list.map((r) => ({ id: r.id, name: r.value?.name, revision: r.revision }))));
  info('admin: a listed resource looks like', short(list[0], 600));

  // -- the gateway serves both
  const t = await waitForTools((n) => n.includes('one_echo') && n.includes('two_echo'));
  const { names } = await toolNames();
  report(t >= 0, 'gateway: tools/list shows both targets, tools prefixed <target>_<tool>', `${names.join(', ')} (visible after ${t} ms)`);

  // -- a call reaches the right upstream and carries the right headers
  const add = await rpc('tools/call', { name: 'one_add', arguments: { a: 2, b: 40 } });
  report(add.message?.result?.structuredContent?.sum === 42, 'gateway: tools/call one_add reaches upstream one', short(add.message));
  const echo = await rpc('tools/call', { name: 'two_echo', arguments: {} }, { headers: { authorization: 'Bearer client-token-must-not-pass', 'x-landflow-caller-sub': 'forged', 'x-client-extra': 'kept' } });
  const hdr = echo.message?.result?.structuredContent?.headers ?? {};
  report(echo.message?.result?.structuredContent?.upstream === 'two', 'gateway: tools/call two_echo reaches upstream two', short(Object.keys(hdr)));
  report(hdr['x-landflow-gateway'] === GATEWAY_SECRET, 'upstream sees backendAuth header x-landflow-gateway', short(hdr['x-landflow-gateway']));
  report(hdr['x-landflow-spike'] === 'cel-ok', 'upstream sees CEL-set header (constant)', short(hdr['x-landflow-spike']));
  report(hdr['x-landflow-caller-sub'] === 'anonymous', 'upstream sees x-landflow-caller-sub overwritten by the CEL rule (client sent "forged")', short(hdr['x-landflow-caller-sub']));
  report(!('authorization' in hdr), "upstream does NOT see the client's Authorization header", hdr.authorization ? `saw ${short(hdr.authorization)}` : 'absent');
  info('upstream two saw headers', short(hdr, 700));

  // -- update one target through the single-resource PUT
  const two = byName.two;
  const upd = await http(`${ADMIN}/api/config/resources/mcp.target/${encodeURIComponent(two.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: targetValue('two', { set: { 'x-landflow-spike': '"updated"' } }) }) });
  report(upd.status === 200, 'admin: PUT /mcp.target/{id} updates a target', `status ${upd.status} ${short(upd.text)}`);
  let tUpd = -1;
  const t0 = performance.now();
  for (; performance.now() - t0 < 15_000;) {
    const e = await rpc('tools/call', { name: 'two_echo', arguments: {} });
    if (e.message?.result?.structuredContent?.headers?.['x-landflow-spike'] === 'updated') { tUpd = Math.round(performance.now() - t0); break; }
    await sleep(50);
  }
  report(tUpd >= 0, 'update visible on the traffic path', `${tUpd} ms after the PUT`);

  // -- timing: add a third target, then delete it
  const put3 = await adminPut([{ ...targetValue('three'), mcp: { host: targetUrl('one') } }]);
  const tAdd = await waitForTools((n) => n.includes('three_echo'));
  report(put3.status === 200 && tAdd >= 0, 'timing: PUT → new target in tools/list', `${tAdd} ms`);
  const three = (await adminList()).find((r) => r.value?.name === 'three');
  const del = await adminDelete(three.id);
  const tDel = await waitForTools((n) => !n.includes('three_echo'));
  report(del.status === 200 && tDel >= 0, 'timing: DELETE → target gone from tools/list', `${tDel} ms (delete status ${del.status})`);
  const del2 = await adminDelete(three.id);
  report(del2.status === 404, 'admin: a repeated DELETE answers 404', `status ${del2.status}`);

  // -- protocol versions
  const discover = await rpc('server/discover', {}, { style: '2026' });
  report(!!discover.message?.result, 'versions: server/discover (2026-07-28) answered', short(discover.message, 400));
  const list2026 = await rpc('tools/list', {}, { style: '2026' });
  const describeList = (r) => `status ${r.status}, ${r.message?.result?.tools?.length ?? 0} tools, result keys ${short(Object.keys(r.message?.result ?? {}))}, resultType=${r.message?.result?.resultType}, serverInfo=${short(r.message?.result?._meta?.['io.modelcontextprotocol/serverInfo'])}${r.message?.error ? ' error ' + short(r.message.error) : ''}`;
  report(Array.isArray(list2026.message?.result?.tools), 'versions: tools/list without initialize, 2026-07-28 _meta and MCP-Protocol-Version: 2026-07-28', describeList(list2026));
  const list2026b = await rpc('tools/list', {}, { style: '2026', protocolVersion: '2025-11-25' });
  report(Array.isArray(list2026b.message?.result?.tools), 'versions: tools/list without initialize, 2026-07-28 _meta but MCP-Protocol-Version: 2025-11-25 (what the SDK 1.x upstream accepts)', describeList(list2026b));
  const listNoVersion = await rpc('tools/list', {});
  report(Array.isArray(listNoVersion.message?.result?.tools), 'versions: tools/list without initialize and without any version', `status ${listNoVersion.status} ${short(listNoVersion.message?.error ?? 'ok')}`);
  const init2026 = await initialize(V2026);
  report(!init2026.message?.result, 'versions: classic initialize with MCP-Protocol-Version: 2026-07-28 is refused (initialize is removed in that revision)', `status ${init2026.status} ${short(init2026.raw, 120)}`);
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    const init = await initialize(v);
    const got = init.message?.result?.protocolVersion;
    report(got === v, `versions: initialize ${v} → gateway answers ${got ?? 'error'}`, `session id: ${init.sessionId ?? 'none'}; serverInfo ${short(init.message?.result?.serverInfo)}`);
  }
  const upOne = (await http(`http://127.0.0.1:${PORTS.one}/__state`)).json;
  const upTwo = (await http(`http://127.0.0.1:${PORTS.two}/__state`)).json;
  const seenVersions = (rec) => [...new Set(rec.requests.filter((r) => r.method === 'initialize').map((r) => r.protocolVersion))];
  const seenHeaders = (rec) => [...new Set(rec.requests.map((r) => r.header).filter(Boolean))];
  info('upstream one (stateless) saw initialize protocolVersion(s)', `${seenVersions(upOne).join(', ') || 'no initialize'}; MCP-Protocol-Version header values: ${seenHeaders(upOne).join(', ') || 'none'}; methods: ${[...new Set(upOne.requests.map((r) => r.method))].join(', ')}`);
  info('upstream two (stateful) saw initialize protocolVersion(s)', `${seenVersions(upTwo).join(', ') || 'no initialize'}; MCP-Protocol-Version header values: ${seenHeaders(upTwo).join(', ') || 'none'}; sessions open: ${upTwo.sessions}`);

  // -- list-changed notifications
  await checkNotifications();
}

/** Opens a stream (POST subscriptions/listen, or GET SSE), collects notifications for `ms`, returns them. */
async function collectStream(kind, { ms = 6_000, sessionId, during } = {}) {
  const ac = new AbortController();
  const headers = { accept: 'text/event-stream, application/json', 'content-type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  let res;
  const notifications = [];
  let status = 0; let firstBody = '';
  const reader = (async () => {
    try {
      if (kind === 'listen') {
        headers['mcp-protocol-version'] = V2026; headers['mcp-method'] = 'subscriptions/listen';
        res = await fetch(`${GATEWAY}/mcp`, { method: 'POST', headers, signal: ac.signal, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true }, _meta: { 'io.modelcontextprotocol/protocolVersion': V2026, 'io.modelcontextprotocol/clientInfo': { name: 'landflow-spike', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
      } else {
        res = await fetch(`${GATEWAY}/mcp`, { method: 'GET', headers, signal: ac.signal });
      }
      status = res.status;
      if (!res.body) return;
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        if (!firstBody) firstBody = buf.slice(0, 300);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const m of sseEvents(block + '\n\n')) notifications.push(m);
        }
        if (!res.headers.get('content-type')?.includes('text/event-stream')) { for (const m of [buf].flatMap((b) => { try { return [JSON.parse(b)]; } catch { return []; } })) notifications.push(m); }
      }
    } catch (e) { if (e.name !== 'AbortError') notifications.push({ error: String(e) }); }
  })();
  await sleep(600);
  if (during) await during();
  await Promise.race([reader, sleep(ms)]);
  ac.abort();
  await reader.catch(() => {});
  return { status, contentType: res?.headers.get('content-type'), notifications, firstBody };
}

/** The three things that should produce tools/list_changed, one at a time, so the report says which did. */
const EVENTS = {
  'target added (PUT)': async () => { await adminPut([{ ...targetValue('three'), mcp: { host: targetUrl('one') } }]); await waitForTools((n) => n.includes('three_echo')); },
  'upstream two emits list_changed': async () => { await http(`http://127.0.0.1:${PORTS.two}/__list-changed`, { method: 'POST' }); },
  'target removed (DELETE)': async () => { const three = (await adminList()).find((r) => r.value?.name === 'three'); if (three) await adminDelete(three.id); await waitForTools((n) => !n.includes('three_echo')); },
};
async function cleanupThree() { const three = (await adminList()).find((r) => r.value?.name === 'three'); if (three) await adminDelete(three.id); }

/** Runs each event on its own stream of `kind`, reports what arrived. */
async function notificationsPerEvent(kind, label, { sessionId } = {}) {
  const summary = [];
  let any = false; let opened = null;
  for (const [event, run] of Object.entries(EVENTS)) {
    const s = await collectStream(kind, { during: run, sessionId, ms: 2_500 });
    opened ??= s;
    const got = s.notifications.filter((n) => n.method === 'notifications/tools/list_changed').length;
    const other = s.notifications.filter((n) => n.method !== 'notifications/tools/list_changed').map((n) => n.method ?? n.error ?? short(n, 80));
    any ||= got > 0;
    summary.push(`${event}: ${got} list_changed${other.length ? ` (+ ${other.join(', ')})` : ''}`);
  }
  await cleanupThree();
  report(any, `notifications: ${label}`, `stream status ${opened?.status} ${opened?.contentType ?? ''}; ${summary.join('; ')}${opened?.status >= 400 ? ` body ${short(opened.firstBody, 120)}` : ''}`);
  return any;
}

async function checkNotifications() {
  await notificationsPerEvent('listen', 'subscriptions/listen (2026-07-28) receives tools/list_changed');
  const get = await collectStream('get', { ms: 1_000 });
  info('notifications: GET /mcp SSE stream without a session', `status ${get.status} ${short(get.firstBody, 100)} (statefulMode: stateless hands out no sessions, so older clients have no notification stream here; see --stateful)`);
  const init = await initialize('2025-06-18');
  if (init.sessionId) await notificationsPerEvent('get', 'GET SSE stream with a session receives tools/list_changed', { sessionId: init.sessionId });
}

async function phaseStateful() {
  console.log('\n== stateful: the gateway with statefulMode: stateful (sessions), which notifications reach older clients');
  try {
    await gatewayWith(['deploy/mcp-gateway/compose.stateful.yml']);
    await adminClear();
    await adminPut([targetValue('one'), targetValue('two')]);
    await waitForTools((n) => n.includes('one_echo') && n.includes('two_echo'));
    const init = await initialize('2025-06-18');
    report(!!init.sessionId, 'stateful: initialize hands out an Mcp-Session-Id', `${init.sessionId ?? 'none'}; protocolVersion ${init.message?.result?.protocolVersion}`);
    const list = await toolNames({ sessionId: init.sessionId });
    report(list.names.length === 4, 'stateful: tools/list in the session', list.names.join(', '));
    const noSession = await rpc('tools/list', {});
    info('stateful: tools/list without a session', `status ${noSession.status} ${short(noSession.message?.error ?? noSession.message?.result?.tools?.length + ' tools', 120)}`);
    if (init.sessionId) await notificationsPerEvent('get', 'stateful: GET SSE stream with a session receives tools/list_changed', { sessionId: init.sessionId });
    await notificationsPerEvent('listen', 'stateful: subscriptions/listen (2026-07-28) receives tools/list_changed');
    const upTwo = (await http(`http://127.0.0.1:${PORTS.two}/__state`)).json;
    info('stateful: upstream two sessions/streams open', `${upTwo.sessions} session(s), ${upTwo.streams} stream(s)`);
    await http(`${GATEWAY}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': init.sessionId } }).then((r) => info('stateful: DELETE the session', `status ${r.status}`));
  } finally {
    if (!keep) { await gatewayWith([]); info('stateful: gateway back on the default config'); }
  }
}

// ------------------------------------------------------------------------------------------------ auth phase

async function keycloakAdminToken() {
  const r = await http(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: KC_ADMIN, password: KC_ADMIN_PASSWORD }) });
  if (!r.json?.access_token) throw new Error(`Keycloak admin login failed: ${r.status} ${r.text}`);
  return r.json.access_token;
}
async function kc(token, method, path, body) {
  const r = await http(`${KEYCLOAK}/admin${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status >= 300 && r.status !== 409) throw new Error(`Keycloak ${method} ${path}: ${r.status} ${r.text}`);
  return r;
}
async function createTestRealm() {
  const token = await keycloakAdminToken();
  const existing = await http(`${KEYCLOAK}/admin/realms/${REALM}`, { headers: { authorization: `Bearer ${token}` } });
  if (existing.status === 200) { await kc(token, 'DELETE', `/realms/${REALM}`); }
  await kc(token, 'POST', '/realms', { realm: REALM, enabled: true, displayName: 'Landflow MCP gateway spike (temporary)', accessTokenLifespan: 600 });
  for (const g of ['landflow-agents', 'support']) await kc(token, 'POST', `/realms/${REALM}/groups`, { name: g });
  await kc(token, 'POST', `/realms/${REALM}/clients`, {
    clientId: 'landflow-mcp-test', name: 'Landflow MCP test client', publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: true, redirectUris: ['http://localhost/*', 'http://127.0.0.1/*'],
    protocolMappers: [
      { name: 'mcp-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': RESOURCE, 'access.token.claim': 'true', 'id.token.claim': 'false' } },
      { name: 'groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper', config: { 'claim.name': 'groups', 'full.path': 'false', 'access.token.claim': 'true', 'id.token.claim': 'true', 'userinfo.token.claim': 'true' } },
    ],
  });
  const users = [
    { username: 'landflow-mcp-test-agent', password: 'agent-test-only', groups: ['/landflow-agents'] },
    { username: 'landflow-mcp-test-support', password: 'support-test-only', groups: ['/landflow-agents', '/support'] },
    { username: 'landflow-mcp-test-outsider', password: 'outsider-test-only', groups: [] },
  ];
  for (const u of users) await kc(token, 'POST', `/realms/${REALM}/users`, { username: u.username, enabled: true, email: `${u.username}@landflow.test`, emailVerified: true, firstName: 'Test', lastName: u.username, credentials: [{ type: 'password', value: u.password, temporary: false }], groups: u.groups });
  return users;
}
async function deleteTestRealm() {
  const token = await keycloakAdminToken();
  const r = await http(`${KEYCLOAK}/admin/realms/${REALM}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  return r.status;
}
async function userToken(username, password) {
  const r = await http(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'landflow-mcp-test', username, password, scope: 'openid' }) });
  if (!r.json?.access_token) throw new Error(`token for ${username}: ${r.status} ${r.text}`);
  return r.json.access_token;
}
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

async function phaseAuth() {
  console.log('\n== auth: mcpAuthentication against Keycloak, protected resource metadata, identity headers, mcpAuthorization');
  const kcUp = await http(`${KEYCLOAK}/realms/master`, {}, 5_000).catch(() => null);
  if (kcUp?.status !== 200) { report(false, 'auth: Keycloak reachable (profile auth)', `${KEYCLOAK} answered ${kcUp?.status ?? 'nothing'}`); return; }
  const users = await createTestRealm();
  info('auth: created realm', `${REALM} with client landflow-mcp-test, groups landflow-agents and support, users ${users.map((u) => u.username).join(', ')}`);
  try {
    await gatewayWith(['deploy/mcp-gateway/compose.auth.yml']);
    await adminClear();
    await adminPut([targetValue('one', { set: { 'x-landflow-caller-iss': 'jwt.iss', 'x-landflow-caller-sub': 'jwt.sub', 'x-landflow-caller-groups': 'jwt.groups.join(",")' } }), targetValue('two', { set: { 'x-landflow-caller-iss': 'jwt.iss', 'x-landflow-caller-sub': 'jwt.sub' } })]);

    const anon = await rpc('tools/list', {});
    report(anon.status === 401, 'auth: unauthenticated tools/list → 401', `status ${anon.status}, WWW-Authenticate: ${anon.headers.get('www-authenticate') ?? 'missing'}`);
    report(!!anon.headers.get('www-authenticate')?.includes('resource_metadata'), 'auth: WWW-Authenticate names the resource metadata', short(anon.headers.get('www-authenticate')));
    const prm = await http(`${GATEWAY}/.well-known/oauth-protected-resource/mcp`);
    report(prm.status === 200 && Array.isArray(prm.json?.authorization_servers), 'auth: GET /.well-known/oauth-protected-resource/mcp', `status ${prm.status} ${short(prm.json, 400)}`);
    const asMeta = await http(`${GATEWAY}/.well-known/oauth-authorization-server`).catch(() => ({ status: 0 }));
    info('auth: GET /.well-known/oauth-authorization-server on the gateway', `status ${asMeta.status} ${short(asMeta.text, 200)}`);

    const bad = await rpc('tools/list', {}, { headers: { authorization: 'Bearer not-a-token' } });
    report(bad.status === 401, 'auth: a garbage token → 401', `status ${bad.status}`);

    const agent = await userToken('landflow-mcp-test-agent', 'agent-test-only');
    const claims = decodeJwt(agent);
    info('auth: agent token claims', `iss=${claims.iss} aud=${short(claims.aud)} sub=${claims.sub} groups=${short(claims.groups)}`);
    const tAgent = await waitForTools((n) => n.includes('one_echo'), { extra: { headers: { authorization: `Bearer ${agent}` } } });
    const { names } = await toolNames({ headers: { authorization: `Bearer ${agent}` } });
    report(tAgent >= 0 && names.includes('one_echo'), 'auth: a valid token → tools/list works', names.join(', '));
    report(!names.includes('two_hidden'), 'authz: the CEL rule hides two_hidden from an agent outside the support group', names.join(', '));
    const echo = await rpc('tools/call', { name: 'one_echo', arguments: {} }, { headers: { authorization: `Bearer ${agent}`, 'x-landflow-caller-sub': 'forged' } });
    const hdr = echo.message?.result?.structuredContent?.headers ?? {};
    report(hdr['x-landflow-caller-sub'] === claims.sub, 'auth: upstream sees x-landflow-caller-sub = jwt.sub (client "forged" value overwritten)', short(hdr['x-landflow-caller-sub']));
    report(hdr['x-landflow-caller-iss'] === claims.iss, 'auth: upstream sees x-landflow-caller-iss = jwt.iss', short(hdr['x-landflow-caller-iss']));
    report(!('authorization' in hdr), "auth: upstream does NOT see the agent's token", hdr.authorization ? 'saw Authorization' : 'absent');
    info('auth: x-landflow-caller-groups (CEL jwt.groups.join)', short(hdr['x-landflow-caller-groups']));
    const hiddenCall = await rpc('tools/call', { name: 'two_hidden', arguments: {} }, { headers: { authorization: `Bearer ${agent}` } });
    report(!!hiddenCall.message?.error || hiddenCall.status >= 400 || hiddenCall.message?.result?.isError, 'authz: calling two_hidden as an agent is refused', `status ${hiddenCall.status} ${short(hiddenCall.message)}`);

    const support = await userToken('landflow-mcp-test-support', 'support-test-only');
    const sNames = (await toolNames({ headers: { authorization: `Bearer ${support}` } })).names;
    report(sNames.includes('two_hidden'), 'authz: the support group sees two_hidden', sNames.join(', '));
    const okHidden = await rpc('tools/call', { name: 'two_hidden', arguments: {} }, { headers: { authorization: `Bearer ${support}` } });
    report(okHidden.message?.result?.content?.[0]?.text === 'you may see this', 'authz: the support group may call two_hidden', short(okHidden.message));

    const outsider = await userToken('landflow-mcp-test-outsider', 'outsider-test-only');
    const oList = await rpc('tools/list', {}, { headers: { authorization: `Bearer ${outsider}` } });
    const oNames = (oList.message?.result?.tools ?? []).map((t) => t.name);
    report(oNames.length === 0, 'authz: a signed-in user outside landflow-agents sees no tools', `status ${oList.status}, tools: ${oNames.join(', ') || 'none'} ${short(oList.message?.error ?? '')}`);

    const disc = await rpc('server/discover', {}, { style: '2026', headers: { authorization: `Bearer ${agent}` } });
    info('auth: server/discover with a token', `status ${disc.status} ${short(disc.message, 300)}`);
    const init = await initialize('2025-06-18', { headers: { authorization: `Bearer ${agent}` } });
    info('auth: initialize with a token', `status ${init.status} protocolVersion ${init.message?.result?.protocolVersion}`);
  } finally {
    if (!keep) {
      const st = await deleteTestRealm().catch((e) => String(e));
      info('auth: deleted realm', `${REALM} (status ${st})`);
      await gatewayWith([]);
      info('auth: gateway back on the default config');
    } else {
      info('auth: --keep: the realm and the auth gateway config stay');
    }
  }
}

// ------------------------------------------------------------------------------------------------ file phase

function fileConfig(targets) {
  const base = readFileSync(join(repoRoot, 'deploy/mcp-gateway/config.file.yaml'), 'utf8');
  const lines = targets.map((t) => [
    `  - name: ${t.name}`,
    `    mcp:`,
    `      host: ${t.mcp.host}`,
    `    policies:`,
    `      backendAuth:`,
    `        key:`,
    `          value: ${JSON.stringify(t.policies.backendAuth.key.value)}`,
    `          location:`,
    `            header:`,
    `              name: x-landflow-gateway`,
    `      transformations:`,
    `        request:`,
    `          set:`,
    ...Object.entries(t.policies.transformations.request.set).map(([k, v]) => `            ${k}: ${JSON.stringify(v)}`),
    `          remove: [authorization]`,
  ].join('\n')).join('\n');
  return base.replace(/^  targets: \[\]$/m, targets.length ? `  targets:\n${lines}` : '  targets: []');
}

async function phaseFile() {
  console.log('\n== file: storage mode file, targets edited in the mounted config, reload time');
  const dir = mkdtempSync(join(tmpdir(), 'landflow-mcp-gateway-file-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, fileConfig([]));
  try {
    await gatewayWith(['deploy/mcp-gateway/compose.file.yml'], { LANDFLOW_MCP_GATEWAY_FILE_DIR: dir });
    const list = await adminList();
    report(Array.isArray(list) && list.length === 0, 'file: GET mcp.target lists nothing in file mode (as documented)', short(list));
    const put = await adminPut([targetValue('one')]);
    info('file: PUT mcp.target in file mode', `status ${put.status} ${short(put.text)}; the file now ${readFileSync(file, 'utf8').includes('name: one') ? 'contains' : 'does not contain'} the target`);
    const tApi = put.status === 200 ? await waitForTools((n) => n.includes('one_echo')) : -1;
    info('file: target written through the API visible in tools/list after', `${tApi} ms`);

    // write both targets into the file
    let t0 = performance.now();
    writeFileSync(file, fileConfig([targetValue('one'), targetValue('two')]));
    const tAdd = await waitForTools((n) => n.includes('one_echo') && n.includes('two_echo'), { timeoutMs: 20_000 });
    report(tAdd >= 0, 'file: targets written into the file show up in tools/list', `${tAdd} ms after the write`);
    const echo = await rpc('tools/call', { name: 'two_echo', arguments: {} }, { headers: { authorization: 'Bearer x' } });
    const hdr = echo.message?.result?.structuredContent?.headers ?? {};
    report(hdr['x-landflow-gateway'] === GATEWAY_SECRET && hdr['x-landflow-spike'] === 'cel-ok' && !hdr.authorization, 'file: backendAuth and CEL headers work from the file', short({ gw: hdr['x-landflow-gateway'] === GATEWAY_SECRET, spike: hdr['x-landflow-spike'], authorization: hdr.authorization }));

    // remove one
    writeFileSync(file, fileConfig([targetValue('one')]));
    const tDel = await waitForTools((n) => n.includes('one_echo') && !n.includes('two_echo'), { timeoutMs: 20_000 });
    report(tDel >= 0, 'file: a target removed from the file disappears from tools/list', `${tDel} ms after the write`);

    // a broken file: what happens?
    writeFileSync(file, fileConfig([targetValue('one')]) + '\nthis is: [not: valid\n');
    await sleep(1500);
    const still = (await toolNames()).names;
    report(still.includes('one_echo'), 'file: an invalid file keeps the last good config serving', `tools: ${still.join(', ')}; log: ${short(gatewayLogs(3), 300)}`);
    writeFileSync(file, fileConfig([targetValue('one')]));
    await sleep(1000);
  } finally {
    if (!keep) { await gatewayWith([]); info('file: gateway back on the default config'); }
    else info('file: --keep: the file-mode gateway stays', dir);
  }
}

// ========================================================================================================= main

await startUpstream('one', PORTS.one, { stateful: false });
await startUpstream('two', PORTS.two, { stateful: true });
info('fake upstreams listening', `one (stateless) http://127.0.0.1:${PORTS.one}/mcp, two (stateful) http://127.0.0.1:${PORTS.two}/mcp; the gateway reaches them at ${targetUrl('one')} and ${targetUrl('two')}`);
const version = await http(`${ADMIN}/api/version`).catch(() => null);
info('gateway', `${GATEWAY} (admin ${ADMIN}) version: ${short(version?.text ?? 'unknown', 200)}`);

let failed = false;
try {
  if (phases.core) await phaseCore();
  if (phases.stateful) await phaseStateful();
  if (phases.auth) await phaseAuth();
  if (phases.file) await phaseFile();
} catch (e) {
  failed = true;
  console.error('ERROR', e);
  console.error('gateway log tail:\n' + gatewayLogs(30));
} finally {
  if (!keep) { await adminClear().catch(() => {}); for (const u of Object.values(upstreams)) u.httpServer.close(); }
  else info('--keep: fake upstreams and targets left running');
}
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length} passed, ${fails.length} failed${fails.length ? ':\n' + fails.map((f) => `  - ${f.name}`).join('\n') : ''}`);
if (!keep) process.exit(failed || fails.length ? 1 : 0);
