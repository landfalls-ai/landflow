/**
 * The composite types core ships (docs/composites.md): `core.aiStep`, an AI node with the chat model, and optionally the
 * memory and tools, it needs. Plugins declare their own (the triage plugin's `triage.aiTriage`); people save theirs from
 * a group (`local.<name>`, lib/server/composites.ts).
 */
import { defineComposite } from '@landflow/sdk';

export const aiStep = defineComposite({
  name: 'aiStep',
  displayName: 'AI step',
  description: 'An AI node with its chat model, and optionally a memory and tools. The model must be connected to the AI node.',
  version: 1,
  icon: 'lucide:sparkles',
  color: '#a855f7',
  inputs: [{ name: 'in', displayName: 'Input', slot: 'reasoner' }],
  outputs: [{ name: 'out', displayName: 'Output', slot: 'reasoner', index: 0 }],
  slots: [
    { name: 'reasoner', displayName: 'AI node', description: 'Reads the input and answers: an agent, a chain, a classifier', accepts: { kind: 'action', category: 'AI', input: 'ai_languageModel' }, max: 1 },
    { name: 'model', displayName: 'Chat model', accepts: { supplies: 'ai_languageModel' }, max: 1 },
    { name: 'memory', displayName: 'Memory', accepts: { supplies: 'ai_memory' }, min: 0, max: 1 },
    { name: 'tools', displayName: 'Tools', accepts: { supplies: 'ai_tool' }, min: 0 },
  ],
  rules: [
    { rule: 'feeds', from: 'model', to: 'reasoner', via: 'ai_languageModel' },
    { rule: 'feeds', from: 'memory', to: 'reasoner', via: 'ai_memory' },
    { rule: 'feeds', from: 'tools', to: 'reasoner', via: 'ai_tool' },
    { rule: 'sealed' },
  ],
  starter: {
    nodes: [
      { id: 'agent', name: 'AI Agent', type: 'core.aiAgent', position: [80, 80], slot: 'reasoner' },
      { id: 'model', name: 'Anthropic Chat Model', type: 'core.anthropicChatModel', position: [80, 280], slot: 'model' },
    ],
    connections: [{ source: 'model', target: 'agent', type: 'ai_languageModel' }],
  },
});
