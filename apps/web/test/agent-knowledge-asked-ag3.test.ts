/**
 * ag3 fix pass (AG13): what the client sends as `knowledgeAsked`. An email folder ("answers emails from the Inbox folder") is not a
 * knowledge source, so a folder alone never says the ask wanted one; only knowledge words do, or a reply to the card that asked "which
 * folder does it answer from?". The wire is recorded at the two client calls that reach the design route.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-asked-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const sent = vi.hoisted(() => ({ previews: [] as Array<Record<string, unknown>>, changes: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/editor/new-agent', async (importActual) => ({
  ...(await importActual<typeof import('@/components/editor/new-agent')>()),
  designPreview: async (spec: Record<string, unknown>) => {
    sent.previews.push(spec);
    throw new Error('stop here');
  },
}));
vi.mock('@/lib/client/agent-change', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/client/agent-change')>()),
  designChange: async (input: Record<string, unknown>) => {
    sent.changes.push(input);
    throw new Error('stop here');
  },
}));

const { agentAsk } = await import('@/lib/shared/agent-ask');
const { designAgentCard, reviseAgentCard } = await import('@/components/editor/spotlight/agent-ask');
const { useAssistant } = await import('@/components/editor/assistant');

const design = async (message: string) => {
  const ask = agentAsk(message);
  expect(ask, message).toBeDefined();
  sent.previews.length = 0;
  await designAgentCard(message, ask!, { starter: false });
  return sent.previews[0];
};

describe('a first ask', () => {
  beforeEach(() => useAssistant.setState({ items: [] as never }));

  it('an email or data folder names a place, not a source: no knowledgeAsked', async () => {
    for (const ask of [
      'Make an agent that answers emails from the Inbox folder',
      'Make an agent that searches emails in the Spam folder and answers them',
      'Make an agent that searches for invoices in the inbox folder',
      'Make an agent that looks up orders in the orders folder',
    ]) expect((await design(ask)).knowledgeAsked, ask).toBeUndefined();
  });

  it('knowledge words keep asking for the source', async () => {
    const preview = await design('Create an agent that answers questions from our incident runbooks in the folder runbooks and says which runbook each answer comes from.');
    expect(preview).toMatchObject({ knowledgeFolder: 'runbooks', knowledgeAsked: true });
    expect(await design('Make an agent that answers from the runbooks folder')).toMatchObject({ knowledgeFolder: 'runbooks', knowledgeAsked: true });
  });
});

describe('a reply under a card', () => {
  const card = (knowledgeSetup?: Record<string, unknown>) => ({ state: 'designed', name: 'Answerer', description: 'Answers.', tools: [], config: {}, ...(knowledgeSetup && { knowledgeSetup }) }) as never;
  const reviseWith = async (message: string, under: never) => {
    useAssistant.setState({ items: [] as never });
    sent.changes.length = 0;
    await reviseAgentCard('a1', under, message);
    return sent.changes[0];
  };

  it('the card that asked for a source: a bare folder reply is a source', async () => {
    const asked = card({ collection: '', existing: false });
    expect(await reviseWith('The folder is runbooks', asked)).toMatchObject({ knowledgeFolder: 'runbooks', knowledgeAsked: true });
    expect(await reviseWith('from the guides folder', asked)).toMatchObject({ knowledgeFolder: 'guides', knowledgeAsked: true });
  });

  it('a card that did not ask: a folder in a change with no knowledge words is sent, but not as a source', async () => {
    const plain = card();
    expect((await reviseWith('also answer from the guides folder', plain))?.knowledgeAsked).toBeUndefined();
    expect(await reviseWith('also answer from the folder runbooks', plain)).toMatchObject({ knowledgeFolder: 'runbooks', knowledgeAsked: true });
  });
});
