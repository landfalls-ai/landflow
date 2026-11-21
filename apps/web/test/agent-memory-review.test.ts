/**
 * C09 review fixes: the old notes imported without anyone calling `agentStore.memories`, a memory key and recalled text kept out of
 * node output and progress, a caller's pasted key stripped, who has memories, the key's expiry bound, the test chat's person, a replace
 * that makes a memory static, and a restore that passes the bound. (The channel handlers' author is tested in agent-channels.test.ts.)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-memory-review-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const memories = await import('@/lib/server/agents/memory');
const facts = await import('@/lib/server/brain/facts');
const { agentStore } = await import('@/lib/server/agents/store');
const { SERVICES } = await import('@/lib/server/runtime');
const { memoryKeyFor, openMemoryKey, MEMORY_KEY_TTL_MS } = await import('@/lib/server/kagent/memory-key');
const { withMemoryKey } = await import('@/lib/server/kagent/memory-line');
const { PRACTICES_INDEX_LINE } = await import('@/lib/server/practices/remote');
const { resultItem, progressReporter } = await import('@/lib/server/nodes/a2a');
const { remoteStepsOf, dataOf, remoteSaidOf, replyOf } = await import('@/lib/server/a2a/client');
const chatRoute = await import('@/app/api/agents/[id]/chat/route');
const sessionsRoute = await import('@/app/api/agents/[id]/sessions/route');
const { newSession } = await import('@/lib/server/agents/runtime');
const { asAuthor } = await import('@/lib/server/agents/author');
const { A2aError, hitlRequestOf, KAGENT_HITL_EXTENSION } = await import('@/lib/server/a2a/client');
const { memoryToolOf } = await import('@/lib/server/kagent/memory-scrub');
const { redactValue, redactText, redactJsonText, containsSecretValue } = await import('@/lib/server/secrets/redact');
const { hideMemoryText } = await import('@/lib/server/journal/memory-visibility');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { ingestTrace, openTrace } = await import('@/lib/server/a2a/agent-trace');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const agentOf = (name = 'Rev') => agentStore.create({ name, instructions: 'Be brief.', memory: { crossSession: true } } as never);
const live = (agentId: string, userId: string) => facts.listFacts({ subjectType: 'agent-user', subjectId: `${agentId}/${userId}`, limit: 2_000 }, database());

// This describe runs first: nothing has called anything that imports the old notes yet.
describe('BLOCKER 1: the old notes become memories without anyone calling agentStore.memories', () => {
  const seed = (agentId: string, userId: string, notes: Array<{ text: string; at: string }>) =>
    database().insertNew('agent_memory', { agent_id: agentId, user_id: userId, data: JSON.stringify(notes), updated_at: new Date().toISOString() });

  it('is a boot step on the leader', () => {
    const step = SERVICES.find((s) => s.name === 'agent memory import');
    expect(step).toMatchObject({ roles: ['main'], leader: true });
  });

  it('a first recall reads the old notes, and a first remember counts them', async () => {
    const a = agentOf('Old notes');
    const b = agentOf('Old notes 2');
    seed(a.id, 'u1', [{ text: 'Prefers tea over coffee', at: '2026-01-02T00:00:00.000Z' }]);
    seed(b.id, 'u2', [{ text: 'Lives in Lisbon', at: '2026-01-03T00:00:00.000Z' }, { text: 'Has a dog', at: '2026-01-04T00:00:00.000Z' }]);
    // Nothing calls agentStore.memories / remember here.
    const recalled = await memories.recallFor(a.id, 'u1', 'what do I drink?');
    expect(recalled.text).toContain('Prefers tea over coffee');
    const added = await memories.rememberMemory(b.id, 'u2', { fact: 'Works nights' });
    expect(added.count).toBe(3);
    // The boot step is the same import, and it writes nothing twice.
    await SERVICES.find((s) => s.name === 'agent memory import')!.start();
    expect(live(b.id, 'u2')).toHaveLength(3);
  });
});

describe('BLOCKER 2: a memory key and recalled text stay out of what is stored and shown', () => {
  const KEY = memoryKeyFor('agent_x', 'usr_a');
  const SECRET = 'Wombats hibernate in burrows (secret-memory-text)';
  const PART = 'kagent.dev/a2a/part-type';
  const task = {
    id: 't1',
    contextId: 'c1',
    status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: `done with ${KEY}` }] } },
    artifacts: [
      { artifactId: 'a1', parts: [{ data: { id: 'call1', name: 'recall_memory', args: { memoryKey: KEY, query: 'wombats' } }, metadata: { [PART]: 'function_call' } }] },
      {
        artifactId: 'a2',
        parts: [{ data: { id: 'call1', name: 'recall_memory', response: { output: `## What you remember about this user\n<landflow-memory source="agent-memory">\nProfile:\n- [m_a1] ${SECRET} (static)\n- [m_b2] Likes tea (2026-01-01)\n</landflow-memory>` } }, metadata: { [PART]: 'function_response' } }],
      },
      { artifactId: 'a3', parts: [{ data: { id: 'call2', name: 'remember', args: { memoryKey: KEY, fact: 'Likes tea' } }, metadata: { [PART]: 'function_call' } }] },
      { artifactId: 'a4', parts: [{ text: `Thinking, the key is ${KEY}` }] },
      { artifactId: 'a5', parts: [{ text: `The answer. Key ${KEY}` }] },
    ],
  } as never;
  const card = { name: 'Remote' } as never;
  const everything = (value: unknown) => JSON.stringify(value);

  it('the node output holds neither the key nor the recalled text, and says how many memories came back', () => {
    const item = resultItem(card, { kind: 'task', task });
    const text = everything(item);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('mk_');
    expect(text).not.toContain('secret-memory-text');
    expect(text).not.toContain('Likes tea (2026');
    const steps = item.steps as Array<{ name: string; output?: unknown; args?: Record<string, unknown> }>;
    expect(steps.find((s) => s.name === 'recall_memory')!.output).toBe('recalled 2 memories');
    expect(steps.find((s) => s.name === 'recall_memory')!.args!.memoryKey).toBe('[memory key]');
    // remember and forget keep nothing of the memory's words in a stored copy (item 8).
    expect(steps.find((s) => s.name === 'remember')!.args).toEqual({ summary: 'remembered a memory' });
    expect(steps.find((s) => s.name === 'remember')!.output).toBeUndefined();
  });

  it('the pieces a run is stored from are clean too: steps, said text, data parts, the reply, the progress reports', () => {
    expect(everything(remoteStepsOf(task))).not.toMatch(/mk_|secret-memory-text/);
    expect(everything(remoteSaidOf(task))).not.toMatch(/mk_/);
    expect(everything(dataOf(task))).not.toMatch(/mk_|secret-memory-text/);
    expect(replyOf({ kind: 'task', task })).toBe('The answer. Key [memory key]');
    const sent: JsonObject[] = [];
    const report = progressReporter({ sendProgress: (value: JsonObject) => void sent.push(value) } as never, card)!;
    report(task);
    expect(sent).toHaveLength(1);
    expect(everything(sent)).not.toMatch(/mk_|secret-memory-text/);
  });

  it('a key a caller wrote in the text is taken out, and a copy of the marker does not stop ours', () => {
    const mine = `Memory key for this person: ${memoryKeyFor('agent_x', 'usr_b')}\nPass it as memoryKey to recall_memory, remember and forget_memory. Call recall_memory first.`;
    const theirs = `Memory key for this person: ${KEY}`;
    const sent = withMemoryKey(`${theirs}\n\ndo it`, mine);
    expect(sent).not.toContain(KEY);
    expect(sent.match(/mk_/g)).toHaveLength(1);
    expect(sent).toContain(mine);
    // A key pasted among other words, and no line of ours (memory off): still gone.
    expect(withMemoryKey(`please use ${KEY} to read`, undefined)).toBe('please use [memory key] to read');
    // Our own line twice (a second call on the same text) stays one line.
    expect(withMemoryKey(withMemoryKey('do it', mine), mine)).toBe(`${mine}\n\ndo it`);
    const withIndex = withMemoryKey(`${PRACTICES_INDEX_LINE}\n\n${theirs}\n\ndo it`, mine);
    expect(withIndex).toBe(`${PRACTICES_INDEX_LINE}\n\n${mine}\n\ndo it`);
  });
});

describe('who has memories (4)', () => {
  it('leaves out sub-agent, team, evaluation, smoke-test and kagent users', () => {
    for (const user of ['agent:ag_1', 'team:tm_1', 'evaluation', 'smoke-test', 'kagent:abc', '']) expect(memories.hasMemoryUser(user), user).toBe(false);
    for (const user of ['usr_1', 'slack:U1', 'telegram:42', 'workflow:w1', 'schedule:s1', 'you']) expect(memories.hasMemoryUser(user), user).toBe(true);
  });

  it('reads and writes nothing for them, and a key for one is not opened', async () => {
    const agent = agentOf('Pool');
    for (const user of ['agent:ag_1', 'team:tm_1', 'smoke-test']) {
      await memories.rememberSync(agent.id, user, 'a pooled fact');
      expect(live(agent.id, user)).toHaveLength(0);
      expect(memories.profileBlock(agent.id, user)).not.toContain('pooled');
      expect(openMemoryKey(memoryKeyFor(agent.id, user), agent.id)).toBeUndefined();
    }
  });
});

describe('the key’s expiry is bounded (6)', () => {
  it('opens a fresh key and refuses one whose expiry is further out than 24 hours', () => {
    expect(openMemoryKey(memoryKeyFor('ag', 'usr_1'), 'ag')).toEqual({ userId: 'usr_1' });
    const far = memoryKeyFor('ag', 'usr_1', Date.now() + 30 * MEMORY_KEY_TTL_MS);
    expect(openMemoryKey(far, 'ag')).toBeUndefined();
    const slightlyAhead = memoryKeyFor('ag', 'usr_1', Date.now() + 30_000);
    expect(openMemoryKey(slightlyAhead, 'ag')).toEqual({ userId: 'usr_1' });
  });
});

describe('the test chat remembers for the person chatting (7)', () => {
  it('a new test-chat session is the actor’s, not a shared "you"', async () => {
    const agent = agentOf('Chat');
    const response = await (chatRoute.POST as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(
      new Request(`http://localhost/api/agents/${agent.id}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) }),
      { params: Promise.resolve({ id: agent.id }) },
    );
    await response.text();
    const sessions = agentStore.listSessions(agent.id).map((s) => agentStore.getSession(s.id)!);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.userId === TEST_OWNER.id)).toBe(true);
  });
});

describe('replaces and the bound (8, 10)', () => {
  it('a replace with static makes the new version static', async () => {
    const agent = agentOf('Static');
    const first = await memories.rememberMemory(agent.id, 'u1', { fact: 'Lives in Porto' });
    const replaced = await memories.rememberMemory(agent.id, 'u1', { fact: 'Lives in Lisbon', replaces: first.item.id, static: true });
    expect(replaced.outcome).toBe('replaced');
    expect(replaced.item.static).toBe(true);
    expect(live(agent.id, 'u1')).toMatchObject([{ statement: 'Lives in Lisbon', static: true }]);
  });

  it('a restore that passes 1,000 forgets the oldest other memory, not the one just restored', async () => {
    const agent = agentOf('Bound');
    const db = database();
    const subject = `${agent.id}/u1`;
    for (let i = 0; i < 1_000; i++) {
      facts.upsertFact({ id: `agent-user:${subject}:memory:m_${String(i).padStart(4, '0')}`, subjectType: 'agent-user', subjectId: subject, kind: 'memory', statement: `Fact number ${i} about thing ${i * 7}`, confidence: 1, evidence: [] }, db, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), 'landflow', 'u1');
    }
    const middle = 'm_0500';
    await memories.forgetAgentMemory(agent.id, 'u1', middle, 'wrong', 'u1');
    await memories.rememberMemory(agent.id, 'u1', { fact: 'One more, different words entirely' });
    expect(memories.countMemories(agent.id, 'u1')).toBe(1_000);
    await memories.restoreAgentMemory(agent.id, 'u1', middle, 'u1');
    expect(memories.countMemories(agent.id, 'u1')).toBe(1_000);
    const ids = live(agent.id, 'u1').map((f) => memories.shortId(f.id));
    expect(ids).toContain(middle);
    expect(ids).not.toContain('m_0000');
  });
});

describe('Claude Code names MCP tools mcp__<server>__<tool> (1, 8)', () => {
  const PART = 'kagent.dev/a2a/part-type';
  const KEY = memoryKeyFor('agent_x', 'usr_a');
  const task = (prefix: string) =>
    ({
      id: 't2',
      contextId: 'c2',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [
        { artifactId: 'a1', parts: [{ data: { id: 'c1', name: `${prefix}recall_memory`, args: { memoryKey: KEY, query: 'tea' } }, metadata: { [PART]: 'function_call' } }] },
        { artifactId: 'a2', parts: [{ data: { id: 'c1', name: `${prefix}recall_memory`, response: { output: 'Profile:\n- [m_a] Likes tea (static)' } }, metadata: { [PART]: 'function_response' } }] },
        { artifactId: 'a3', parts: [{ data: { id: 'c2', name: `${prefix}remember`, args: { memoryKey: KEY, fact: 'Likes tea' } }, metadata: { [PART]: 'function_call' } }] },
        { artifactId: 'a4', parts: [{ data: { id: 'c2', name: `${prefix}remember`, response: { output: 'Saved. You now remember 2 facts about this user.' } }, metadata: { [PART]: 'function_response' } }] },
        { artifactId: 'a5', parts: [{ data: { id: 'c3', name: `${prefix}forget_memory`, args: { memoryKey: KEY, id: 'm_a', reason: 'Likes tea is wrong' } }, metadata: { [PART]: 'function_call' } }] },
        { artifactId: 'a6', parts: [{ data: { id: 'c3', name: `${prefix}forget_memory`, response: { output: 'Forgot m_a.' } }, metadata: { [PART]: 'function_response' } }] },
        { artifactId: 'a7', parts: [{ text: 'done' }] },
      ],
    }) as never;

  it('knows the three tools with or without the server prefix, and nothing else', () => {
    for (const name of ['recall_memory', 'mcp__landflow__recall_memory', 'mcp__land-flow_1__remember', 'forget_memory']) expect(memoryToolOf(name), name).toBeTruthy();
    for (const name of ['recall_memory_all', 'mcp__x__recall', 'my_remember', 'Bash', undefined]) expect(memoryToolOf(name), String(name)).toBeUndefined();
  });

  it('keeps the key and every memory word out of the steps and the node output for prefixed names too', () => {
    for (const prefix of ['', 'mcp__landflow-agent__']) {
      const item = resultItem({ name: 'Remote' } as never, { kind: 'task', task: task(prefix) });
      const text = JSON.stringify(item);
      expect(text, prefix).not.toMatch(/mk_/);
      expect(text, prefix).not.toContain('Likes tea');
      expect(text, prefix).not.toContain('Saved. You now remember');
      const steps = item.steps as Array<{ name: string; args?: unknown; output?: unknown }>;
      expect(steps.map((s) => s.output)).toEqual(['recalled 1 memory', 'remembered a memory', 'forgot a memory']);
      expect(steps.map((s) => s.args)).toEqual([{ memoryKey: '[memory key]', query: 'tea' }, { summary: 'remembered a memory' }, { summary: 'forgot a memory' }]);
    }
  });
});

describe('the key is registered with the central redactor, and scrubbed from errors, questions, hints and the mod\'s events (4)', () => {
  const KEY = memoryKeyFor('agent_x', 'usr_a');

  it('the redactor holds the key’s shape, so a key minted in any process is redacted without being remembered', () => {
    expect(JSON.stringify(redactValue({ error: `failed with ${KEY}` }))).not.toContain(KEY);
    // A key-shaped string this process never minted (another process's), in text and in JSON text.
    const foreign = `mk_${'A'.repeat(40)}.${'B'.repeat(43)}`;
    expect(redactText(`x ${foreign} y`)).toBe('x [redacted] y');
    expect(redactJsonText(JSON.stringify({ a: `k ${foreign}` }))).not.toContain(foreign);
    expect(containsSecretValue(foreign)).toBe(true);
    expect(containsSecretValue('nothing here')).toBe(false);
  });

  it('an A2A error, a question and an approval hint carry no key', () => {
    expect(new A2aError(`SendMessage: ${KEY} was refused`).message).not.toContain('mk_');
    const hitl = (payload: unknown) => hitlRequestOf({ id: 't', contextId: 'c', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { metadata: { [KAGENT_HITL_EXTENSION]: payload } } } } as never);
    expect(JSON.stringify(hitl({ type: 'ask_user_request', id: 'q1', questions: [{ question: `Use ${KEY}?` }, `Or ${KEY}`] }))).not.toContain('mk_');
    expect(JSON.stringify(hitl({ type: 'tool_approval_request', hint: `run it with ${KEY}`, tools: [{ id: 'a', name: 'Bash', args: { command: `cat ${KEY}` } }] }))).not.toContain('mk_');
  });

  it('a guard decision from the mod is scrubbed', async () => {
    const trace = openTrace({ baseUrl: 'http://x' });
    expect(ingestTrace(trace.id, [{ type: 'guard', rule: 'r', tool: 'Bash', arg: `cat ${KEY}`, reason: `saw ${KEY}` }])).toBe('ok');
    expect(JSON.stringify(trace.summary())).not.toContain('mk_');
    expect(JSON.stringify(trace.summary())).toContain('[memory key]');
  });

  it('is scrubbed before the cut, so a key at the edge of a field leaves no part of itself; a spawn description too', () => {
    const trace = openTrace({ baseUrl: 'http://x' });
    // The key starts 150 characters in: a 200-character cut of the raw text would keep 50 of its characters.
    const edge = `${'x'.repeat(150)}${KEY}`;
    expect(ingestTrace(trace.id, [{ type: 'guard', rule: 'r', tool: 'Bash', arg: edge }, { type: 'spawn', agent: 'sub', description: edge }])).toBe('ok');
    const text = JSON.stringify(trace.summary());
    expect(text).not.toMatch(/mk_/);
    expect(text).not.toContain(KEY.slice(3, 40));
  });
});

describe('the test chat history (2)', () => {
  it('lists the person’s own test chats and the old shared "you" ones, and not another person’s', async () => {
    const agent = agentOf('History');
    const mine = newSession(agent, { source: 'test', userId: TEST_OWNER.id, version: 'draft', title: 'mine' });
    const old = newSession(agent, { source: 'test', userId: 'you', version: 'draft', title: 'old' });
    const theirs = newSession(agent, { source: 'test', userId: 'usr_someone_else', version: 'draft', title: 'theirs' });
    for (const session of [mine, old, theirs]) agentStore.saveSession(session);
    const response = await (sessionsRoute.GET as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://localhost/api/agents/${agent.id}/sessions?source=test`), { params: Promise.resolve({ id: agent.id }) });
    const titles = ((await response.json()) as { sessions: Array<{ title: string }> }).sessions.map((x) => x.title).sort();
    expect(titles).toEqual(['mine', 'old']);
  });

  it('chatting in a session someone else opened does not change whose it is', async () => {
    const agent = agentOf('Borrowed');
    const theirs = newSession(agent, { source: 'test', userId: 'usr_someone_else', version: 'draft', title: 'theirs' });
    agentStore.saveSession(theirs);
    const response = await (chatRoute.POST as unknown as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(
      new Request(`http://localhost/api/agents/${agent.id}/chat`, { method: 'POST', body: JSON.stringify({ message: 'hi', sessionId: theirs.id }) }),
      { params: Promise.resolve({ id: agent.id }) },
    );
    await response.text();
    expect(agentStore.getSession(theirs.id)!.userId).toBe('usr_someone_else');
  });
});

describe('a shared thread runs as the author of the message (9)', () => {
  it('changes only the user, and not the session it was given', () => {
    const session = { id: 's', userId: 'telegram:1' };
    expect(asAuthor(session, 'telegram:1')).toBe(session);
    expect(asAuthor(session, 'telegram:2')).toEqual({ id: 's', userId: 'telegram:2' });
    expect(session.userId).toBe('telegram:1');
  });
});

describe('the memory text in the journal is for the person and the agent’s editors (6)', () => {
  it('a project member who is neither sees the sources but not the text', async () => {
    const mk = (n: string) => createUser({ email: `${n}@rev.test`, name: n, role: 'member', password: `${n}-password-1` });
    const [person, editor, viewer] = [await mk('pe'), await mk('ed'), await mk('vw')];
    const project = createTeamProject({ name: 'Rev', createdBy: editor.id });
    setMember(project.id, editor.id, 'editor');
    setMember(project.id, viewer.id, 'viewer');
    const agent = agentOf('Journal');
    setHomeProject('agent', agent.id, project.id);
    const event = { seq: 1, type: 'span.updated', attrs: { saw: { text: 'x', memory: [{ source: 'agent-profile', count: 1, items: [{ id: 'm_a' }] }], memoryText: 'Likes tea', memoryFor: person.id, memoryAgent: agent.id } } } as never;
    const read = (actor: { id: string; role: 'member' | 'owner' }) => JSON.stringify(hideMemoryText([event], actor as never));
    expect(read({ id: person.id, role: 'member' })).toContain('Likes tea');
    expect(read({ id: editor.id, role: 'member' })).toContain('Likes tea');
    expect(read({ id: 'usr_owner_x', role: 'owner' })).toContain('Likes tea');
    const hidden = read({ id: viewer.id, role: 'member' });
    expect(hidden).not.toContain('Likes tea');
    expect(hidden).not.toContain(person.id);
    expect(hidden).toContain('agent-profile');
  });
});

describe('the import never fails a run (9)', () => {
  it('logs a failed import, sets the flag and goes on', () => {
    const flag = agentStore as unknown as { importedMemories: boolean };
    flag.importedMemories = false;
    database().delete('meta', { key: 'config_store.imported.agent-memory-facts' }); // so the import runs again and meets the failure
    const spy = vi.spyOn(database(), 'transaction').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(() => agentStore.importMemories()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(flag.importedMemories).toBe(true);
    agentStore.importMemories(); // the next boot imports again
    expect(database().get('SELECT value FROM meta WHERE key = ?', 'config_store.imported.agent-memory-facts')).toBeUndefined();
  });
});
