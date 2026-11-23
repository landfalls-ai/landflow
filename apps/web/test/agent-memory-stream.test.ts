/**
 * C09: the live journal stream (/api/events) carries a run's exact memory block (`saw.memoryText`) only to the person it is for, the agent's
 * editors and instance admins; any other member who can see the workflow gets the sources and not the words.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-memory-stream-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const auth = await import('@/lib/server/auth');
const { guardRequest } = await import('@/lib/server/auth/guard');
const { withAuth } = await import('@/lib/server/auth/context');
const { bus } = await import('@/lib/server/bus');
const { eventStream } = await import('@/lib/server/events-stream');
const projects = await import('@/lib/server/projects');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');

const decoder = new TextDecoder();
let owner: { id: string; token: string };
let viewer: { id: string; token: string };
let person: { id: string; token: string };
let workflowId = '';
let agentId = '';

async function makeUser(email: string, role: 'owner' | 'member') {
  const record = role === 'owner' ? await auth.createOwner({ email, name: email, password: 'password-123' }) : await auth.createUser({ email, name: email, role, password: 'password-123' });
  return { id: record.id, token: auth.createSession(record, 'password').token };
}

function open(token: string, abort: AbortController) {
  const request = new Request('http://localhost:3000/api/events', { headers: { cookie: `landflow_session=${token}` }, signal: abort.signal });
  const gate = guardRequest(request);
  if (!gate.ok) throw new Error('guard refused');
  return withAuth(gate.auth, async () => eventStream(request, { revalidateMs: 5_000, heartbeatMs: 0 }));
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (t: string) => boolean, ms = 800) {
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done(text)) {
    const r = await Promise.race([reader.read(), new Promise<undefined>((res) => setTimeout(res, 50))]);
    if (r && !r.done) text += decoder.decode(r.value);
  }
  return text;
}

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@mem-stream.test', 'owner');
  viewer = await makeUser('viewer@mem-stream.test', 'member');
  person = await makeUser('person@mem-stream.test', 'member');
  const team = projects.createTeamProject({ name: 'Mem stream' }).id;
  workflowId = 'wf_mem_stream';
  store.saveWorkflow({ id: workflowId, name: 'W', nodes: [], connections: [] } as never);
  projects.setMember(team, viewer.id, 'viewer');
  projects.setMember(team, person.id, 'viewer');
  projects.moveResource('workflow', workflowId, team);
  agentId = agentStore.create({ name: 'Streamed', instructions: 'x' } as never).id;
});

const sawEvent = (memoryFor: string) => ({
  type: 'span.updated',
  seq: 1,
  attrs: { saw: { text: 'x', memory: [{ source: 'agent-profile', count: 1, items: [{ id: 'm_a' }] }], memoryText: 'Likes tea secret-words', memoryFor, memoryAgent: agentId } },
});

describe('the live journal stream', () => {
  it('sends the memory text to the person it is for and to an admin, and the sources only to another member', async () => {
    const seen: Record<string, string> = {};
    const aborts: AbortController[] = [];
    const readers: Record<string, ReadableStreamDefaultReader<Uint8Array>> = {};
    for (const [name, user] of [['owner', owner], ['person', person], ['viewer', viewer]] as const) {
      const abort = new AbortController();
      aborts.push(abort);
      readers[name] = (await open(user.token, abort)).body!.getReader();
      seen[name] = await readUntil(readers[name], (t) => t.includes('retry') || t.length > 0, 200);
    }
    bus.publish({ channel: 'journal', workflowId, executionId: 'ex_mem_stream', events: [sawEvent(person.id)] } as never);
    for (const name of Object.keys(readers)) seen[name] += await readUntil(readers[name], (t) => t.includes('agent-profile'));
    expect(seen.owner).toContain('Likes tea secret-words');
    expect(seen.person).toContain('Likes tea secret-words');
    expect(seen.viewer).toContain('agent-profile');
    expect(seen.viewer).not.toContain('secret-words');
    expect(seen.viewer).not.toContain(person.id);
    for (const abort of aborts) abort.abort();
  });
});
