/**
 * C09: an agent on kagent reaches memory over its MCP endpoint through a signed 24-hour key (docs/a2a.md#memory-on-kagent):
 * the key opens one person's memories for one agent and expires; the deployed agent lists the three memory tools only with
 * cross-session memory on; a call without a valid key reads and writes nothing; the first message of a conversation carries
 * the key after the practices index and later ones do not; and the key never reaches a span.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeA2a } from './fake-a2a';

vi.setConfig({ testTimeout: 30_000 });

const spans = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-memory-kagent-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { a2aAgentNode } = await import('@/lib/server/nodes/a2a');
const { a2aAgentTool } = await import('@/lib/server/agents/tools');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { memoryKeyFor, openMemoryKey, MEMORY_KEY_PATTERN, MEMORY_KEY_TTL_MS } = await import('@/lib/server/kagent/memory-key');
const { memoryKeyLine, withMemoryKey } = await import('@/lib/server/kagent/memory-line');
const { NEEDS_KEY } = await import('@/lib/server/kagent/memory-tools');
const { MEMORY_PERSONA_LINE, kagentManifests } = await import('@/lib/server/kagent/manifests');
const { kagentTools } = await import('@/lib/server/kagent/deploy');
const { PRACTICES_INDEX_LINE } = await import('@/lib/server/practices/remote');
const memories = await import('@/lib/server/agents/memory');
const facts = await import('@/lib/server/brain/facts');
const mcpRoute = await import('@/app/api/mcp/agents/[id]/route');
const { run } = await import('./helpers');
const clientModule = await import('@/lib/server/a2a/client');

registry.registerBuiltin(corePlugin);

const a2a = await startFakeA2a();
const TOKEN = 'lfk_memory_token';

function deployed(name: string, memory: boolean) {
  const agent = agentStore.create({ name, instructions: 'Work.', memory: { crossSession: memory } });
  agentStore.publish(agent.id);
  agentStore.setKagent(agent.id, { credential: { id: 'cred', name: 'kind' }, name: `kagent-${agent.id}`, version: 1, token: credentials.sealSecret(TOKEN), trace: { url: 'http://x', a2aUrl: `${a2a.url}/${agent.id}` } } as never);
  return agentStore.get(agent.id)!;
}
const remote = deployed('Remembers on kagent', true);
const quiet = deployed('Forgets on kagent', false);

async function rpc(agentId: string, name: string, args: Record<string, unknown>, method = 'tools/call') {
  const request = new Request(`http://localhost/api/mcp/agents/${agentId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name, arguments: args } : {} }),
  });
  const raw = await (await (mcpRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(request, { params: Promise.resolve({ id: agentId }) })).text();
  const body = JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as { result: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string; inputSchema: { required?: string[] } }> } };
  return body.result;
}
const live = (agentId: string, userId: string) => facts.listFacts({ subjectType: 'agent-user', subjectId: `${agentId}/${userId}`, limit: 500 });

beforeEach(() => {
  a2a.calls.length = 0;
  spans.reset();
});
afterAll(async () => {
  await a2a.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('the memory key', () => {
  it('opens to its person for its agent, not for another agent, not after 24 hours, never forged', () => {
    const now = Date.parse('2026-11-21T10:00:00.000Z');
    const key = memoryKeyFor('ag_a', 'workflow:w1', now);
    expect(key).toMatch(/^mk_/);
    expect(openMemoryKey(key, 'ag_a', now + 1_000)).toEqual({ userId: 'workflow:w1' });
    expect(openMemoryKey(key, 'ag_b', now + 1_000)).toBeUndefined();
    expect(openMemoryKey(key, 'ag_a', now + MEMORY_KEY_TTL_MS - 1)).toEqual({ userId: 'workflow:w1' });
    expect(openMemoryKey(key, 'ag_a', now + MEMORY_KEY_TTL_MS + 1)).toBeUndefined();
    // Another person's payload under this signature, a cut key, junk and a missing key.
    const [head, sig] = key.slice(3).split('.');
    const forged = Buffer.from(JSON.stringify({ a: 'ag_a', u: 'workflow:other', e: now + MEMORY_KEY_TTL_MS })).toString('base64url');
    expect(openMemoryKey(`mk_${forged}.${sig}`, 'ag_a', now)).toBeUndefined();
    expect(openMemoryKey(`mk_${head}.`, 'ag_a', now)).toBeUndefined();
    expect(openMemoryKey('mk_junk', 'ag_a', now)).toBeUndefined();
    expect(openMemoryKey(undefined, 'ag_a', now)).toBeUndefined();
    expect(openMemoryKey(memoryKeyFor('ag_a', 'evaluation', now), 'ag_a', now)).toBeUndefined();
    expect(openMemoryKey(memoryKeyFor('ag_a', 'kagent:x', now), 'ag_a', now)).toBeUndefined();
    expect(key.match(MEMORY_KEY_PATTERN)).toEqual([key]);
  });

  it('still opens after the vault key rotated (a key of the ring signs it)', () => {
    const now = Date.now();
    const old = Buffer.alloc(32, 1);
    const signing = vi.spyOn(credentials, 'deriveKey').mockReturnValue(old);
    const key = memoryKeyFor('ag_a', 'u1', now);
    signing.mockRestore();
    const ring = vi.spyOn(credentials, 'deriveKeys').mockReturnValue([Buffer.alloc(32, 2), old]);
    expect(openMemoryKey(key, 'ag_a', now)).toEqual({ userId: 'u1' });
    ring.mockReturnValue([Buffer.alloc(32, 2)]);
    expect(openMemoryKey(key, 'ag_a', now)).toBeUndefined();
    ring.mockRestore();
  });
});

describe('the tools on the agent’s MCP endpoint', () => {
  it('lists recall_memory, remember and forget_memory only with cross-session memory on, each asking for the key', async () => {
    const withMemory = (await rpc(remote.id, '', {}, 'tools/list')).tools!;
    expect(withMemory.map((t) => t.name)).toEqual(expect.arrayContaining(['recall_memory', 'remember', 'forget_memory']));
    for (const name of ['recall_memory', 'remember', 'forget_memory']) expect(withMemory.find((t) => t.name === name)!.inputSchema.required).toContain('memoryKey');
    expect((await rpc(quiet.id, '', {}, 'tools/list')).tools!.map((t) => t.name)).not.toEqual(expect.arrayContaining(['recall_memory']));
    expect((await kagentTools(quiet, quiet.published!.config)).tools.map((t) => t.name)).toEqual([]);
    // The runtime's own tools of the same names are not bound a second time.
    expect((await kagentTools(remote, remote.published!.config)).tools.map((t) => t.name).sort()).toEqual(['forget_memory', 'recall_memory', 'remember']);
  });

  it('recalls the same fenced block a Landflow run would, for the person the key names (AS-7)', async () => {
    await memories.rememberMemory(remote.id, 'workflow:w1', { fact: 'Invoices go to finance@example.com' });
    await memories.rememberMemory(remote.id, 'workflow:w2', { fact: 'w2 banks with Quux' });
    const key = memoryKeyFor(remote.id, 'workflow:w1');
    const answer = await rpc(remote.id, 'recall_memory', { query: 'where do invoices go', memoryKey: key });
    expect(answer.isError).toBeFalsy();
    const text = answer.content![0].text;
    expect(text).toBe((await memories.recallFor(remote.id, 'workflow:w1', 'where do invoices go')).text);
    expect(text).toContain('<landflow-memory source="agent-memory"');
    expect(text).toContain('Invoices go to finance@example.com');
    expect(text).not.toContain('Quux');
  });

  it('saves, replaces and forgets for that person only', async () => {
    const key = memoryKeyFor(remote.id, 'workflow:w3');
    expect((await rpc(remote.id, 'remember', { fact: 'Prefers email', memoryKey: key })).content![0].text).toMatch(/^Saved\./);
    const [fact] = live(remote.id, 'workflow:w3');
    expect(fact.writtenBy).toMatchObject({ origin: 'landflow' });
    const handle = memories.shortId(fact.id);
    expect((await rpc(remote.id, 'remember', { fact: 'Prefers Slack', replaces: handle, memoryKey: key })).content![0].text).toMatch(/^Replaced\./);
    expect(live(remote.id, 'workflow:w3')[0]).toMatchObject({ statement: 'Prefers Slack', version: 2 });
    // Another person's id is not found, even with a valid key of the first person.
    const theirs = await memories.rememberMemory(remote.id, 'workflow:w4', { fact: 'w4 secret' });
    const refused = await rpc(remote.id, 'forget_memory', { id: memories.shortId(theirs.item.id), reason: 'no', memoryKey: key });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content![0].text).toMatch(/not found/);
    expect(live(remote.id, 'workflow:w4')).toHaveLength(1);
    expect((await rpc(remote.id, 'forget_memory', { id: handle, reason: 'changed my mind', memoryKey: key })).content![0].text).toBe(`Forgot ${handle}.`);
    expect(live(remote.id, 'workflow:w3')).toEqual([]);
  });

  it('refuses without a key, with another agent’s key, a forged key or an expired one, and reads and writes nothing', async () => {
    await memories.rememberMemory(remote.id, 'workflow:w5', { fact: 'w5 private fact' });
    const before = live(remote.id, 'workflow:w5').length;
    const other = memoryKeyFor(quiet.id, 'workflow:w5');
    const expired = memoryKeyFor(remote.id, 'workflow:w5', Date.now() - MEMORY_KEY_TTL_MS - 1_000);
    for (const memoryKey of [undefined, 'mk_nope.nope', other, expired]) {
      for (const [name, args] of [['recall_memory', { query: 'private' }], ['remember', { fact: 'smuggled in' }], ['forget_memory', { id: 'm_x', reason: 'r' }]] as const) {
        const answer = await rpc(remote.id, name, { ...args, ...(memoryKey && { memoryKey }) });
        expect(answer.isError, `${name} with ${memoryKey}`).toBe(true);
        expect(answer.content![0].text).toBe(NEEDS_KEY);
        expect(answer.content![0].text).not.toContain('private');
      }
    }
    expect(live(remote.id, 'workflow:w5')).toHaveLength(before);
    expect(facts.listFacts({ subjectType: 'agent-user', subjectId: `${remote.id}/workflow:other`, limit: 5 })).toEqual([]);
  });

  it('records an execute_tool span with no key and no memory text', async () => {
    const key = memoryKeyFor(remote.id, 'workflow:w6');
    await rpc(remote.id, 'remember', { fact: 'A very private sentence', memoryKey: key });
    await rpc(remote.id, 'recall_memory', { query: 'sentence', memoryKey: key });
    const recorded = spans.getFinishedSpans().filter((s) => s.name === 'execute_tool remember' || s.name === 'execute_tool recall_memory');
    expect(recorded).toHaveLength(2);
    const everything = JSON.stringify(spans.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })));
    expect(everything).not.toContain('A very private sentence');
    expect(everything).not.toMatch(MEMORY_KEY_PATTERN);
    expect(everything).not.toContain(key);
  });
});

describe('a key is minted only for the address Landflow deployed to (3)', () => {
  it('gives no key for another host with the same last path segment, nor for a deployment without a stored address', () => {
    const name = `kagent-${remote.id}`;
    expect(memoryKeyLine(`${a2a.url}/${remote.id}`, 'workflow:w1')).toMatch(/^Memory key for this person: mk_/);
    expect(memoryKeyLine(`${a2a.url}/${remote.id}/`, 'workflow:w1')).toMatch(/^Memory key/);
    for (const url of [`https://evil.example/x/agents/ns/${name}`, `http://kagent.test/api/a2a/kagent/agents/ns/${name}`, `${a2a.url}/other/agents/ns/${name}`]) expect(memoryKeyLine(url, 'workflow:w1'), url).toBeUndefined();
    const legacy = agentStore.create({ name: 'Legacy', instructions: 'Work.', memory: { crossSession: true } } as never);
    agentStore.setKagent(legacy.id, { credential: { id: 'cred', name: 'kind' }, name: `kagent-${legacy.id}`, version: 1, token: credentials.sealSecret(TOKEN) } as never);
    expect(memoryKeyLine(`https://elsewhere/agents/ns/kagent-${legacy.id}`, 'workflow:w1')).toBeUndefined();
  });
});

describe('what leaves Landflow for the remote agent (5)', () => {
  const { sendMessage, approvalMessage, answerMessage } = clientModule;
  const endpoint = () => ({ url: `${a2a.url}/${remote.id}`, headers: {}, timeoutMs: 5_000 });
  const sentTexts = (from: number) => a2a.calls.slice(from).filter((c) => c.method === 'SendMessage').map((c) => JSON.stringify(c.params.message));

  it('takes a pasted memory key out of an answer, a rejection reason, a plain message and the metadata, and keeps Landflow’s own line', async () => {
    const stolen = memoryKeyFor(remote.id, 'usr_victim');
    const before = a2a.calls.length;
    const task = { id: 't9', contextId: 'c9' };
    await sendMessage(endpoint(), answerMessage(task, { type: 'ask_user_request', id: 'q', questions: [] }, [`my answer ${stolen}`]));
    await sendMessage(endpoint(), approvalMessage(task, { type: 'tool_approval_request', tools: [{ id: 'a', name: 'Bash' }] }, false, `no, because ${stolen}`));
    await sendMessage(endpoint(), { text: `plain ${stolen}`, metadata: { note: stolen } });
    const own = 'Memory key for this person: ' + memoryKeyFor(remote.id, 'usr_me');
    await sendMessage(endpoint(), { text: `${own}\n\nhello ${stolen}`, keyLine: own });
    const sent = sentTexts(before);
    expect(sent).toHaveLength(4);
    for (const text of sent.slice(0, 3)) expect(text).not.toContain('mk_');
    expect(sent[3]).toContain(own);
    expect(sent[3].match(/mk_/g)).toHaveLength(1);
  });
});

describe('the persona', () => {
  const promptOf = (agent: typeof remote) => {
    const objects = kagentManifests({ agentId: agent.id, config: agent.published!.config, version: 1, name: 'mem', cluster: { namespace: 'kagent', harness: 'landflow-kagent', landflowUrl: 'http://landflow.test:3000' }, tools: [], model: { ollamaHost: 'http://x:11434' }, token: 't', tokenHash: 'h' } as never);
    return (objects.find((o) => o.kind === 'AgentTemplate')!.spec as { systemPrompt: string }).systemPrompt;
  };

  it('says to call recall_memory at the start of a task when memory is on, and nothing when it is off', () => {
    expect(promptOf(remote).endsWith(MEMORY_PERSONA_LINE)).toBe(true);
    expect(MEMORY_PERSONA_LINE).toContain('call recall_memory');
    expect(promptOf(quiet)).not.toContain('recall_memory');
  });
});

describe('the first message of a conversation', () => {
  const params = (extra: Record<string, unknown> = {}) => ({ agentUrl: `${a2a.url}/${remote.id}`, authentication: 'none', options: { timeout: 5_000, projectContext: 'off', practices: 'off' }, operation: 'sendMessage', ...extra });
  const textOf = (c: { params: { message?: { parts?: Array<{ text?: string }> } } }) => (c.params.message?.parts?.[0]?.text ?? '').replace(/^<!-- landflow-trace [^>]*-->\n*/, '');
  const sends = () => a2a.calls.filter((c) => c.method === 'SendMessage' || c.method === 'SendStreamingMessage');

  it('puts the key after the practices index, once, and never twice', () => {
    const line = 'Memory key for this person: mk_x.y';
    expect(withMemoryKey('do it', line)).toBe(`${line}\n\ndo it`);
    expect(withMemoryKey(`## Practices\n- a\n\n${PRACTICES_INDEX_LINE}\n\ndo it`, line)).toBe(`## Practices\n- a\n\n${PRACTICES_INDEX_LINE}\n\n${line}\n\ndo it`);
    expect(withMemoryKey(`${line}\n\ndo it`, line)).toBe(`${line}\n\ndo it`);
    expect(withMemoryKey('do it', undefined)).toBe('do it');
  });

  it('gives a Landflow agent on kagent with memory on the key of the workflow, in the first message only', async () => {
    await run(a2aAgentNode, params({ message: 'slug One' }));
    await run(a2aAgentNode, params({ message: 'again', contextId: 'ctx_known' }));
    const [first, second] = sends().map(textOf);
    const key = /Memory key for this person: (mk_\S+)/.exec(first)?.[1];
    expect(key).toBeTruthy();
    expect(first).toContain('Pass it as memoryKey to recall_memory, remember and forget_memory.');
    expect(first.endsWith('slug One')).toBe(true);
    expect(openMemoryKey(key, remote.id)?.userId).toMatch(/^workflow:/);
    expect(second).toBe('again');
  });

  it('gives an agent’s A2A tool the key of the session’s person, and nothing to an agent with memory off or an endpoint that is not Landflow’s', async () => {
    const toolContext = () => ({ agent: { id: 'agt_1', name: 'Caller' }, session: { id: 'ses_1', userId: 'telegram:42', remoteContexts: {} }, runId: 'run_1', signal: new AbortController().signal, approvals: 'ask' }) as never;
    const build = async (url: string) => {
      const built = await a2aAgentTool({ id: 'cap_1', name: 'Remote', parameters: { agentUrl: url, authentication: 'none', options: { timeout: 5_000, projectContext: 'off', practices: 'off' } } } as never);
      if ('error' in built) throw new Error(built.error);
      return built;
    };
    const ctx = toolContext();
    const t = await build(`${a2a.url}/${remote.id}`);
    await t.invoke({ message: 'one' }, ctx);
    await t.invoke({ message: 'two' }, ctx);
    const [one, two] = sends().map(textOf);
    expect(openMemoryKey(/mk_\S+/.exec(one)?.[0], remote.id)).toEqual({ userId: 'telegram:42' });
    expect(two).toBe('two');
    a2a.calls.length = 0;
    await (await build(`${a2a.url}/${quiet.id}`)).invoke({ message: 'quiet one' }, toolContext());
    await (await build(`${a2a.url}/not-landflows`)).invoke({ message: 'foreign' }, toolContext());
    expect(sends().map(textOf).join('\n')).not.toContain('Memory key');
    expect(memoryKeyLine(`${a2a.url}/${remote.id}`, 'evaluation')).toBeUndefined();
    expect(memoryKeyLine(`${a2a.url}/${remote.id}`, undefined)).toBeUndefined();
  });
});
