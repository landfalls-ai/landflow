/**
 * Agent definitions, sessions and memory in the database (lib/server/agents/store.ts, migration 1881): the files of a
 * single host are imported once and left in place; two stores on one database (two mains) see each other's writes at
 * once; a deleted agent doesn't come back from its file; a session another process left running is not reset at boot;
 * memory notes written by two stores add up; and the files mode still writes the files.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agents-db-'));
const previous = { dir: process.env.LANDFLOW_DATA_DIR, store: process.env.LANDFLOW_CONFIG_STORE };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_DB: 'sqlite', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
delete process.env.LANDFLOW_CONFIG_STORE;
afterAll(() => {
  if (previous.dir === undefined) delete process.env.LANDFLOW_DATA_DIR;
  else process.env.LANDFLOW_DATA_DIR = previous.dir;
  if (previous.store !== undefined) process.env.LANDFLOW_CONFIG_STORE = previous.store;
});

const { createAgentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { database } = await import('@/lib/server/db');

describe('agents in files mode and in the database', () => {
  const files = createAgentStore('files');

  it('files mode writes the data directory as before', () => {
    const agent = files.create({ name: 'On disk', instructions: 'be brief' });
    expect(existsSync(join(dataDir, 'agents', `${agent.id}.json`))).toBe(true);
    const session = files.saveSession(newSession(agent, { source: 'test', userId: 'u1', version: 'draft', conversationKey: 'chat-1' }));
    expect(existsSync(join(dataDir, 'agent-sessions', `${session.id}.json`))).toBe(true);
    files.remember(agent.id, 'u1', 'likes tea');
    expect(JSON.parse(readFileSync(join(dataDir, 'agent-memory', `${agent.id}.json`), 'utf8')).u1[0].text).toBe('likes tea');
    expect(files.storeKind).toBe('files');
    // A leftover running session from a crashed process, as a file.
    const stuck = { ...session, id: 'as_stuck', status: 'running' as const };
    mkdirSync(join(dataDir, 'agent-sessions'), { recursive: true });
    writeFileSync(join(dataDir, 'agent-sessions', 'as_stuck.json'), JSON.stringify(stuck));
  });

  it('database mode imports the files once, leaves them, and then the rows win', () => {
    const [agentFile] = files.list();
    const before = readFileSync(join(dataDir, 'agents', `${agentFile.id}.json`), 'utf8');
    const main1 = createAgentStore('database');
    expect(main1.storeKind).toBe('database');
    const imported = main1.get(agentFile.id);
    expect(imported?.name).toBe('On disk');
    expect(main1.listSessions(agentFile.id).map((s) => s.id).sort()).toEqual(expect.arrayContaining(['as_stuck']));
    // Imported sessions that were running are idle (their process is gone with the old host).
    expect(main1.getSession('as_stuck')?.status).toBe('idle');
    expect(main1.memories(agentFile.id, 'u1').map((n) => n.text)).toEqual(['likes tea']);
    expect(main1.findConversation(agentFile.id, 'chat-1')?.userId).toBe('u1');
    expect(readFileSync(join(dataDir, 'agents', `${agentFile.id}.json`), 'utf8')).toBe(before);

    // Changes after the import go to the rows, not the file: a deleted agent doesn't come back from its file.
    expect(main1.delete(agentFile.id)).toBe(true);
    const main2 = createAgentStore('database');
    expect(main2.get(agentFile.id)).toBeUndefined();
    expect(main2.list().map((a) => a.id)).not.toContain(agentFile.id);
    expect(existsSync(join(dataDir, 'agents', `${agentFile.id}.json`))).toBe(true);
    expect(main2.listSessions(agentFile.id)).toEqual([]);
  });

  it('two mains share agents, sessions and memory; another main’s running session is not reset', () => {
    const main1 = createAgentStore('database');
    const main2 = createAgentStore('database');
    const agent = main1.create({ name: 'Shared' });
    expect(main2.get(agent.id)?.name).toBe('Shared');
    main2.saveDraft(agent.id, { name: 'Renamed on main 2', memory: { crossSession: true } });
    expect(main1.get(agent.id)?.name).toBe('Renamed on main 2');
    expect(main1.publish(agent.id)?.published?.version).toBe(1);
    expect(main2.summaries().find((a) => a.id === agent.id)?.publishedVersion).toBe(1);

    const running = main1.saveSession({ ...newSession(agent, { source: 'test', userId: 'u2', version: 'draft' }), status: 'running' });
    // A third process starting up (a restart of a main) doesn't touch it.
    const restarted = createAgentStore('database');
    expect(restarted.getSession(running.id)?.status).toBe('running');
    expect(main2.listSessions(agent.id)[0].status).toBe('running');

    // Memory notes from both mains add up (read-modify-write in a transaction), de-duplicated and capped.
    main1.remember(agent.id, 'u2', 'a');
    main2.remember(agent.id, 'u2', 'b');
    main1.remember(agent.id, 'u2', 'a');
    expect(main2.memories(agent.id, 'u2').map((n) => n.text)).toEqual(['b', 'a']);
    for (let i = 0; i < 60; i++) main1.remember(agent.id, 'u3', `note ${i}`);
    expect(main2.memories(agent.id, 'u3')).toHaveLength(50);

    expect(main2.deleteSession(agent.id, running.id)).toBe(true);
    expect(main1.getSession(running.id)).toBeUndefined();
    expect(main1.deleteSession(agent.id, running.id)).toBe(false);

    // A running session nobody has saved for a long time is idle again.
    const old = { ...newSession(agent, { source: 'test', userId: 'u4', version: 'draft' }), status: 'running' as const };
    main1.saveSession(old);
    database().upsert('agent_sessions', { id: old.id, agent_id: agent.id, conversation_key: null, updated_at: new Date(Date.now() - 3_600_000).toISOString(), summary: JSON.stringify({ ...main1.listSessions(agent.id)[0], updatedAt: new Date(Date.now() - 3_600_000).toISOString() }), data: JSON.stringify({ ...old, updatedAt: new Date(Date.now() - 3_600_000).toISOString() }) });
    expect(main2.getSession(old.id)?.status).toBe('idle');
    expect(main2.listSessions(agent.id).find((s) => s.id === old.id)?.status).toBe('idle');
  });
});
