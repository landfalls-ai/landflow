/**
 * The brain's writer builds a draft workflow for a "draft" finding, planned first (one plan call and one call per step).
 * A pass drafts at most MAX_DRAFTS_PER_PASS of them, so a run of the detectors cannot start dozens of builds on the
 * brain's local model; the findings past the cap are kept as they are.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';

const built = vi.hoisted(() => vi.fn(async (prompt: string) => ({ name: `Draft of ${prompt}`, nodes: [{ key: 's1', type: 'core.manualTrigger', name: 'Start', parameters: {} }], edges: [], model: 'qwen3-coder:30b' })));
vi.mock('@/lib/server/assistant/build-plan', () => ({ buildPlanFirst: built }));

const previous = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-brain-writer-drafts-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'qwen3-coder:30b' });
const { enrichFindings, MAX_DRAFTS_PER_PASS } = await import('@/lib/server/brain/writer');
afterAll(() => {
  for (const key of ['LANDFLOW_DATA_DIR', 'LANDFLOW_REGISTRY_GRPC_PORT', 'LANDFLOW_SCAN_ON_START', 'LANDFLOW_PLUGINS', 'LANDFLOW_BRAIN_MODEL']) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

const hash = (prompt: string) => createHash('sha256').update(prompt).digest('hex').slice(0, 16);
const model = { provider: 'test', model: 'brain', generate: async () => ({ text: '{}', toolCalls: [], stopReason: 'stop' as const }) } as unknown as LanguageModel;
const draft = { id: 'draft', name: 'Saved draft', active: false, nodes: [], connections: [] };
const saveOne = async (fingerprint: string, over: Record<string, unknown>) => {
  const { upsertProposal } = await import('@/lib/server/brain/proposals');
  upsertProposal({ source: 'detector', detector: 'unmet-demand', fingerprint, target: { type: 'instance' }, title: 'Saved', why: 'asked often', evidence: [], ops: [], draft, risk: 'low', confidence: 0.6, score: 1, ...over } as never);
};
const again = (fingerprint: string, prompt: string) => ({ proposal: { detector: 'unmet-demand', title: 'Again', why: 'asked often', ops: [], confidence: 0.6, fingerprint }, enrich: { kind: 'draft', prompt } }) as unknown as Parameters<typeof enrichFindings>[0][number];

const finding = (n: number) =>
  ({ proposal: { detector: 'unmet-demand', title: `Build ${n}`, why: 'asked often', ops: [], confidence: 0.6 }, enrich: { kind: 'draft', prompt: `Build workflow ${n}` } }) as unknown as Parameters<typeof enrichFindings>[0][number];

describe('drafts per pass', () => {
  it('builds at most MAX_DRAFTS_PER_PASS drafts in one pass and keeps the other findings as they are', async () => {
    built.mockClear();
    const model = { provider: 'test', model: 'brain', generate: async () => ({ text: '{}', toolCalls: [], stopReason: 'stop' as const }) } as unknown as LanguageModel;
    const out = await enrichFindings([1, 2, 3, 4, 5].map(finding), { model });
    expect(MAX_DRAFTS_PER_PASS).toBe(3);
    expect(built).toHaveBeenCalledTimes(MAX_DRAFTS_PER_PASS);
    expect(out.filter((f) => f.proposal.draft)).toHaveLength(MAX_DRAFTS_PER_PASS);
    expect(out.slice(3).every((f) => !f.proposal.draft)).toBe(true);
    expect(out).toHaveLength(5);
  });

  it('keeps the draft an open suggestion already has: no rebuild, and it does not count against the cap', async () => {
    built.mockClear();
    const { upsertProposal } = await import('@/lib/server/brain/proposals');
    const draft = { id: 'draft', name: 'Saved draft', active: false, nodes: [], connections: [] };
    upsertProposal({ source: 'detector', detector: 'unmet-demand', fingerprint: 'unmet-demand-saved', target: { type: 'instance' }, title: 'Saved', why: 'asked often', evidence: [], ops: [], draft, draftPromptHash: hash('Build workflow 0'), risk: 'low', confidence: 0.6, score: 1 } as never);
    const again = { ...finding(0), proposal: { ...finding(0).proposal, fingerprint: 'unmet-demand-saved' } } as ReturnType<typeof finding>;
    const model = { provider: 'test', model: 'brain', generate: async () => ({ text: '{}', toolCalls: [], stopReason: 'stop' as const }) } as unknown as LanguageModel;
    const out = await enrichFindings([again, ...[1, 2, 3, 4].map(finding)], { model });
    expect(out[0].proposal.draft?.name).toBe('Saved draft');
    expect(built).toHaveBeenCalledTimes(MAX_DRAFTS_PER_PASS);
    expect(built.mock.calls.map((c) => c[0])).not.toContain('Build workflow 0');
  });

  it('rebuilds a draft whose prompt changed, and the rebuild counts against the cap', async () => {
    built.mockClear();
    await saveOne('unmet-demand-moved', { draftPromptHash: hash('Build it. Examples: a, b') });
    const out = await enrichFindings([again('unmet-demand-moved', 'Build it. Examples: a, c')], { model });
    expect(built).toHaveBeenCalledTimes(1);
    expect(out[0].proposal.draft?.name).toBe('Draft of Build it. Examples: a, c');
    expect(out[0].proposal.draftPromptHash).toBe(hash('Build it. Examples: a, c'));
    built.mockClear();
    const capped = await enrichFindings([again('unmet-demand-moved', 'Build it. Examples: a, d'), ...[1, 2, 3, 4].map(finding)], { model });
    expect(built).toHaveBeenCalledTimes(MAX_DRAFTS_PER_PASS);
    expect(capped.filter((f) => f.proposal.draft)).toHaveLength(MAX_DRAFTS_PER_PASS);
  });

  it('keeps the draft when the prompt is the same', async () => {
    built.mockClear();
    await saveOne('unmet-demand-same', { draftPromptHash: hash('Same prompt') });
    const out = await enrichFindings([again('unmet-demand-same', 'Same prompt')], { model });
    expect(built).not.toHaveBeenCalled();
    expect(out[0].proposal.draft?.name).toBe('Saved draft');
  });

  it('does not reuse the draft of a suggestion that is not from this detector', async () => {
    built.mockClear();
    await saveOne('unmet-demand-other', { source: 'analyst', detector: undefined, draftPromptHash: hash('Other prompt') });
    const out = await enrichFindings([again('unmet-demand-other', 'Other prompt')], { model });
    expect(built).toHaveBeenCalledTimes(1);
    expect(out[0].proposal.draft?.name).toBe('Draft of Other prompt');
  });
});
