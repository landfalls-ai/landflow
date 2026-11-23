/**
 * C36-B (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see): the access chat for a requester with no Landflow account. The File
 * Access Request tool names its requester from the run (`ext_…`, resolved through access/principal.ts), shows only the entries open to
 * outsiders, keeps the confirmation rule (read back, then a later message), refuses a requester who no longer stands, and the route limits the
 * messages (10 a minute and 100 a day each, an instance-wide hourly cap, 2,000 characters). C36-A's modules are mocks, as in
 * access-outside-requests.test.ts; the agent loop runs against a fake model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeModels } from './fake-ai-services';

interface FakeOutsider {
  id: string;
  email: string;
  name: string | null;
  verifiedBy: 'link' | 'google';
  blocked: boolean;
}
const h = vi.hoisted(() => ({
  outsiders: new Map<string, FakeOutsider>(),
  settings: { enabled: true, domains: ['partner.test'], google: { enabled: false } as { enabled: boolean; credentialId?: string } },
  takes: [] as Array<{ bucket: string; key: string; limit: number; windowMs: number }>,
  hits: new Map<string, number>(),
  deny: new Set<string>(),
}));
vi.mock('@/lib/server/access/outside/identity', () => ({ getOutsideRequester: (id: string) => h.outsiders.get(id), outsideRequesterByEmail: () => undefined }));
vi.mock('@/lib/server/access/outside/sessions', () => ({
  requesterFromRequest: async (req: Request) => {
    const found = h.outsiders.get(req.headers.get('x-requester') ?? '');
    return found && !found.blocked ? found : null;
  },
  endSessionsFor: () => undefined,
}));
vi.mock('@/lib/server/access/outside/settings', () => ({
  outsideSettings: () => h.settings,
  domainAllowed: (email: string) => h.settings.domains.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase()),
}));
// A counting stand-in for the limiter: the route's numbers are recorded, a bucket can be told to refuse, and the counts are real.
vi.mock('@/lib/server/access/outside/limits', () => ({
  // Shared (the API limiter's store), so every main counts together; the route must use this one.
  takeOutsideShared: async (bucket: string, key: string, limit: number, windowMs: number) => {
    h.takes.push({ bucket, key, limit, windowMs });
    if (h.deny.has(bucket)) return false;
    const id = `${bucket}:${key}`;
    const used = h.hits.get(id) ?? 0;
    if (used >= limit) return false;
    h.hits.set(id, used + 1);
    return true;
  },
}));

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-outside-chat-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const script = { token: undefined as string | undefined };
const models = await startFakeModels({
  reply: (_provider, body) => {
    const last = body.messages[body.messages.length - 1];
    const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
    const result = parts.find((p: { type: string }) => p.type === 'tool_result');
    const toolName = body.tools?.[0]?.name as string | undefined;
    if (result) {
      const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      const token = /"confirmToken":"([^"]+)"/.exec(text)?.[1];
      if (token) script.token = token;
      return { text: token ? 'Shall I file this? Say yes.' : `Done: ${text.slice(0, 300)}` };
    }
    const said = String(parts.find((p: { type: string }) => p.type === 'text')?.text ?? '');
    if (/boom/.test(said)) return { error: { status: 500, body: JSON.stringify({ error: { message: 'upstream said: key sk-live-SECRET123 is over quota' } }) } };
    const args = { entry: 'Platform team', duration: '1 h', reason: 'Fixing the build', account: 'erin-chat' };
    if (/yes/i.test(said) && script.token) return { toolCalls: [{ id: 'call_2', name: toolName!, arguments: { ...args, confirmToken: script.token } }] };
    return { toolCalls: [{ id: 'call_1', name: toolName!, arguments: args }] };
  },
});
afterAll(async () => {
  await models.close?.();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  delete process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR;
});

const { makeWorld } = await import('./fixtures/access-world');
const { fileAccessFromChat, runAccessChat, outsideChatPerHour, verifyToken } = await import('@/lib/server/access/chat');
const { requesterOfOutside } = await import('@/lib/server/access/principal');
const { updateEntry } = await import('@/lib/server/access/catalog');
const { cancelRequest } = await import('@/lib/server/access/requests');
const { installAccessRequests } = await import('@/lib/server/access/setup');
const { accessSettings, saveAccessSettings } = await import('@/lib/server/access/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const chatRoute = await import('@/app/request-access/api/chat/route');

const w = await makeWorld();
const { mia, admin, team, group, manual, fake } = w;
for (const entry of [team, group]) updateEntry(admin, entry.id, { outsideMayAsk: true }, entry.version);

const outsider = (key: string, email: string): FakeOutsider => {
  const record = { id: `ext_${key}`, email, name: null, verifiedBy: 'link' as const, blocked: false };
  h.outsiders.set(record.id, record);
  return record;
};
const erin = outsider('erin', 'erin@partner.test');
const dana = outsider('dana', 'dana@partner.test');
const base = { entry: 'Platform team', duration: '1 h', reason: 'Fixing the build', account: 'erin-chat' };
const filed = () => database().get<{ n: number }>(`SELECT COUNT(*) AS n FROM access_requests WHERE channel = 'chat' AND requester_kind = 'outside'`)!.n;

beforeEach(() => {
  h.settings.enabled = true;
  h.settings.domains = ['partner.test'];
  h.takes.length = 0;
  h.hits.clear();
  h.deny.clear();
  delete process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR;
  erin.blocked = false;
});

describe('the tool for an outside requester', () => {
  it('lists only the entries open to outsiders, and reads the request back with who is asking', async () => {
    const none = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_a', entry: '' });
    expect(none).toMatchObject({ status: 'need', candidates: ['Engineering group', 'Platform team'] });
    expect(none.candidates).not.toContain('Figma editor');
    expect(await fileAccessFromChat({ userId: erin.id, executionId: 'ex_a', ...base, entry: 'Figma editor' })).toMatchObject({ status: 'need', candidates: ['Engineering group', 'Platform team'] });
    const answer = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_a', ...base });
    expect(answer.status).toBe('confirm');
    expect(answer.summary).toContain('erin@partner.test (outside) asks for Platform team');
    expect(answer.summary).toContain('Who: outside requester erin@partner.test (email verified by link)');
    expect(verifyToken(answer.confirmToken!)).toMatchObject({ u: erin.id, e: team.id, d: 60, x: 'ex_a' });
    void manual;
  });

  it('files a chat request in a later run, as an outside requester, and never names an approver', async () => {
    const { confirmToken } = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_b', ...base });
    const before = filed();
    const answer = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_c', ...base, confirmToken });
    expect(answer).toMatchObject({ status: 'filed', requestId: expect.any(String), state: 'pending', message: 'Your request was filed. An approver will decide it.' });
    expect(filed()).toBe(before + 1);
    expect(w.requestRow(answer.requestId!)).toMatchObject({ channel: 'chat', requester_id: erin.id, requester_kind: 'outside', status: 'pending', account: 'erin-chat' });
    await cancelRequest(admin, answer.requestId!);
  });

  it('files nothing in the same run, with a changed field, or with a token made for someone else', async () => {
    const before = filed();
    const { confirmToken } = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_d', ...base });
    for (const [label, call] of [
      ['the same run', { userId: erin.id, executionId: 'ex_d', ...base, confirmToken }],
      ['another outsider', { userId: dana.id, executionId: 'ex_e', ...base, confirmToken }],
      ['a Landflow user', { userId: mia.id, executionId: 'ex_e', ...base, confirmToken }],
      ['a changed duration', { userId: erin.id, executionId: 'ex_e', ...base, duration: '15 min', confirmToken }],
      ['a changed account', { userId: erin.id, executionId: 'ex_e', ...base, account: 'someone-else', confirmToken }],
    ] as const) expect((await fileAccessFromChat(call)).status, label).toBe('refused');
    expect(filed()).toBe(before);
  });

  it('a Google entry reads back and files with the verified email, whatever the person says', async () => {
    const answer = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_f', entry: 'Engineering group', duration: 'unlimited', reason: 'Join the group', account: 'someone@else.test' });
    expect(answer.status).toBe('confirm');
    expect(answer.summary).toContain('Account: erin@partner.test');
    expect(answer.summary).not.toContain('someone@else.test');
    const filedAnswer = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_g', entry: 'Engineering group', duration: 'unlimited', reason: 'Join the group', account: 'someone@else.test', confirmToken: answer.confirmToken });
    expect(filedAnswer.status).toBe('filed');
    expect(w.requestRow(filedAnswer.requestId!)!.account).toBe('erin@partner.test');
    await cancelRequest(admin, filedAnswer.requestId!);
  });

  it('refuses a requester who is blocked, whose domain went, whose feature is off, or who is unknown: sign in again', async () => {
    const before = filed();
    const { confirmToken } = await fileAccessFromChat({ userId: erin.id, executionId: 'ex_h', ...base });
    erin.blocked = true;
    expect(await fileAccessFromChat({ userId: erin.id, executionId: 'ex_i', ...base, confirmToken })).toMatchObject({ status: 'refused', message: expect.stringMatching(/Sign in again/) });
    erin.blocked = false;
    h.settings.domains = ['other.test'];
    expect((await fileAccessFromChat({ userId: erin.id, executionId: 'ex_i', ...base, confirmToken })).status).toBe('refused');
    h.settings.domains = ['partner.test'];
    h.settings.enabled = false;
    expect((await fileAccessFromChat({ userId: erin.id, executionId: 'ex_i', ...base })).status).toBe('refused');
    h.settings.enabled = true;
    expect((await fileAccessFromChat({ userId: 'ext_nobody', executionId: 'ex_i', ...base })).status).toBe('refused');
    expect(filed()).toBe(before);
  });

  it('leaves a Landflow user’s chat as it was (their entries, their name, their page)', async () => {
    const answer = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_j', ...base, account: 'mia-gh' });
    expect(answer.summary).toContain('Mia Member asks for Platform team');
    expect(answer.summary).not.toContain('Who:');
    expect((await fileAccessFromChat({ userId: mia.id, executionId: 'ex_j', ...base, entry: 'Figma editor' })).status).toBe('confirm');
  });
});

describe('the chat route: limits', () => {
  const post = (who: FakeOutsider | undefined, message = 'hi', sessionId = 'tab1') =>
    chatRoute.POST(new Request('http://landflow.test/request-access/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...(who && { 'x-requester': who.id }) }, body: JSON.stringify({ message, sessionId }) }));

  it('needs the requester session', async () => {
    expect((await post(undefined)).status).toBe(401);
  });

  it('takes the three limits from the plan: 10 a minute and 100 a day each, 600 an hour for everyone', async () => {
    saveAccessSettings({ workflowId: accessSettings().workflowId, projectId: accessSettings().projectId });
    const answer = await post(erin);
    expect(answer.status).toBe(409); // the chat flow is not installed yet: the limits were taken before
    expect(h.takes).toEqual([
      { bucket: 'access-chat-minute', key: erin.id, limit: 10, windowMs: 60_000 },
      { bucket: 'access-chat-day', key: erin.id, limit: 100, windowMs: 86_400_000 },
      { bucket: 'access-chat-all', key: 'instance', limit: 600, windowMs: 3_600_000 },
    ]);
    expect(outsideChatPerHour()).toBe(600);
  });

  it('refuses the 11th message in a minute (429, Retry-After) without using the others’ share', async () => {
    for (let i = 0; i < 10; i++) expect((await post(erin)).status).toBe(409);
    const over = await post(erin);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('60');
    expect(await over.json()).toMatchObject({ code: 'rate_limited' });
    // The instance counter was taken ten times, not eleven; someone else is not over any limit.
    expect(h.hits.get('access-chat-all:instance')).toBe(10);
    expect((await post(dana)).status).toBe(409);
  });

  it('refuses when the day’s limit is used, and when the instance cap is (“The chat is busy; use the form”)', async () => {
    h.deny.add('access-chat-day');
    const day = await post(erin);
    expect(day.status).toBe(429);
    expect((await day.json()).error).toMatch(/today/);
    h.deny.clear();
    process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR = '2';
    expect((await post(erin)).status).toBe(409);
    expect((await post(dana)).status).toBe(409);
    const busy = await post(erin);
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ error: 'The chat is busy; use the form', code: 'rate_limited' });
  });

  it('0 turns the outside chat off (409), and a message over 2,000 characters is a 400', async () => {
    process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR = '0';
    expect(outsideChatPerHour()).toBe(0);
    const off = await post(erin);
    expect(off.status).toBe(409);
    expect((await off.json()).error).toMatch(/use the form/);
    expect(h.takes).toEqual([]);
    delete process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR;
    expect((await post(erin, 'x'.repeat(2_001))).status).toBe(400);
    expect(h.takes).toEqual([]);
  });
});

describe('the chat flow with a model, for an outside requester', () => {
  it('reads it back, then files after “yes” in the next message, with the run started by the ext_ id', async () => {
    const credential = credentials.create({ name: 'Fake Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: models.origin } });
    setHomeProject('credential', credential.id, accessSettings().projectId!);
    saveAccessSettings({ workflowId: accessSettings().workflowId, projectId: accessSettings().projectId });
    await installAccessRequests(w.owner, { modelCredentialId: credential.id });
    const before = filed();

    const first = await runAccessChat(requesterOfOutside(erin), { message: 'I need the platform team for an hour, my GitHub is erin-chat', sessionId: 'tab1' });
    expect(first.reply).toContain('Shall I file this');
    expect(first.requestId).toBeUndefined();
    expect(filed()).toBe(before);

    const second = await runAccessChat(requesterOfOutside(erin), { message: 'yes', sessionId: 'tab1' });
    expect(filed()).toBe(before + 1);
    expect(second.requestId).toEqual(expect.any(String));
    expect(w.requestRow(second.requestId!)).toMatchObject({ channel: 'chat', requester_id: erin.id, requester_kind: 'outside', status: 'pending' });
    // The run itself was the outsider's: the Run Trace and the usage count name the ext_ id.
    const runs = database().all<{ data: string }>(`SELECT data FROM executions WHERE mode = 'chat' ORDER BY started_at DESC LIMIT 2`);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(JSON.parse(run.data).startedBy).toBe(erin.id);
    await cancelRequest(admin, second.requestId!);
    void fake;
  });

  it('answers a failed run with a plain sentence for an outsider, never the model provider’s message', async () => {
    const outsideFailure = await runAccessChat(requesterOfOutside(erin), { message: 'boom please', sessionId: 'tab9' }).catch((e: Error & { status?: number }) => e);
    expect(outsideFailure).toMatchObject({ status: 502, message: 'The chat could not answer. Use the form instead.' });
    expect(String((outsideFailure as Error).message)).not.toMatch(/SECRET|quota|upstream/);
  });

  it('refuses a blocked requester’s next turn before any model call, and one over a switched-off feature', async () => {
    erin.blocked = true;
    await expect(runAccessChat(requesterOfOutside(erin), { message: 'yes', sessionId: 'tab1' })).rejects.toMatchObject({ status: 401 });
    erin.blocked = false;
    process.env.LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR = '0';
    await expect(runAccessChat(requesterOfOutside(erin), { message: 'hi', sessionId: 'tab1' })).rejects.toMatchObject({ status: 409 });
  });
});
