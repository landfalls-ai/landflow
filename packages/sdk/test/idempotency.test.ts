/** ExecuteRequest.idempotencyKey reaches ctx.getIdempotencyKey() in-process, over HTTP and over gRPC. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, type ExecuteRequest, type ExecuteResponse } from '@landflow/protocol';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, type ExecuteResponseMsg } from '@landflow/protocol/grpc';
import { defineNode, definePlugin, runNode } from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';

const GRPC_PORT = 47333;

const keyNode = defineNode({
  description: { name: 'key', displayName: 'Key', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  execute: (ctx) => [{ json: { key: ctx.getIdempotencyKey() ?? null } }],
});
const plugin = definePlugin({ info: { id: 'idem', name: 'Idem', version: '1' }, nodes: [keyNode] });
const handle = createFetchHandler(plugin);

const request = (idempotencyKey?: string): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1', executionId: 'ex_1', mode: 'manual',
  node: { id: 'n3', name: 'Key', type: 'idem.key', typeVersion: 1 },
  parameters: {}, itemParameters: [{}], inputs: [[{ json: {} }]],
  ...(idempotencyKey !== undefined && { idempotencyKey }),
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

describe('idempotencyKey', () => {
  it('is exposed as ctx.getIdempotencyKey(), undefined when the host sends none', async () => {
    expect((await runNode(keyNode, request('ex_1:n3:0'))).outputs[0]![0]!.json).toEqual({ key: 'ex_1:n3:0' });
    expect((await runNode(keyNode, request())).outputs[0]![0]!.json).toEqual({ key: null });
    expect((await runNode(keyNode, request(''))).outputs[0]![0]!.json).toEqual({ key: null });
  });

  for (const [name, send] of Object.entries(transports)) {
    it(`passes through the ${name} binding`, async () => {
      expect((await send(request('ex_1:n3:2'))).outputs[0]![0]!.json).toEqual({ key: 'ex_1:n3:2' });
      expect((await send(request())).outputs[0]![0]!.json).toEqual({ key: null });
    });
  }
});
