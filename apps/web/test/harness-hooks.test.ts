/**
 * Claude Code hook ingest (C04, docs/harnesses.md#live-status): the status machine and its order keys, the store's conditional
 * write, privacy and the agent mirror, the two routes with real API keys, the live-event filter and the upkeep. Written against
 * the acceptance scenarios AS-1..AS-9 of C04 and AS-4/AS-5 of C15.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-harness-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const status = await import('@/lib/server/harness/status');
const store = await import('@/lib/server/harness/store');
const privacy = await import('@/lib/server/harness/privacy');
const { ingestHookEvent } = await import('@/lib/server/harness/ingest');
const { takeEvent } = await import('@/lib/server/harness/limits');
const { harnessTally } = await import('@/lib/server/harness/metrics');
const { harnessSessions } = await import('@/lib/server/harness/list');
const { database } = await import('@/lib/server/db');
const { TABLES } = await import('@/lib/server/db/schema');
const { createUser } = await import('@/lib/server/auth/users');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { agentStore } = await import('@/lib/server/agents/store');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { liveEventFilter } = await import('@/lib/server/projects/events');
const { rememberSecretValues } = await import('@/lib/server/secrets/redact');
const { bus } = await import('@/lib/server/bus');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const hookRoute = await import('@/app/api/harness/[harness]/hooks/route');
const sessionsRoute = await import('@/app/api/harness/sessions/route');
const { prune, sweep } = store;

const owner = await createUser({ email: 'owner@harness.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@harness.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const eve = await createUser({ email: 'eve@harness.test', name: 'Eve', role: 'member', password: 'eve-password-1' });
const aliceKey = createApiKey(alice, { label: 'hooks', scopes: ['harness:write', 'executions:read'] }).token;
const plainKey = createApiKey(alice, { label: 'no scope', scopes: ['workflows:read'] }).token;

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const post = (harness: string, body: unknown, headers: Record<string, string> = {}, key: string | null = aliceKey) =>
  hookRoute.POST(
    new Request(`http://harness.test/api/harness/${harness}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ harness }) },
  );
let seq = 0;
/** One event in order: its own seq. */
const send = (session: string, name: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post('claude-code', { hook_event_name: name, session_id: session, ...extra }, { 'x-landflow-hook-seq': String(++seq), ...headers });
const rowOf = (session: string, ownerId = alice.id) => database().get<store.SessionRow>('SELECT * FROM harness_sessions WHERE owner_id = ? AND session_key = ?', ownerId, session);
const eventsOfSession = (session: string) => store.eventsOf(rowOf(session)!.id);

beforeEach(() => {
  enableTestAuth();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LANDFLOW_HARNESS_EVENTS_PER_SECOND;
  delete process.env.LANDFLOW_TRACE_CONTENT;
});

describe('order keys and the status machine (T-3)', () => {
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
  it('prefers the seq header, zero-padded; then the time header; then the receive time', () => {
    const at = new Date('2026-11-21T10:00:00.000Z');
    expect(status.orderKeyOf(headers({ 'x-landflow-hook-seq': '12' }), at)).toEqual({ kind: 'seq', value: '00000000000000000012' });
    expect(status.orderKeyOf(headers({ 'x-landflow-hook-time': '2026-11-21T09:00:00Z' }), at)).toEqual({ kind: 'time', value: '2026-11-21T09:00:00.000Z' });
    expect(status.orderKeyOf(headers({ 'x-landflow-hook-seq': 'abc' }), at)).toEqual({ kind: 'time', value: at.toISOString() });
    // Zero padded keys compare as strings: 9 < 10.
    expect(status.orderKeyOf(headers({ 'x-landflow-hook-seq': '9' }), at).value < status.orderKeyOf(headers({ 'x-landflow-hook-seq': '10' }), at).value).toBe(true);
  });
  it('walks thinking, working, thinking, idle (AS-2) and ignores a name it does not know', () => {
    let current: 'idle' | 'thinking' | 'working' = 'idle';
    const seen: string[] = [];
    for (const [name, verdict] of [['UserPromptSubmit', 'thinking'], ['PreToolUse', 'working'], ['PostToolUse', 'thinking'], ['Stop', 'idle']] as const) {
      current = status.nextStatus(current, verdict, name, true) as typeof current;
      seen.push(current);
    }
    expect(seen).toEqual(['thinking', 'working', 'thinking', 'idle']);
    expect(status.nextStatus('working', undefined, 'Whatever', true)).toBe('working');
    expect(status.nextStatus('working', 'keep', 'Notification', true)).toBe('working');
  });
  it('keeps error and blocked until a newer prompt, tool use or session start (FR-5)', () => {
    expect(status.nextStatus('error', 'idle', 'Stop', true)).toBe('error');
    expect(status.nextStatus('blocked', 'thinking', 'PostToolUse', true)).toBe('blocked');
    expect(status.nextStatus('error', 'thinking', 'UserPromptSubmit', true)).toBe('thinking');
    expect(status.nextStatus('blocked', 'working', 'PreToolUse', true)).toBe('working');
    expect(status.nextStatus('error', 'idle', 'SessionStart', true)).toBe('idle');
    expect(status.nextStatus('error', 'thinking', 'UserPromptSubmit', false)).toBe('error');
    expect(status.nextStatus('error', 'ended', 'SessionEnd', true)).toBe('ended');
  });
  it('reads a quiet session as idle (stale) after 30 minutes, errors stay', () => {
    const last = '2026-11-21T10:00:00.000Z';
    const at = (minutes: number) => Date.parse(last) + minutes * 60_000;
    expect(status.readStatus({ status: 'working', lastEventAt: last }, at(29))).toEqual({ status: 'working', stale: false });
    expect(status.readStatus({ status: 'working', lastEventAt: last }, at(31))).toEqual({ status: 'idle', stale: true });
    expect(status.readStatus({ status: 'error', lastEventAt: last }, at(31)).status).toBe('error');
  });
});

describe('the store (T-4)', () => {
  it('has both tables, in TABLES', () => {
    expect(Object.keys(TABLES)).toEqual(expect.arrayContaining(['harness_sessions', 'harness_events']));
    expect(database().all('SELECT * FROM harness_sessions')).toBeDefined();
    expect(database().all('SELECT * FROM harness_events')).toBeDefined();
  });
  const input = (over: Partial<store.EventInput> = {}): store.EventInput => ({
    ownerId: alice.id,
    harness: 'claude-code',
    sessionKey: 'store-1',
    name: 'SessionStart',
    orderKey: { kind: 'seq', value: '1'.padStart(20, '0') },
    receivedAt: '2026-11-21T10:00:00.000Z',
    verdict: 'idle',
    viewFor: () => ({ event: 'SessionStart' }),
    prompt: false,
    tool: false,
    ...over,
  });
  const key = (n: number) => ({ kind: 'seq' as const, value: String(n).padStart(20, '0') });

  it('stores an older event in its place and leaves the status (AS-3, FR-4)', async () => {
    const late = await store.applyEvent(input({ sessionKey: 'order-1', name: 'StopFailure', verdict: 'error', orderKey: key(2), viewFor: () => ({ event: 'StopFailure' }) }));
    expect(late.session.status).toBe('error');
    const first = await store.applyEvent(input({ sessionKey: 'order-1', name: 'SessionStart', verdict: 'idle', orderKey: key(1) }));
    expect(first.applied).toBe(false);
    expect(first.session.status).toBe('error');
    expect(store.eventsOf(first.session.id).map((e) => e.name)).toEqual(['SessionStart', 'StopFailure']);
  });
  it('lets two concurrent applyEvent calls change the status once each, counting both', async () => {
    await store.applyEvent(input({ sessionKey: 'race-1', orderKey: key(1) }));
    const results = await Promise.all([
      store.applyEvent(input({ sessionKey: 'race-1', name: 'UserPromptSubmit', verdict: 'thinking', orderKey: key(2), prompt: true })),
      store.applyEvent(input({ sessionKey: 'race-1', name: 'UserPromptSubmit', verdict: 'thinking', orderKey: key(3), prompt: true })),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(JSON.parse(rowOf('race-1')!.data).prompts).toBe(2);
  });
  it('sweeps: stale at +31 minutes (told once), closed at +24 hours (AS-8)', async () => {
    const applied = await store.applyEvent(input({ sessionKey: 'sweep-1', name: 'PreToolUse', verdict: 'working', receivedAt: '2026-11-21T10:00:00.000Z' }));
    const base = Date.parse('2026-11-21T10:00:00.000Z');
    expect(await sweep(base + 29 * 60_000)).toEqual([]);
    const stale = (await sweep(base + 31 * 60_000)).filter((r) => r.id === applied.session.id);
    expect(stale).toHaveLength(1);
    expect(store.viewOf(stale[0], base + 31 * 60_000)).toMatchObject({ status: 'idle', stale: true, changedAt: '2026-11-21T10:00:00.000Z' });
    expect((await sweep(base + 32 * 60_000)).filter((r) => r.id === applied.session.id)).toHaveLength(0);
    const closed = (await sweep(base + 25 * 3_600_000)).filter((r) => r.id === applied.session.id);
    expect(closed[0]).toMatchObject({ status: 'ended' });
    expect(closed[0].closed_at).not.toBeNull();
  });
  it('reopens a stale session on its next event, clearing the stale mark', async () => {
    const first = await store.applyEvent(input({ sessionKey: 'wake-1', name: 'PreToolUse', verdict: 'working', receivedAt: '2026-11-21T10:00:00.000Z' }));
    await sweep(Date.parse('2026-11-21T10:40:00.000Z'));
    const next = await store.applyEvent(input({ sessionKey: 'wake-1', name: 'UserPromptSubmit', verdict: 'thinking', orderKey: key(5), receivedAt: '2026-11-21T10:41:00.000Z' }));
    expect(next.session.id).toBe(first.session.id);
    expect(store.viewOf(next.session, Date.parse('2026-11-21T10:42:00.000Z'))).toMatchObject({ status: 'thinking', stale: false });
  });
});

describe('privacy and the mirror (T-5)', () => {
  it('keeps the tool name and duration of an own PostToolUse, never paths or the repository it was not told (AS-5)', () => {
    const view = privacy.ownEventView({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/home/x/secret.txt' }, tool_response: { content: 'text' }, cwd: '/home/x/repo', transcript_path: '/home/x/t.jsonl', duration_ms: 42, prompt: 'hello' });
    expect(view).toEqual({ event: 'PostToolUse', tool: 'Read', durationMs: 42 });
    expect(JSON.stringify(view)).not.toMatch(/home|secret|hello/);
    expect(privacy.repositoryOf({ repository: 'acme/app' })).toBe('acme/app');
    expect(privacy.repositoryOf({ repository: '../../etc/passwd' })).toBeUndefined();
    expect(privacy.repositoryOf({ cwd: '/home/x/acme/app' })).toBeUndefined();
  });
  it('an agent view follows the content setting: summaries cut text and drop outputs (AS-6); off keeps names', () => {
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'x'.repeat(1000) }, tool_response: { out: 'y'.repeat(1000) }, duration_ms: 5, last_assistant_message: 'z'.repeat(1000), prompt: 'p' };
    const summaries = privacy.agentEventView(payload, 'summaries');
    expect(summaries.output).toBeUndefined();
    expect((summaries.reply as string).length).toBeLessThan(500);
    expect(summaries.tool).toBe('Bash');
    const full = privacy.agentEventView({ ...payload, tool_response: { out: 'y'.repeat(40_000) } }, 'full');
    expect(JSON.stringify(full.output).length).toBeLessThan(17_000);
    const off = privacy.agentEventView(payload, 'off');
    expect(off).toEqual({ event: 'PostToolUse', tool: 'Bash', callId: 'tu_1', durationMs: 5 });
  });
  it('redacts a remembered secret in an agent view', () => {
    rememberSecretValues(['fixture-secret-value-123']);
    const view = privacy.agentEventView({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { out: 'token fixture-secret-value-123 here' } }, 'full');
    expect(JSON.stringify(view)).not.toContain('fixture-secret-value-123');
    expect(JSON.stringify(view)).toContain('[redacted]');
  });
});

describe('the routes (T-6)', () => {
  it('401 without a key and 403 without the scope, the latter recorded as api.denied (AS-1)', async () => {
    enableTestAuth();
    const { disableTestAuth } = await import('@/lib/server/auth/test-bypass');
    disableTestAuth();
    expect((await post('claude-code', { hook_event_name: 'Stop', session_id: 'x' }, {}, null)).status).toBe(401);
    const denied = await post('claude-code', { hook_event_name: 'Stop', session_id: 'x' }, {}, plainKey);
    expect(denied.status).toBe(403);
    const rows = database().all<{ action: string }>("SELECT action FROM audit_events WHERE action = 'api.denied'");
    expect(rows.length).toBeGreaterThan(0);
    // The same key again within the minute is not recorded again.
    const before = rows.length;
    await post('claude-code', { hook_event_name: 'Stop', session_id: 'x' }, {}, plainKey);
    expect(database().all("SELECT action FROM audit_events WHERE action = 'api.denied'").length).toBe(before);
  });
  it('404 for a harness that sends no events, 204 for claude-code (C15 AS-4), 400 for a body without a session', async () => {
    expect((await post('cursor', { hook_event_name: 'Stop', session_id: 'c1' })).status).toBe(404);
    expect((await post('nope', { hook_event_name: 'Stop', session_id: 'c1' })).status).toBe(404);
    const started = performance.now();
    const ok = await send('route-1', 'SessionStart');
    expect(performance.now() - started).toBeLessThan(200);
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    expect((await post('claude-code', { hook_event_name: 'Stop' })).status).toBe(400);
  });
  it('413 over 64 KB', async () => {
    const response = await post('claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'big', prompt: 'x'.repeat(70_000) });
    expect(response.status).toBe(413);
  });
  it('walks a session through the routes: thinking, working, thinking, idle (AS-2); a permission request waits (AS-4)', async () => {
    const states: string[] = [];
    for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      expect((await send('walk-1', name, { tool_name: 'Bash' })).status).toBe(204);
      states.push(rowOf('walk-1')!.status);
    }
    expect(states).toEqual(['thinking', 'working', 'thinking', 'idle']);
    await send('walk-1', 'PermissionRequest', { tool_name: 'Bash' });
    expect(rowOf('walk-1')!.status).toBe('waiting');
    await send('walk-1', 'Notification', { notification_type: 'idle_prompt' });
    expect(rowOf('walk-1')!.status).toBe('idle');
    await send('walk-1', 'Notification', { notification_type: 'permission_prompt' });
    expect(rowOf('walk-1')!.status).toBe('waiting');
    expect(JSON.parse(rowOf('walk-1')!.data)).toMatchObject({ prompts: 1, toolCalls: 1 });
  });
  it('seq 2 StopFailure before seq 1 SessionStart ends in error, mirror in seq order (AS-3)', async () => {
    await post('claude-code', { hook_event_name: 'StopFailure', session_id: 'ooo', error: 'server_error' }, { 'x-landflow-hook-seq': '2' });
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'ooo' }, { 'x-landflow-hook-seq': '1' });
    expect(rowOf('ooo')!.status).toBe('error');
    expect(eventsOfSession('ooo').map((e) => e.name)).toEqual(['SessionStart', 'StopFailure']);
  });
  it('stores an event name the entry does not list, leaves the status and counts it (C15 AS-5)', async () => {
    await send('unk-1', 'UserPromptSubmit');
    const before = harnessTally().unknown['claude-code'] ?? 0;
    expect((await send('unk-1', 'BrandNewHook')).status).toBe(204);
    expect(rowOf('unk-1')!.status).toBe('thinking');
    expect(eventsOfSession('unk-1').map((e) => e.name)).toContain('BrandNewHook');
    expect(harnessTally().unknown['claude-code']).toBe(before + 1);
  });
  it('maps a StopFailure whose words name a usage limit to blocked, and a late SessionStart does not clear it', async () => {
    await send('block-1', 'UserPromptSubmit');
    await send('block-1', 'StopFailure', { error: 'rate_limit', error_details: 'You have hit your usage limit. Try again later.' });
    expect(rowOf('block-1')!.status).toBe('blocked');
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'block-1' }, { 'x-landflow-hook-seq': '1' });
    expect(rowOf('block-1')!.status).toBe('blocked');
    await send('block-1', 'UserPromptSubmit');
    expect(rowOf('block-1')!.status).toBe('thinking');
    await send('block-2', 'StopFailure', { error: 'server_error', error_details: 'Internal error' });
    expect(rowOf('block-2')!.status).toBe('error');
    await send('block-3', 'StopFailure', { quota_blocked: true });
    expect(rowOf('block-3')!.status).toBe('blocked');
  });
  it('answers 429 with retryAfter past the per-key limit and counts the first 20 (AS-9)', async () => {
    const now = Date.parse('2026-11-21T12:00:00.000Z');
    const results: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await ingestHookEvent({ harness: 'claude-code', actor: alice, keyId: 'key_limit', payload: { hook_event_name: 'UserPromptSubmit', session_id: 'lim-1' }, headers: { get: (n: string) => (n === 'x-landflow-hook-seq' ? String(i + 1) : null) }, now });
      results.push(r.status);
    }
    expect(results.filter((s) => s === 204)).toHaveLength(20);
    expect(results.filter((s) => s === 429)).toHaveLength(5);
    expect(JSON.parse(rowOf('lim-1')!.data).prompts).toBe(20);
    expect(await takeEvent('key_limit', alice.id, now + 1000)).toBe(true);
  });
  it('maps the 429 to a body with retryAfter', async () => {
    process.env.LANDFLOW_HARNESS_EVENTS_PER_SECOND = '1';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T13:00:00.500Z'));
    const first = await send('lim-2', 'SessionStart');
    const second = await send('lim-2', 'UserPromptSubmit');
    expect(first.status).toBe(204);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ retryAfter: 1 });
  });
  it('caps open sessions per owner', async () => {
    process.env.LANDFLOW_HARNESS_MAX_OPEN_SESSIONS = '2';
    try {
      const capped = createApiKey(eve, { label: 'cap', scopes: ['harness:write'] }).token;
      const statuses: number[] = [];
      for (const s of ['cap-1', 'cap-2', 'cap-3']) statuses.push((await post('claude-code', { hook_event_name: 'SessionStart', session_id: s }, {}, capped)).status);
      expect(statuses).toEqual([204, 204, 429]);
      // An existing session still takes events.
      expect((await post('claude-code', { hook_event_name: 'Stop', session_id: 'cap-1' }, { 'x-landflow-hook-seq': '9' }, capped)).status).toBe(204);
    } finally {
      delete process.env.LANDFLOW_HARNESS_MAX_OPEN_SESSIONS;
    }
  });
});

describe('binding to agents and the mirror', () => {
  const team = createTeamProject({ name: 'Harness team' });
  const hidden = agentStore.create({ name: 'Hidden Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
  setHomeProject('agent', hidden.id, team.id);
  const shared = agentStore.create({ name: 'Open Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
  // Eve edits (so she may run it); Alice only views (she reads its sessions but may not run it).
  const crew = createTeamProject({ name: 'Crew' });
  setMember(crew.id, eve.id, 'editor');
  setMember(crew.id, alice.id, 'viewer');
  setHomeProject('agent', shared.id, crew.id);
  const evePost = createApiKey(eve, { label: 'eve', scopes: ['harness:write', 'executions:read'] }).token;

  it('stores a session on an agent the owner may not run as their own (AS-7)', async () => {
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'agent-no', prompt: 'secret prompt' }, { 'x-landflow-hook-seq': '1', 'x-landflow-agent': hidden.id }, evePost);
    const row = rowOf('agent-no', eve.id)!;
    expect(row.agent_id).toBeNull();
    expect(JSON.stringify(store.eventsOf(row.id))).not.toContain('secret prompt');
    expect(agentStore.getSession(row.id)).toBeUndefined();
  });
  it('a viewer of the agent (read, not run) gets an own session too', async () => {
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'viewer-1' }, { 'x-landflow-hook-seq': '1', 'x-landflow-agent': shared.id });
    expect(rowOf('viewer-1')!.agent_id).toBeNull();
  });
  it('binds only on a SessionStart: another first event with agent_type is an own session without content (privacy)', async () => {
    for (const first of ['UserPromptSubmit', 'PreToolUse', 'SubagentStart']) {
      const session = `nobind-${first}`;
      await post('claude-code', { hook_event_name: first, session_id: session, prompt: 'private prompt', tool_name: 'Bash', tool_input: { command: 'cat ~/notes' } }, { 'x-landflow-hook-seq': '1', 'x-landflow-agent': shared.id }, evePost);
      const row = rowOf(session, eve.id)!;
      expect(row.agent_id).toBeNull();
      expect(JSON.stringify(store.eventsOf(row.id))).not.toMatch(/private prompt|cat ~/);
    }
  });
  it('a bare slug:slug agent_type never binds, even for an agent the owner may run (any plugin can use any name)', async () => {
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'bare-slug', agent_type: 'open-helper:open-helper', cwd: '/home/eve/secret' }, { 'x-landflow-hook-seq': '1' }, evePost);
    await post('claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'bare-slug', agent_type: 'landflow-open-helper:open-helper', prompt: 'private bare prompt' }, { 'x-landflow-hook-seq': '2' }, evePost);
    const row = rowOf('bare-slug', eve.id)!;
    expect(row.agent_id).toBeNull();
    expect(JSON.stringify(store.eventsOf(row.id))).not.toMatch(/private bare prompt|secret/);
    expect(agentStore.getSession(row.id)).toBeUndefined();
  });
  it('an unknown agent id in the header is an own session', async () => {
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'bad-header' }, { 'x-landflow-hook-seq': '1', 'x-landflow-agent': 'agent_nope' }, evePost);
    expect(rowOf('bad-header', eve.id)!.agent_id).toBeNull();
  });
  it('an own session never stores content when a later event carries the agent header', async () => {
    await post('claude-code', { hook_event_name: 'SessionStart', session_id: 'own-then-agent' }, { 'x-landflow-hook-seq': '1' }, evePost);
    await post('claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'own-then-agent', prompt: 'private prompt two' }, { 'x-landflow-hook-seq': '2', 'x-landflow-agent': shared.id }, evePost);
    const row = rowOf('own-then-agent', eve.id)!;
    expect(row.agent_id).toBeNull();
    expect(JSON.stringify(store.eventsOf(row.id))).not.toContain('private prompt two');
    expect(agentStore.getSession(row.id)).toBeUndefined();
  });
  it('two concurrent first events: the row that wins decides the view, content is stored only in a bound session', async () => {
    for (let i = 0; i < 10; i++) {
      const session = `race-view-${i}`;
      const base = { ownerId: eve.id, harness: 'claude-code', sessionKey: session, prompt: false, tool: false };
      await Promise.all([
        store.applyEvent({ ...base, name: 'SessionStart', agentId: shared.id, orderKey: { kind: 'seq', value: '1'.padStart(20, '0') }, receivedAt: '2026-11-21T10:00:00.000Z', verdict: 'idle', viewFor: (bound) => (bound ? { event: 'SessionStart', content: 'agent content' } : { event: 'SessionStart' }) }),
        store.applyEvent({ ...base, name: 'UserPromptSubmit', orderKey: { kind: 'seq', value: '2'.padStart(20, '0') }, receivedAt: '2026-11-21T10:00:01.000Z', verdict: 'thinking', viewFor: (bound) => (bound ? { event: 'UserPromptSubmit', content: 'agent content' } : { event: 'UserPromptSubmit' }) }),
      ]);
      const row = rowOf(session, eve.id)!;
      const events = JSON.stringify(store.eventsOf(row.id));
      if (row.agent_id) expect(events.match(/agent content/g)).toHaveLength(2);
      else expect(events).not.toContain('agent content');
    }
  });
  it('mirrors a session of an agent the owner may run, with the reply cut under summaries (AS-6)', async () => {
    process.env.LANDFLOW_TRACE_CONTENT = 'summaries';
    const body = (extra: Record<string, unknown>) => ({ session_id: 'agent-yes', ...extra });
    await post('claude-code', body({ hook_event_name: 'SessionStart' }), { 'x-landflow-hook-seq': '1', 'x-landflow-agent': shared.id }, evePost);
    await post('claude-code', body({ hook_event_name: 'UserPromptSubmit', prompt: 'List files' }), { 'x-landflow-hook-seq': '2' }, evePost);
    await post('claude-code', body({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'ls' } }), { 'x-landflow-hook-seq': '3' }, evePost);
    await post('claude-code', body({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'ls' }, tool_response: { out: 'a b c' }, duration_ms: 12 }), { 'x-landflow-hook-seq': '4' }, evePost);
    await post('claude-code', body({ hook_event_name: 'Stop', last_assistant_message: 'r'.repeat(900) }), { 'x-landflow-hook-seq': '5' }, evePost);
    const row = rowOf('agent-yes', eve.id)!;
    expect(row.agent_id).toBe(shared.id);
    const session = agentStore.getSession(row.id)!;
    expect(session).toMatchObject({ source: 'harness', agentId: shared.id, userId: eve.id, status: 'idle' });
    const kinds = session.timeline.map((e) => e.type);
    expect(kinds).toEqual(['user', 'tool', 'assistant']);
    const tool = session.timeline.find((e) => e.type === 'tool')!;
    expect(tool).toMatchObject({ tool: 'Bash', status: 'success', durationMs: 12 });
    expect((tool as { output?: unknown }).output).toBeUndefined();
    const reply = session.timeline.find((e) => e.type === 'assistant')!;
    expect((reply as { text: string }).text.length).toBeLessThan(500);
    // A late event lands in its own place.
    await post('claude-code', body({ hook_event_name: 'UserPromptSubmit', prompt: 'Earlier ask' }), { 'x-landflow-hook-seq': '0' }, evePost);
    expect(agentStore.getSession(row.id)!.timeline.map((e) => e.type === 'user' && e.text)).toEqual(['Earlier ask', 'List files', false, false]);
  });
  it('lists sessions: own only to their owner; agent sessions to readers of the agent', () => {
    const asEve = harnessSessions(eve, { limit: 100 }).sessions;
    expect(asEve.some((s) => s.agentId === shared.id)).toBe(true);
    expect(asEve.every((s) => !s.agentId || s.agentId === shared.id)).toBe(true);
    const asAlice = harnessSessions(alice, { limit: 100 }).sessions;
    // Alice sees her own sessions and the shared agent's session, not Eve's own.
    expect(asAlice.some((s) => s.agentId === shared.id)).toBe(true);
    expect(asAlice.length).toBeGreaterThan(0);
    const eveOwn = database().all<{ id: string }>('SELECT id FROM harness_sessions WHERE owner_id = ? AND agent_id IS NULL', eve.id).map((r) => r.id);
    expect(eveOwn.length).toBeGreaterThan(0);
    for (const id of eveOwn) expect(asAlice.some((s) => s.id === id)).toBe(false);
    // An admin sees no one's own sessions either.
    const asOwner = harnessSessions(owner, { limit: 500 }).sessions;
    for (const id of eveOwn) expect(asOwner.some((s) => s.id === id)).toBe(false);
    expect(asOwner.some((s) => s.agentId === shared.id)).toBe(true);
  });
  it('pages GET /api/harness/sessions with limit and cursor', async () => {
    const get = (query: string) => sessionsRoute.GET(new Request(`http://harness.test/api/harness/sessions?${query}`, { headers: { authorization: `Bearer ${aliceKey}` } }));
    const first = (await (await get('limit=2')).json()) as { sessions: Array<{ id: string }>; nextCursor?: string };
    expect(first.sessions).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (await get(`limit=2&cursor=${first.nextCursor}`)).json()) as { sessions: Array<{ id: string }> };
    expect(second.sessions.length).toBeGreaterThan(0);
    expect(second.sessions.some((s) => first.sessions.some((f) => f.id === s.id))).toBe(false);
    expect((await get('limit=0')).status).toBe(400);
  });
});

describe('live events (T-7)', () => {
  const ownEvent = (ownerId: string) => ({ channel: 'harness' as const, ownerId, session: { id: 'hs_1', harness: 'claude-code', status: 'working' as const, stale: false, changedAt: 'x', lastEventAt: 'x', openedAt: 'x', prompts: 0, toolCalls: 0 } });
  it('an own-session event reaches its owner only: not an admin, not another member', () => {
    expect(liveEventFilter(alice)(ownEvent(alice.id))).toBe(true);
    expect(liveEventFilter(owner)(ownEvent(alice.id))).toBe(false);
    expect(liveEventFilter(eve)(ownEvent(alice.id))).toBe(false);
    expect(liveEventFilter(owner)(ownEvent(owner.id))).toBe(true);
  });
  it('an agent-session event follows the agent rule', () => {
    const agent = agentStore.create({ name: 'Live Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
    const team = createTeamProject({ name: 'Live team' });
    setHomeProject('agent', agent.id, team.id);
    const event = { ...ownEvent(alice.id), agentId: agent.id };
    expect(liveEventFilter(owner)(event)).toBe(true);
    expect(liveEventFilter(eve)(event)).toBe(false);
  });
  it('publishes a status change on the bus within the request', async () => {
    const seen: Array<{ channel: string; session?: { status: string } }> = [];
    const stop = bus.subscribe((e) => seen.push(e as never));
    await send('bus-1', 'UserPromptSubmit');
    stop();
    expect(seen.find((e) => e.channel === 'harness')?.session?.status).toBe('thinking');
  });
});

describe('late events, the mirror bounds and the kind filter (review round 2)', () => {
  it('counts late events toward the per-session cap: past it only the name is stored', async () => {
    await send('late-cap', 'SessionStart');
    await send('late-cap', 'UserPromptSubmit', { prompt: 'x' });
    const row = rowOf('late-cap')!;
    const insert = (n: number) => database().insertNew('harness_events', { id: `he_fill_${n}`, session_id: row.id, order_key: String(1000 + n).padStart(20, '0'), name: 'PreToolUse', received_at: '2026-11-21T10:00:00.000Z', data: '{}' });
    for (let i = 0; i < store.MAX_EVENTS_PER_SESSION; i++) insert(i);
    await post('claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'late-cap', prompt: 'a late secret' }, { 'x-landflow-hook-seq': '1' });
    const late = eventsOfSession('late-cap').find((e) => e.orderKey === '1'.padStart(20, '0'))!;
    expect(late.data).toEqual({ event: 'UserPromptSubmit' });
  });

  it('rebuilds the mirror only for a late event inside the tail, and at most once a second per session', async () => {
    const { mirrorEvent } = await import('@/lib/server/harness/mirror');
    const agent = agentStore.create({ name: 'Rebuild Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
    const row = { id: 'hs_rebuild', owner_id: alice.id, harness: 'claude-code', session_key: 'rb', agent_id: agent.id, project_id: null, status: 'thinking', order_kind: 'seq', last_order: '9', last_event_at: '2026-11-21T10:00:00.000Z', opened_at: '2026-11-21T10:00:00.000Z', closed_at: null, data: '{}' } as store.SessionRow;
    const ev = (n: number) => database().insertNew('harness_events', { id: `he_rb_${n}`, session_id: row.id, order_key: String(n).padStart(20, '0'), name: 'UserPromptSubmit', received_at: '2026-11-21T10:00:00.000Z', data: JSON.stringify({ prompt: `p${n}` }) });
    for (let n = 10; n < 10 + store.MIRROR_TAIL; n++) ev(n);
    const t = Date.parse('2026-11-21T12:00:00.000Z');
    // Older than the whole tail: nothing is rebuilt (the mirror does not show it anyway).
    ev(1);
    mirrorEvent(row, { id: 'he_rb_1', name: 'UserPromptSubmit', view: { prompt: 'p1' }, at: 'x', orderKey: '1'.padStart(20, '0') }, true, t);
    expect(agentStore.getSession(row.id)!.timeline).toHaveLength(0);
    // Inside the tail: rebuilt once, and a second one inside the same second waits for the next chance.
    ev(5000);
    mirrorEvent(row, { id: 'he_rb_5000', name: 'UserPromptSubmit', view: { prompt: 'p5000' }, at: 'x', orderKey: '5000'.padStart(20, '0') }, true, t + 10);
    expect(agentStore.getSession(row.id)!.timeline).toHaveLength(store.MIRROR_TAIL);
    ev(5001);
    mirrorEvent(row, { id: 'he_rb_5001', name: 'UserPromptSubmit', view: { prompt: 'p5001' }, at: 'x', orderKey: '5001'.padStart(20, '0') }, true, t + 500);
    expect(JSON.stringify(agentStore.getSession(row.id)!.timeline)).not.toContain('p5001');
    ev(5002);
    mirrorEvent(row, { id: 'he_rb_5002', name: 'UserPromptSubmit', view: { prompt: 'p5002' }, at: 'x', orderKey: '5002'.padStart(20, '0') }, false, t + 1500);
    expect(JSON.stringify(agentStore.getSession(row.id)!.timeline)).toContain('p5001');
  });

  it('a late event inside the throttle is rebuilt by one trailing rebuild, with no later event needed', async () => {
    vi.useFakeTimers();
    try {
      const { mirrorEvent } = await import('@/lib/server/harness/mirror');
      const agent = agentStore.create({ name: 'Trailing Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
      const row = { id: 'hs_trailing', owner_id: alice.id, harness: 'claude-code', session_key: 'tr', agent_id: agent.id, project_id: null, status: 'ended', order_kind: 'seq', last_order: '9', last_event_at: '2026-11-21T10:00:00.000Z', opened_at: '2026-11-21T10:00:00.000Z', closed_at: null, data: '{}' } as store.SessionRow;
      const ev = (n: number) => database().insertNew('harness_events', { id: `he_tr_${n}`, session_id: row.id, order_key: String(n).padStart(20, '0'), name: 'UserPromptSubmit', received_at: '2026-11-21T10:00:00.000Z', data: JSON.stringify({ prompt: `t${n}` }) });
      const t = Date.now();
      ev(10);
      mirrorEvent(row, { id: 'he_tr_10', name: 'UserPromptSubmit', view: { prompt: 't10' }, at: 'x', orderKey: '10'.padStart(20, '0') }, true, t);
      ev(11);
      mirrorEvent(row, { id: 'he_tr_11', name: 'UserPromptSubmit', view: { prompt: 't11' }, at: 'x', orderKey: '11'.padStart(20, '0') }, true, t + 100);
      expect(JSON.stringify(agentStore.getSession(row.id)!.timeline)).not.toContain('t11');
      await vi.advanceTimersByTimeAsync(1500);
      expect(JSON.stringify(agentStore.getSession(row.id)!.timeline)).toContain('t11');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a closed session is rebuilt at once, throttle or not', async () => {
    const { mirrorEvent } = await import('@/lib/server/harness/mirror');
    const agent = agentStore.create({ name: 'Closed Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
    const row = { id: 'hs_closed', owner_id: alice.id, harness: 'claude-code', session_key: 'cl', agent_id: agent.id, project_id: null, status: 'ended', order_kind: 'seq', last_order: '9', last_event_at: '2026-11-21T10:00:00.000Z', opened_at: '2026-11-21T10:00:00.000Z', closed_at: '2026-11-21T10:00:01.000Z', data: '{}' } as store.SessionRow;
    const ev = (n: number) => database().insertNew('harness_events', { id: `he_cl_${n}`, session_id: row.id, order_key: String(n).padStart(20, '0'), name: 'UserPromptSubmit', received_at: '2026-11-21T10:00:00.000Z', data: JSON.stringify({ prompt: `c${n}` }) });
    const t = Date.now();
    ev(10);
    mirrorEvent(row, { id: 'he_cl_10', name: 'UserPromptSubmit', view: { prompt: 'c10' }, at: 'x', orderKey: '10'.padStart(20, '0') }, true, t);
    ev(11);
    mirrorEvent(row, { id: 'he_cl_11', name: 'UserPromptSubmit', view: { prompt: 'c11' }, at: 'x', orderKey: '11'.padStart(20, '0') }, true, t + 10);
    expect(JSON.stringify(agentStore.getSession(row.id)!.timeline)).toContain('c11');
  });

  it('counts the size cap in bytes, not characters', async () => {
    const { capTimelineSize, timelineBytes } = await import('@/lib/server/harness/mirror');
    const entries = Array.from({ length: 4 }, (_, i) => ({ id: `u${i}`, type: 'user' as const, text: 'é'.repeat(300_000), at: 'a' }));
    expect(timelineBytes(entries)).toBeGreaterThan(JSON.stringify(entries).length);
    const kept = capTimelineSize(entries, 1_000_000);
    expect(timelineBytes(kept)).toBeLessThanOrEqual(1_000_000);
    expect(kept.at(-1)!.id).toBe('u3');
  });

  it('caps the mirrored timeline by size, dropping the oldest', async () => {
    const { capTimelineSize } = await import('@/lib/server/harness/mirror');
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, type: 'user' as const, text: 'x'.repeat(300_000), at: 'a' }));
    const kept = capTimelineSize(entries);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(2_000_000);
    expect(kept.at(-1)!.id).toBe('u9');
    expect(kept.length).toBeLessThan(10);
    expect(capTimelineSize([entries[0]!], 10)).toHaveLength(1);
  });

  it('filters the list by kind in the query', () => {
    const own = harnessSessions(eve, { limit: 100, kind: 'own' }).sessions;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((s) => !s.agentId)).toBe(true);
    const agents = harnessSessions(eve, { limit: 100, kind: 'agent' }).sessions;
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((s) => s.agentId)).toBe(true);
    expect(harnessSessions(eve, { limit: 100, kind: 'own', agentId: 'x' }).sessions).toEqual([]);
  });
});

describe('upkeep (T-8)', () => {
  it('prunes events older than 14 days and keeps newer ones', async () => {
    const session = (await store.applyEvent({ ownerId: alice.id, harness: 'claude-code', sessionKey: 'prune-1', name: 'SessionStart', orderKey: { kind: 'seq', value: '1'.padStart(20, '0') }, receivedAt: '2026-11-01T00:00:00.000Z', verdict: 'idle', viewFor: () => ({}), prompt: false, tool: false })).session;
    database().insertNew('harness_events', { id: 'he_old', session_id: session.id, order_key: '0', name: 'Stop', received_at: '2026-10-01T00:00:00.000Z', data: '{}' });
    database().insertNew('harness_events', { id: 'he_new', session_id: session.id, order_key: '9', name: 'Stop', received_at: '2026-11-20T00:00:00.000Z', data: '{}' });
    prune(Date.parse('2026-11-21T00:00:00.000Z'));
    const ids = database().all<{ id: string }>('SELECT id FROM harness_events').map((r) => r.id);
    expect(ids).toContain('he_new');
    expect(ids).not.toContain('he_old');
  });
});

describe('limits and bounds (review fixes)', () => {
  it('limits all of one owner’s keys together', async () => {
    process.env.LANDFLOW_HARNESS_OWNER_EVENTS_PER_SECOND = '3';
    try {
      const now = Date.parse('2026-11-21T15:00:00.000Z');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await ingestHookEvent({ harness: 'claude-code', actor: alice, keyId: `key_many_${i}`, payload: { hook_event_name: 'SessionStart', session_id: 'owner-lim' }, headers: { get: () => null }, now })).status);
      expect(statuses).toEqual([204, 204, 204, 429, 429]);
    } finally {
      delete process.env.LANDFLOW_HARNESS_OWNER_EVENTS_PER_SECOND;
    }
  });
  it('past the per-session event cap the status moves but only the event name is stored', async () => {
    await send('cap-events', 'SessionStart');
    const row = rowOf('cap-events')!;
    database().upsert('harness_sessions', { ...(row as unknown as Record<string, string | null>), data: JSON.stringify({ ...JSON.parse(row.data), events: store.MAX_EVENTS_PER_SESSION + 1 }) });
    await send('cap-events', 'UserPromptSubmit', { prompt: 'x' });
    const events = eventsOfSession('cap-events');
    expect(events.at(-1)).toMatchObject({ name: 'UserPromptSubmit', data: { event: 'UserPromptSubmit' } });
    expect(rowOf('cap-events')!.status).toBe('thinking');
  });
  it('sweep closes the oldest even with hundreds of already-told stale rows', async () => {
    const base = Date.parse('2026-11-22T00:00:00.000Z');
    const row = (id: string, ago: number, told: boolean) => ({ id, owner_id: 'usr_sweep', harness: 'claude-code', session_key: id, agent_id: null, project_id: null, status: 'idle', order_kind: 'seq', last_order: '1', last_event_at: new Date(base - ago).toISOString(), opened_at: new Date(base - ago).toISOString(), closed_at: null, data: JSON.stringify({ prompts: 0, toolCalls: 0, events: 1, changedAt: 'x', ...(told && { staleSent: true }) }) });
    for (let i = 0; i < 600; i++) database().upsert('harness_sessions', row(`hs_told_${i}`, 3_600_000, true));
    database().upsert('harness_sessions', row('hs_old_one', 25 * 3_600_000, false));
    const changed = await sweep(base);
    expect(changed.some((r) => r.id === 'hs_old_one' && r.status === 'ended')).toBe(true);
    expect(changed.some((r) => r.id.startsWith('hs_told_'))).toBe(false);
  });
  it('publishes a wake from stale even when the status is the same', async () => {
    const t = Date.parse('2026-11-21T16:00:00.000Z');
    const h = (n: number) => ({ get: (name: string) => (name === 'x-landflow-hook-seq' ? String(n) : null) });
    const call = (n: number, now: number) => ingestHookEvent({ harness: 'claude-code', actor: alice, keyId: 'key_wake', payload: { hook_event_name: 'UserPromptSubmit', session_id: 'wake-ingest-1' }, headers: h(n), now });
    await call(1, t);
    const seen: unknown[] = [];
    const stop = bus.subscribe((e) => e.channel === 'harness' && seen.push(e));
    await call(2, t + 5000);
    expect(seen).toHaveLength(0);
    await call(3, t + 40 * 60_000);
    stop();
    expect(seen).toHaveLength(1);
  });
  it('ignores a client time header far ahead of the server clock', () => {
    const at = new Date('2026-11-21T10:00:00.000Z');
    const get = (value: string) => ({ get: (name: string) => (name === 'x-landflow-hook-time' ? value : null) });
    expect(status.orderKeyOf(get('2099-01-01T00:00:00Z'), at)).toEqual({ kind: 'time', value: at.toISOString() });
    expect(status.orderKeyOf(get('2026-11-21T10:02:00Z'), at).value).toBe('2026-11-21T10:02:00.000Z');
  });
  it('allows only plain tool names', () => {
    expect(privacy.ownEventView({ hook_event_name: 'PreToolUse', tool_name: 'mcp__srv__tool' })).toMatchObject({ tool: 'mcp__srv__tool' });
    expect(privacy.ownEventView({ hook_event_name: 'PreToolUse', tool_name: 'cat /etc/passwd' }).tool).toBeUndefined();
    expect(privacy.ownEventView({ hook_event_name: 'PreToolUse', tool_name: 'a/b' }).tool).toBeUndefined();
  });
  it('caps a mirrored timeline and keeps harness mirrors from evicting other sessions of the agent', async () => {
    const { newSession } = await import('@/lib/server/agents/runtime');
    const agent = agentStore.create({ name: 'Cap Helper', instructions: 'x', model: { provider: 'ollama', model: 'm' } });
    agentStore.saveSession({ ...newSession(agent, { source: 'slack', userId: 'u-slack', version: 'draft' }), id: 'as_keep_me' });
    for (let i = 0; i < 205; i++) agentStore.saveSession({ ...newSession(agent, { source: 'harness', userId: 'u', version: 'draft' }), id: `hs_cap_${i}` });
    expect(agentStore.getSession('as_keep_me')).toBeDefined();
    expect(agentStore.listSessions(agent.id, 500).filter((s) => s.id.startsWith('hs_cap_'))).toHaveLength(200);
    const { mirrorEvent } = await import('@/lib/server/harness/mirror');
    const row = { id: 'hs_long', owner_id: alice.id, harness: 'claude-code', session_key: 'long', agent_id: agent.id, project_id: null, status: 'thinking', order_kind: 'seq', last_order: '1', last_event_at: '2026-11-21T10:00:00.000Z', opened_at: '2026-11-21T10:00:00.000Z', closed_at: null, data: '{}' } as store.SessionRow;
    for (let i = 0; i < 520; i++) mirrorEvent(row, { id: `e${i}`, name: 'UserPromptSubmit', view: { prompt: `p${i}` }, at: '2026-11-21T10:00:00.000Z' }, false);
    expect(agentStore.getSession('hs_long')!.timeline).toHaveLength(store.MIRROR_TAIL);
  });
});
