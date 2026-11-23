/** The dot-agent-deck node through the SDK's runNode, against the fake deck. */
import { afterEach, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { ExecuteRequest } from '@landflow/protocol';
import { Deck } from '../src/nodes/deck';
import { Watches } from '../src/watches';
import { plugin } from '../src/main';
import { useFakeDeck } from './helpers';

afterEach(() => {
  delete process.env.LANDFLOW_DECK_BIN;
  delete process.env.DOT_AGENT_DECK_PANE_ID;
  delete process.env.FAKE_DECK_DIR;
});

const request = (parameters: JsonObject): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_test',
  workflowId: 'wf_test',
  mode: 'manual',
  node: { id: 'n1', name: 'Deck', type: 'deck.deck', typeVersion: 1 },
  parameters,
  itemParameters: [parameters],
  inputs: [[{ json: { keep: 1 } }]],
});
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'deck' };
const origin = 'http://127.0.0.1:3000';
const newWatches = () => new Watches({ fetchInbox: async () => [], hostOrigin: () => origin });
const W = '/api/waiting';

describe('Deck node', () => {
  it('Dispatch starts a unit, keeps a watch and outputs the unit', async () => {
    const fake = useFakeDeck();
    const watches = newWatches();
    const response = await runNode(new Deck(watches), request({ operation: 'dispatch', name: 'nightly', task: 'fix the build', reportTo: `${origin}${W}/ex_test` }), extras);
    expect(response.error).toBeUndefined();
    expect(response.outputs[0][0].json).toMatchObject({ keep: 1, unit: 'nightly', admitted: true, watching: true, message: 'Dispatch request sent to the daemon.' });
    expect(fake.calls()[0]).toMatchObject({ args: ['dispatch', 'nightly', '--task-file', '-'], stdin: 'fix the build' });
    expect(watches.size).toBe(1);
  });

  it('without Report To, dispatches and says nothing is watching', async () => {
    useFakeDeck();
    const watches = newWatches();
    const response = await runNode(new Deck(watches), request({ operation: 'dispatch', name: 'nightly', task: 't', reportTo: '' }), extras);
    expect(response.outputs[0][0].json).toMatchObject({ unit: 'nightly', watching: false });
    expect(watches.size).toBe(0);
  });

  it('Report To defaults to the run\'s resume URL', () => {
    const reportTo = new Deck(newWatches()).description.properties.find((p) => p.name === 'reportTo');
    expect(reportTo?.default).toBe('{{ $execution.resumeUrl }}');
  });

  it('fails with the pane message outside a deck pane', async () => {
    useFakeDeck({ pane: false });
    const response = await runNode(new Deck(newWatches()), request({ operation: 'dispatch', name: 'n', task: 't', reportTo: '' }), extras);
    expect(response.error?.message).toContain('run the deck plugin from a deck pane');
  });

  it('fails with the deck\'s trust hint for an untrusted orchestration', async () => {
    const fake = useFakeDeck();
    fake.refuse('Error: orchestration "review" is not trusted. Run `dot-agent-deck trust approve review`.');
    const response = await runNode(new Deck(newWatches()), request({ operation: 'dispatch', name: 'n', task: 't', reportTo: '' }), extras);
    expect(response.error?.message).toMatch(/not trusted/);
    expect(JSON.stringify(response.error)).toContain('trust approve review');
  });

  it('fails with "not found on PATH" when the binary is missing', async () => {
    useFakeDeck();
    process.env.LANDFLOW_DECK_BIN = '/nonexistent/dot-agent-deck';
    const response = await runNode(new Deck(newWatches()), request({ operation: 'dispatch', name: 'n', task: 't', reportTo: '' }), extras);
    expect(response.error?.message).toContain('dot-agent-deck not found on PATH');
  });

  it('refuses a second dispatch of a name that is already watched, before running the deck', async () => {
    const fake = useFakeDeck();
    const watches = newWatches();
    const node = new Deck(watches);
    const params = { operation: 'dispatch', name: 'same', task: 't', reportTo: `${origin}${W}/ex_test` };
    await runNode(node, request(params), extras);
    const again = await runNode(node, request(params), extras);
    expect(again.error?.message).toMatch(/already/);
    expect(fake.calls().filter((c) => c.args[0] === 'dispatch')).toHaveLength(1);
  });

  it('releases the name when the deck refuses, so the flow can try again', async () => {
    const fake = useFakeDeck();
    fake.refuse('Error: orchestration "review" is not trusted.');
    const watches = newWatches();
    const response = await runNode(new Deck(watches), request({ operation: 'dispatch', name: 'n', task: 't', reportTo: `${origin}${W}/ex_test` }), extras);
    expect(response.error).toBeDefined();
    expect(watches.size).toBe(0);
  });

  it('refuses several items when Report To is set (one Wait cannot hear several units)', async () => {
    const fake = useFakeDeck();
    const two = { ...request({ operation: 'dispatch', name: 'n', task: 't', reportTo: `${origin}${W}/ex_test` }), inputs: [[{ json: { a: 1 } }, { json: { a: 2 } }]], itemParameters: [{}, {}] } as ExecuteRequest;
    const response = await runNode(new Deck(newWatches()), two, extras);
    expect(response.error?.message).toMatch(/one item/i);
    expect(fake.calls()).toEqual([]);
  });

  it('does not start the unit when Report To is off the waiting path', async () => {
    const fake = useFakeDeck();
    const response = await runNode(new Deck(newWatches()), request({ operation: 'dispatch', name: 'n', task: 't', reportTo: `${origin}/api/other/x` }), extras);
    expect(response.error?.message).toMatch(/Report To/);
    expect(fake.calls()).toEqual([]);
  });
});

describe('plugin', () => {
  it('announces one node, deck', () => {
    expect(plugin.info.id).toBe('deck');
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['deck']);
  });
});
