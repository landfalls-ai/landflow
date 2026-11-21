/**
 * C07: the memory backend (docs/second-brain.md#memory-backend). Written test first, one `describe` per task.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-memory-backend-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { containerKey, parseContainer } = await import('@/lib/shared/memory');
const { isBrainCollection, AGENT_MEMORY_COLLECTION } = await import('@/lib/shared/brain');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('T-1 types and the migration', () => {
  it('round-trips a container through its key', () => {
    expect(containerKey({ kind: 'project', id: 'p1' })).toBe('project:p1');
    expect(parseContainer('project:p1')).toEqual({ kind: 'project', id: 'p1' });
    expect(parseContainer('team:t1')).toEqual({ kind: 'team', id: 't1' });
    const agent = parseContainer('agent:a1', 'u1');
    expect(agent).toEqual({ kind: 'agent', id: 'a1', userId: 'u1' });
    expect(containerKey(agent!)).toBe('agent:a1');
  });

  it('refuses an agent container without a user, and anything unknown', () => {
    expect(parseContainer('agent:a1')).toBeUndefined();
    expect(parseContainer('workflow:w1')).toBeUndefined();
    expect(parseContainer('project:')).toBeUndefined();
    expect(parseContainer('nonsense')).toBeUndefined();
  });

  it('reserves the agent memory collection for the brain', () => {
    expect(AGENT_MEMORY_COLLECTION).toBe('landflow-agent-memory');
    expect(isBrainCollection('landflow-agent-memory')).toBe(true);
    expect(isBrainCollection('my-docs')).toBe(false);
  });

  it('indexes brain facts by project', () => {
    const indexes = database().all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'brain_facts'`);
    expect(indexes.map((i) => i.name)).toContain('brain_facts_project');
  });
});
