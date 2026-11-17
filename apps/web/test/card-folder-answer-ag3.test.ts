/**
 * Wave ag3 carryover (the live pass, knowledge agent): "from the folder runbooks" typed under a pending agent card went to the
 * flow builder ("Plan: Runbooks folder workflow · 1 step") because it starts with no change verb. Under a card, an answer that
 * names a knowledge folder revises that card; with no card, or a question, it is not a revise.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-card-folder-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { reviseCardFor } = await import('@/components/editor/spotlight/agent-ask');
const { useAssistant } = await import('@/components/editor/assistant');

const withCard = () =>
  useAssistant.setState({
    items: [
      { id: 'u1', role: 'user', text: 'Create an agent that answers questions from our incident runbooks.' },
      { id: 'a1', role: 'assistant', parts: [{ kind: 'agentCard', card: { state: 'designed', name: 'Runbooks answerer', tools: [] } }] },
    ] as never,
  });

describe('a folder answer under an agent card', () => {
  beforeEach(() => useAssistant.setState({ items: [] as never }));

  it('"from the folder runbooks" revises the newest card', () => {
    withCard();
    expect(reviseCardFor('from the folder runbooks')?.itemId).toBe('a1');
    expect(reviseCardFor('in the folder runbooks/ops')?.itemId).toBe('a1');
  });

  it('no card, or a question, is not a revise', () => {
    expect(reviseCardFor('from the folder runbooks')).toBeUndefined();
    withCard();
    expect(reviseCardFor('what is in the folder runbooks?')).toBeUndefined();
  });
});

describe('folderAnswerOf', () => {
  it('reads a bare source answer, and nothing from a sentence that names no source', async () => {
    const { folderAnswerOf } = await import('@/components/editor/spotlight/agent-ask');
    expect(folderAnswerOf('from the folder runbooks')).toBe('runbooks');
    expect(folderAnswerOf('in the runbooks folder')).toBe('runbooks');
    expect(folderAnswerOf('from runbooks/ops/')).toBe('runbooks/ops');
    expect(folderAnswerOf('answers from the folder runbooks')).toBe('runbooks');
    expect(folderAnswerOf('move it to the junk folder')).toBeUndefined();
    expect(folderAnswerOf('from the folder /etc')).toBeUndefined();
  });
});
