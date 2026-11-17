import { describe, expect, it } from 'vitest';
import { runNode, runTestCredentials, type JsonObject } from '@landflow/sdk';
import type { ExecuteRequest } from '@landflow/protocol';
import { greet, newRequest, plugin, requests } from '../src/plugin';

const credentials = { helloApi: { apiKey: 'hello-123', salutation: 'Hello' } };
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'hello-node' };

/** The request the host sends. A test builds the same shape and calls runNode, with no server and no network. */
function request(type: string, parameters: JsonObject, items: JsonObject[], more: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Node', type: `hello-node.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items.map((json) => ({ json }))],
    credentials,
    ...more,
  };
}

describe('greet', () => {
  it('sends greetings to output 0 and empty names to output 1', async () => {
    const response = await runNode(greet, request('greet', { name: 'Ada', shout: false }, [{ id: 1 }]), extras);
    expect(response.error).toBeUndefined();
    expect(response.outputs[0].map((i) => i.json)).toEqual([{ id: 1, greeting: 'Hello, Ada!' }]);
    expect(response.outputs[1]).toEqual([]);

    const empty = await runNode(greet, request('greet', { name: '  ' }, [{ id: 2 }]), extras);
    expect(empty.outputs[0]).toEqual([]);
    expect(empty.outputs[1].map((i) => i.json)).toEqual([{ id: 2, reason: 'empty name' }]);
  });

  it('shouts, and uses the credential salutation', async () => {
    const response = await runNode(greet, request('greet', { name: 'Ada', shout: true }, [{}], { credentials: { helloApi: { apiKey: 'hello-1', salutation: 'Hi' } } }), extras);
    expect(response.outputs[0][0].json.greeting).toBe('HI, ADA!');
  });

  it('fails the step with the item index, and a node set to continue on fail sends the item to Skipped', async () => {
    const long = 'x'.repeat(51);
    const failed = await runNode(greet, request('greet', { name: long }, [{}]), extras);
    expect(failed.error).toMatchObject({ message: expect.stringContaining('longer than 50'), itemIndex: 0 });

    const kept = await runNode(greet, request('greet', { name: long }, [{}], { continueOnFail: true }), extras);
    expect(kept.error).toBeUndefined();
    expect(kept.outputs[1][0].json.error).toContain('longer than 50');
  });

  it('refuses to run without the credential', async () => {
    const response = await runNode(greet, request('greet', { name: 'Ada' }, [{}], { credentials: {} }), extras);
    expect(response.error?.message).toContain('helloApi');
  });
});

describe('credential test', () => {
  it('accepts a key of the right shape and says why it refuses another', async () => {
    expect(await runTestCredentials(plugin, { credentialType: 'helloApi', data: { apiKey: 'hello-1' } })).toEqual({ ok: true, message: 'Key accepted' });
    expect(await runTestCredentials(plugin, { credentialType: 'helloApi', data: { apiKey: 'nope' } })).toMatchObject({ ok: false });
  });
});

describe('newRequest (poll trigger)', () => {
  it('records a baseline first, then returns only what is new, and keeps the state', async () => {
    requests.push({ id: 1, name: 'old' });
    const first = await runNode(newRequest, request('newRequest', {}, [], { mode: 'poll', inputs: [] }), extras);
    expect(first.outputs[0] ?? []).toEqual([]);
    expect(first.pollState).toEqual({ lastId: 1 });

    requests.push({ id: 2, name: 'new' });
    const second = await runNode(newRequest, request('newRequest', {}, [], { mode: 'poll', inputs: [], pollState: first.pollState }), extras);
    expect(second.outputs[0].map((i) => i.json)).toEqual([{ id: 2, name: 'new' }]);
    expect(second.pollState).toEqual({ lastId: 2 });
  });

  it('shows recent items in manual mode without state', async () => {
    const response = await runNode(newRequest, request('newRequest', {}, [], { mode: 'manual', inputs: [] }), extras);
    expect(response.outputs[0].length).toBeGreaterThan(0);
    expect(response.pollState).toBeUndefined();
  });
});

describe('manifest', () => {
  it('has two outputs on greet, a testable credential and the poll interval', () => {
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['greet', 'newRequest']);
    expect(greet.description.outputs).toHaveLength(2);
    expect(newRequest.description.properties.map((p) => p.name)).toContain('pollInterval');
  });
});
