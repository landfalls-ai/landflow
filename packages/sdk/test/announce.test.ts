/** The announcer (docs/protocol.md §1): every announce carries this process's instanceId, over HTTP and gRPC, unchanged across endpoints, heartbeats and announcers. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnnounceRequest } from '@landflow/protocol';
import { grpc, loadLandflowProto } from '@landflow/protocol/grpc';
import { INSTANCE_ID, startAnnouncer, type Announcer } from '../src/announce';

const GRPC_PORT = 47391;
const quiet = () => {};

/** A host registry over HTTP that records announces and asks for a heartbeat every 50 ms. */
async function httpRegistry(): Promise<{ url: string; announces: AnnounceRequest[]; withdraws: object[]; server: Server }> {
  const announces: AnnounceRequest[] = [];
  const withdraws: object[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST') announces.push(JSON.parse(body));
      else withdraws.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, heartbeatIntervalSeconds: 0.05 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, announces, withdraws, server };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

const running: Announcer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((announcer) => announcer.stop()));
  for (const server of servers.splice(0)) server.close();
});

describe('announce instanceId', () => {
  it('is random hex, sent with every announce over HTTP, the same for every endpoint, heartbeat and announcer', async () => {
    expect(INSTANCE_ID).toMatch(/^[0-9a-f]{32}$/);
    const registry = await httpRegistry();
    servers.push(registry.server);
    const endpoints = ['http://127.0.0.1:7999', 'grpc://127.0.0.1:7998'];
    running.push(await startAnnouncer({ registryUrl: registry.url, endpoints, pluginId: 'test-plugin', version: '1.0.0', log: quiet }));
    // Two heartbeats for each endpoint.
    await until(() => registry.announces.length >= 4);
    expect(new Set(registry.announces.map((a) => a.endpoint))).toEqual(new Set(endpoints));
    expect(registry.announces.every((a) => a.instanceId === INSTANCE_ID && a.pluginId === 'test-plugin' && a.version === '1.0.0')).toBe(true);

    // Another announcer in the same process (a second plugin, a restart of the announcer) is still this process.
    const second = await httpRegistry();
    servers.push(second.server);
    running.push(await startAnnouncer({ registryUrl: second.url, endpoints: ['http://127.0.0.1:7997'], pluginId: 'other', version: '2.0.0', log: quiet }));
    expect(second.announces[0]?.instanceId).toBe(INSTANCE_ID);

    // Withdraws don't need it.
    await running.shift()!.stop();
    expect(registry.withdraws).toHaveLength(2);
    expect(registry.withdraws.every((w) => !('instanceId' in w))).toBe(true);
  });

  it('is sent over the gRPC RegistryService', async () => {
    const received: Array<{ endpoint: string; instanceId: string }> = [];
    const proto = loadLandflowProto();
    const server = new grpc.Server();
    server.addService(proto.RegistryService.service, {
      Announce(call: grpc.ServerUnaryCall<{ endpoint: string; instanceId: string }, unknown>, callback: grpc.sendUnaryData<unknown>) {
        received.push({ endpoint: call.request.endpoint, instanceId: call.request.instanceId });
        callback(null, { accepted: true, heartbeatIntervalSeconds: 10, message: 'ok' });
      },
      Withdraw(_call: unknown, callback: grpc.sendUnaryData<unknown>) {
        callback(null, { ok: true });
      },
    });
    await new Promise<void>((resolve, reject) => server.bindAsync(`127.0.0.1:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (error) => (error ? reject(error) : resolve())));
    try {
      running.push(await startAnnouncer({ registryUrl: `grpc://127.0.0.1:${GRPC_PORT}`, endpoints: ['grpc://127.0.0.1:7996'], pluginId: 'test-plugin', version: '1.0.0', log: quiet }));
      expect(received).toEqual([{ endpoint: 'grpc://127.0.0.1:7996', instanceId: INSTANCE_ID }]);
      await running.shift()!.stop();
    } finally {
      server.forceShutdown();
    }
  });
});
