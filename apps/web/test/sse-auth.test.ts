/**
 * /api/events re-authorisation with real credentials (the test bypass is off): a member who loses access to a
 * workflow stops getting its events within the interval, and the stream closes once the session is deleted, the
 * user is disabled, or the user is no longer the one the cookie names.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-sse-auth-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { withAuth } = await import('@/lib/server/auth/context');
const { bus } = await import('@/lib/server/bus');
const { eventStream } = await import('@/lib/server/events-stream');
const projects = await import('@/lib/server/projects');
const { store } = await import('@/lib/server/store');
const { deleteSession } = await import('@/lib/server/auth/sessions');
const { setUserDisabled } = await import('@/lib/server/auth/users');

const decoder = new TextDecoder();
const execution = (workflowId: string, tag: string) => ({ channel: 'execution', workflowId, event: { type: 'x', tag } }) as never;
const registryEvent = (n: number) => ({ channel: 'registry', event: { type: 'test', n } }) as never;

let owner: { id: string; session: string };
let member: { id: string; session: string; token: string };
let workflowId = '';

async function makeUser(email: string, role: 'owner' | 'member') {
  const record = role === 'owner' ? await auth.createOwner({ email, name: email, password: 'password-123' }) : await auth.createUser({ email, name: email, role, password: 'password-123' });
  return { record, token: auth.createSession(record, 'password').token };
}

/** Opens /api/events as the cookie's user, through the guard (so currentPrincipal() is the real principal). */
function open(token: string, abort: AbortController) {
  const request = new Request('http://localhost:3000/api/events', { headers: { cookie: `landflow_session=${token}` }, signal: abort.signal });
  const gate = guardRequest(request);
  if (!gate.ok) throw new Error('guard refused');
  return withAuth(gate.auth, async () => eventStream(request, { revalidateMs: 20, heartbeatMs: 0 }));
}

/** A read that was still pending when a drain timed out is kept, so its chunk is not lost to the next drain. */
const pending = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, Promise<ReadableStreamReadResult<Uint8Array>>>();

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, until: (t: string) => boolean, ms = 400) {
  let text = '';
  let ended = false;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until(text)) {
    const read = pending.get(reader) ?? reader.read();
    pending.set(reader, read);
    const r = await Promise.race([read, new Promise<undefined>((res) => setTimeout(res, 40))]);
    if (!r) continue;
    pending.delete(reader);
    if (r.done) {
      ended = true;
      break;
    }
    text += decoder.decode(r.value);
  }
  return { text, ended };
}

beforeAll(async () => {
  auth.disableTestAuth();
  const o = await makeUser('owner@example.com', 'owner');
  owner = { id: o.record.id, session: o.token };
  const m = await makeUser('member@example.com', 'member');
  member = { id: m.record.id, session: m.token, token: m.token };
  const team = projects.createTeamProject({ name: 'Data' }).id;
  workflowId = 'wf_sse_auth';
  store.saveWorkflow({ id: workflowId, name: 'W', nodes: [], connections: [] } as never);
  projects.setMember(team, member.id, 'viewer');
  projects.moveResource('workflow', workflowId, team);
});

describe('/api/events re-authorisation', () => {
  it('a member sees the workflow’s events, and stops once their access is removed, registry events still arriving', async () => {
    const abort = new AbortController();
    const response = await open(member.token, abort);
    const reader = response.body!.getReader();
    await drain(reader, () => false, 60);
    bus.publish(execution(workflowId, 'before'));
    const before = await drain(reader, (t) => t.includes('before'));
    expect(before.text).toContain('before');

    const team = projects.homeProjectId('workflow', workflowId)!;
    projects.removeMember(team, member.id);
    await new Promise((r) => setTimeout(r, 80));
    bus.publish(execution(workflowId, 'after'));
    bus.publish(registryEvent(777));
    const after = await drain(reader, (t) => t.includes('"n":777'));
    abort.abort();
    expect(after.text).toContain('"n":777');
    expect(after.text).not.toContain('after');
  });

  it('closes when the session is deleted', async () => {
    const { token } = await makeUser('gone@example.com', 'member');
    const abort = new AbortController();
    const reader = (await open(token, abort)).body!.getReader();
    await drain(reader, () => false, 60);
    deleteSession(token);
    const result = await drain(reader, () => false, 400);
    abort.abort();
    expect(result.ended).toBe(true);
  });

  it('closes when the user is disabled', async () => {
    const { record, token } = await makeUser('off@example.com', 'member');
    const abort = new AbortController();
    const reader = (await open(token, abort)).body!.getReader();
    await drain(reader, () => false, 60);
    setUserDisabled(record.id, true);
    const result = await drain(reader, () => false, 400);
    abort.abort();
    expect(result.ended).toBe(true);
  });

  it('refuses a request with no valid credentials with 401', () => {
    const response = eventStream(new Request('http://localhost:3000/api/events'));
    expect(response.status).toBe(401);
  });
});
