import { describe, expect, it } from 'vitest';
import { parseManifest } from '@landflow/protocol';
import { manifestFromMsg, manifestToMsg } from '@landflow/protocol/grpc';
import { buildManifest, defineComposite, defineNode, definePlugin } from '../src';

const decide = defineNode({
  description: { name: 'decide', displayName: 'Decide', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }, { type: 'main' }], properties: [], capabilities: ['triage.decide'] },
  execute: (ctx) => [ctx.getInputData(), []],
});

const step = defineComposite({
  name: 'aiStep',
  displayName: 'AI step',
  description: 'A model, a reasoner and a decision',
  version: 1,
  outputs: [
    { name: 'yes', slot: 'decision', index: 0 },
    { name: 'no', slot: 'decision', index: 1 },
  ],
  slots: [
    { name: 'model', displayName: 'AI model', accepts: { supplies: 'ai_languageModel' } },
    { name: 'decision', displayName: 'Decision', accepts: { capability: 'triage.decide' }, locked: true },
  ],
  rules: [{ rule: 'sealed' }],
  starter: { nodes: [{ id: 'd', name: 'Decide', type: 'demo.decide', position: [40, 60], slot: 'decision' }], connections: [] },
});

describe('composite types', () => {
  it('travel in the manifest over HTTP and gRPC', () => {
    const manifest = buildManifest(definePlugin({ info: { id: 'demo', name: 'Demo', version: '1.0.0' }, nodes: [decide], composites: [step] }));
    expect(manifest.composites).toEqual([step]);
    expect(manifest.nodes[0].capabilities).toEqual(['triage.decide']);
    const parsed = parseManifest(manifestFromMsg(manifestToMsg(manifest)));
    expect(parsed.ok && parsed.manifest.composites).toEqual([step]);
  });

  it('are checked when the plugin is defined', () => {
    const define = (composite: Parameters<typeof defineComposite>[0]) => () => definePlugin({ info: { id: 'demo', name: 'Demo', version: '1.0.0' }, nodes: [decide], composites: [composite] });
    expect(define({ ...step, outputs: [{ name: 'yes', slot: 'verdict' }] })).toThrow(/port "yes" names unknown slot "verdict"/);
    expect(define({ ...step, slots: [...step.slots, step.slots[0]] })).toThrow(/duplicate slot "model"/);
    expect(define({ ...step, slots: [{ name: 'model', displayName: 'AI model', accepts: { supplies: 'ai_languageModel' }, min: 2, max: 1 }] })).toThrow(/max is below min/);
    expect(() => definePlugin({ info: { id: 'demo', name: 'Demo', version: '1.0.0' }, nodes: [decide], composites: [step, step] })).toThrow(/duplicate composite "aiStep" version 1/);
  });
});
