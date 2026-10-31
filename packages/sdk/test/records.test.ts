/** ctx.artifact / ctx.check: live through onRecord in-process, else in ExecuteResponse.records over HTTP and gRPC. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, type ExecuteRequest, type ExecuteResponse, type NodeRecord } from '@landflow/protocol';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, type ExecuteResponseMsg } from '@landflow/protocol/grpc';
import { defineNode, definePlugin, runNode } from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';

const GRPC_PORT = 47361;

const description = (name: string) => ({ name, displayName: name, description: '', version: 1, kind: 'action' as const, inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }], properties: [] });

const reporter = defineNode({
  description: description('reporter'),
  execute: (ctx) => {
    ctx.artifact({ name: 'PR #7: Fix it', kind: 'pull_request', url: 'https://example.test/pr/7', data: { number: 7 } });
    ctx.check({ name: 'tests', status: 'fail', message: 'token s3cret leaked', evidence: { failed: 2 } });
    if (ctx.getNodeParameter('fail', 0, false)) throw new Error('boom');
    return [{ json: {} }];
  },
});
const quiet = defineNode({ description: description('quiet'), execute: () => [{ json: {} }] });
const plugin = definePlugin({ info: { id: 'rec', name: 'Rec', version: '1' }, nodes: [reporter, quiet] });
const handle = createFetchHandler(plugin);

const request = (node = 'reporter', parameters = {}): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1', executionId: 'ex_1', mode: 'manual',
  node: { id: 'n1', name: 'Node', type: `rec.${node}`, typeVersion: 1 },
  parameters, itemParameters: [{}], inputs: [[{ json: {} }]],
});

let server: grpc.Server;
let client: grpc.Client;

const transports: Record<'http' | 'grpc', (request: ExecuteRequest) => Promise<ExecuteResponse>> = {
  http: async (req) => (await handle(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', body: JSON.stringify(req) }))).json(),
  grpc: (req) =>
    new Promise((resolve, reject) =>
      (client as unknown as Record<string, Function>).Execute(executeRequestToMsg(req), { deadline: Date.now() + 3000 }, (error: Error | null, msg: ExecuteResponseMsg) =>
        error ? reject(error) : resolve(executeResponseFromMsg(msg)),
      ),
    ),
};

beforeAll(async () => {
  server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
  client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
});
afterAll(() => {
  client.close();
  server.forceShutdown();
});

describe('records', () => {
  it('are collected into the response with a time, in order', async () => {
    const response = await runNode(reporter, request());
    expect(response.records?.map((r) => r.type)).toEqual(['artifact', 'check']);
    expect(response.records![0]).toMatchObject({ name: 'PR #7: Fix it', kind: 'pull_request', url: 'https://example.test/pr/7', data: { number: 7 } });
    expect(Date.parse(response.records![0]!.at!)).not.toBeNaN();
  });

  it('go to onRecord instead when the host gives one', async () => {
    const live: NodeRecord[] = [];
    const response = await runNode(reporter, request(), { onRecord: (r) => live.push(r) });
    expect(live.map((r) => r.name)).toEqual(['PR #7: Fix it', 'tests']);
    expect(response.records).toBeUndefined();
  });

  it('are kept when the node fails, and absent when there are none', async () => {
    expect((await runNode(reporter, request('reporter', { fail: true }))).records).toHaveLength(2);
    expect((await runNode(quiet, request('quiet'))).records).toBeUndefined();
  });

  it('mask credential values', async () => {
    const response = await runNode(reporter, { ...request(), credentials: { c: { apiKey: 's3cret' } } });
    expect(JSON.stringify(response.records)).not.toContain('s3cret');
  });

  for (const transport of ['http', 'grpc'] as const) {
    it(`travel over ${transport}`, async () => {
      const response = await transports[transport](request());
      expect(response.records).toHaveLength(2);
      expect(response.records![1]).toMatchObject({ type: 'check', status: 'fail', evidence: { failed: 2 } });
      expect((await transports[transport](request('quiet'))).records).toBeUndefined();
    });
  }
});
