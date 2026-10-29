/**
 * AI triage (`triage.aiTriage`): the composite the triage flows are built around. A model gives a verdict on the
 * alert, Triage Decision turns it into Open / Attach / Ask, and the frame fails open: enrichment and the reasoner
 * continue on error, so an outage still reaches the decision (which then holds nothing back). docs/composites.md.
 *
 * The starter is the shipped alert-triage flow's own nodes (prompt, model, decision settings), less threat intel
 * enrichment, which is another plugin's node and an optional slot.
 */
import { readFileSync } from 'node:fs';
import { defineComposite } from '@landflow/sdk';
import type { CompositeStarterNode, JsonObject } from '@landflow/protocol';

interface FlowNode {
  id: string;
  name: string;
  type: string;
  parameters?: JsonObject;
  onError?: 'stop' | 'continue';
  retryOnFail?: boolean;
  maxTries?: number;
}

const flow = JSON.parse(readFileSync(new URL('../../flows/alert-triage-to-landfall.json', import.meta.url), 'utf8')) as { template: { workflow: { nodes: FlowNode[] } } };
const shipped = (id: string): FlowNode => {
  const node = flow.template.workflow.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`alert-triage-to-landfall.json has no node "${id}"`);
  return node;
};
const starterNode = (id: string, slot: string | undefined, position: [number, number]): CompositeStarterNode => {
  const { name, type, parameters, onError, retryOnFail, maxTries } = shipped(id);
  return { id, name, type, position, ...(slot && { slot }), ...(parameters && { parameters }), ...(onError && { onError }), ...(retryOnFail && { retryOnFail }), ...(maxTries && { maxTries }) };
};

export const AiTriage = defineComposite({
  name: 'aiTriage',
  displayName: 'AI triage',
  description:
    'A model gives a verdict on the alert and Triage Decision opens a war room, attaches to one or asks on-call. Fails open: if enrichment or the model fails, the alert still reaches the decision.',
  version: 1,
  icon: 'lucide:brain-circuit',
  color: '#0d9488',
  inputs: [{ name: 'alert', displayName: 'Alert' }],
  outputs: [
    { name: 'open', displayName: 'Open', slot: 'decision', index: 0 },
    { name: 'attach', displayName: 'Attach', slot: 'decision', index: 1 },
    { name: 'ask', displayName: 'Ask', slot: 'decision', index: 2 },
  ],
  slots: [
    { name: 'extract', displayName: 'Extract IOCs', description: 'Pulls indicators out of the alert for enrichment', accepts: { capability: 'ioc.extract' }, min: 0, max: 1 },
    { name: 'enrich', displayName: 'Enrichment', description: 'Threat intel on the indicators', accepts: { capability: ['ioc.enrich', 'ioc.lookup'] }, min: 0 },
    { name: 'reasoner', displayName: 'Reasoner', description: 'An AI node that reads the alert and returns a verdict', accepts: { kind: 'action', category: 'AI', input: 'ai_languageModel' }, max: 1 },
    { name: 'model', displayName: 'AI model', description: 'The chat model the reasoner uses', accepts: { supplies: 'ai_languageModel' }, max: 1 },
    { name: 'decision', displayName: 'Decision', description: 'Turns the verdict into Open, Attach or Ask', accepts: { type: 'triage.triageDecision' }, max: 1, locked: true },
  ],
  rules: [
    { rule: 'feeds', from: 'model', to: 'reasoner', via: 'ai_languageModel' },
    { rule: 'onError', slots: ['enrich', 'reasoner'], value: 'continue' },
    { rule: 'reaches', to: 'decision' },
    { rule: 'sealed' },
  ],
  starter: {
    nodes: [
      starterNode('iocs', 'extract', [80, 100]),
      starterNode('verdict', 'reasoner', [380, 260]),
      starterNode('model', 'model', [380, 460]),
      starterNode('join', undefined, [700, 100]),
      starterNode('decide', 'decision', [980, 100]),
    ],
    connections: [
      { source: 'iocs', target: 'join' },
      { source: 'iocs', target: 'verdict' },
      { source: 'model', target: 'verdict', type: 'ai_languageModel' },
      { source: 'verdict', target: 'join', targetIndex: 1 },
      { source: 'join', target: 'decide' },
    ],
  },
});
