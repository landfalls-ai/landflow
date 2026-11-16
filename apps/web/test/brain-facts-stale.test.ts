/**
 * SP13: a fact not refreshed since the cut goes stale (the whole row is written back: subject_type is NOT NULL), so the
 * study finishes, is stamped, and the detectors run on the brain's own loop.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-facts-stale-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { getFact, staleFactsBefore, upsertFact } = await import('@/lib/server/brain/facts');
const { brainStatus, runBrain } = await import('@/lib/server/brain');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const old = new Date(Date.now() - 3 * 86_400_000).toISOString();

describe('stale facts', () => {
  it('an old fact goes stale with its row intact', () => {
    upsertFact({ subjectType: 'workflow', subjectId: 'wf_ghost', kind: 'purpose', statement: 'Does a thing', confidence: 0.5 } as never, database(), old);
    expect(staleFactsBefore(new Date().toISOString())).toBe(1);
    expect(getFact('workflow:wf_ghost:purpose')?.status).toBe('stale');
    const row = database().get<{ status: string; subject_type: string; kind: string; last_seen: string }>("SELECT status, subject_type, kind, last_seen FROM brain_facts WHERE id = 'workflow:wf_ghost:purpose'");
    expect(row).toMatchObject({ status: 'stale', subject_type: 'workflow', kind: 'purpose', last_seen: old });
  });

  it('the study finishes, is stamped, and the detectors run', async () => {
    upsertFact({ subjectType: 'workflow', subjectId: 'wf_ghost2', kind: 'purpose', statement: 'Does a thing', confidence: 0.5 } as never, database(), old);
    const result = await runBrain('all', {});
    expect(result.study?.stale).toBeGreaterThanOrEqual(1);
    expect(result.detect).toBeDefined();
    expect(brainStatus().lastStudy).toBeTruthy();
    expect(getFact('workflow:wf_ghost2:purpose')?.status).toBe('stale');
  });
});
