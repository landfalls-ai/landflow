/**
 * Valkey Cluster support (lib/server/cluster/resp.ts, valkey.ts, config.ts) against fake cluster nodes: the hash slot,
 * `CLUSTER SLOTS` lookups with address translation, MOVED handled by asking again, ASK followed once, the hash-tagged key
 * prefix, and the settings. The real thing runs in valkey-cluster.integration.test.ts.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkClusterConfig, clusterConfig, ClusterConfigError } from '@/lib/server/cluster/config';
import { askCluster, encodeCommand, hashSlot, parseClusterNat, RespClient, RespParser, type RespValue } from '@/lib/server/cluster/resp';
import { ValkeyCoordinator } from '@/lib/server/cluster/valkey';

type Handler = (args: string[], socket: Socket) => string;

/** A node that answers with `handler` (raw RESP replies). */
async function fakeNode(handler: Handler): Promise<{ port: number; seen: string[][]; server: Server }> {
  const seen: string[][] = [];
  const server = createServer((socket) => {
    const parser = new RespParser();
    socket.on('data', (chunk) => {
      parser.push(chunk);
      for (let next = parser.next(); next; next = parser.next()) {
        const args = (next.value as RespValue[]).map(String);
        seen.push(args);
        socket.write(handler(args, socket));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, seen, server };
}

const slotsReply = (host: string, port: number) => `*1\r\n*3\r\n:0\r\n:16383\r\n*3\r\n$${host.length}\r\n${host}\r\n:${port}\r\n$3\r\nabc\r\n`;
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('hash slots', () => {
  it('computes CRC16 slots and honours hash tags', () => {
    expect(hashSlot('123456789')).toBe(12739);
    expect(hashSlot('foo')).toBe(12182);
    expect(hashSlot('{user1000}.following')).toBe(hashSlot('user1000'));
    expect(hashSlot('{landflow}:jobs')).toBe(hashSlot('{landflow}:k:lease:x'));
    expect(hashSlot('{landflow}:jobs:high')).toBe(hashSlot('{landflow}:leader:epoch'));
    // An empty tag is not a tag.
    expect(hashSlot('{}foo')).toBe(hashSlot('{}foo'));
    expect(hashSlot('{}foo')).not.toBe(hashSlot(''));
  });
});

describe('askCluster', () => {
  it('finds the slot owner, skips dead seeds and applies the address map', async () => {
    const node = await fakeNode((args) => (args[0] === 'CLUSTER' ? slotsReply('announced-host', 6379) : '+OK\r\n'));
    servers.push(node.server);
    const nodes = [{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: node.port }];
    const owner = await askCluster({ nodes, natMap: parseClusterNat('announced-host:6379=127.0.0.1:7777'), timeoutMs: 500 }, 5);
    expect(owner).toEqual({ host: '127.0.0.1', port: 7777 });
    // The node that answered moves to the front.
    expect(nodes[0].port).toBe(node.port);
  });

  it('fails clearly when no node answers', async () => {
    await expect(askCluster({ nodes: [{ host: '127.0.0.1', port: 1 }], timeoutMs: 300 }, 5)).rejects.toThrow(/No cluster node answered where slot 5 lives/);
  });

  it('parses the address map', () => {
    expect(parseClusterNat('a:6379=127.0.0.1:1, b:6379=[::1]:2')).toEqual({ 'a:6379': { host: '127.0.0.1', port: 1 }, 'b:6379': { host: '::1', port: 2 } });
    expect(() => parseClusterNat('nope')).toThrow(/Not an address mapping/);
  });
});

describe('the client in cluster mode', () => {
  it('follows MOVED to the owner and tries the command again', async () => {
    const owner = await fakeNode((args) => (args[0] === 'GET' ? '$2\r\nhi\r\n' : args[0] === 'ROLE' ? '*1\r\n$6\r\nmaster\r\n' : '+OK\r\n'));
    // The first node thinks it owns the slot, then says MOVED (a resharding), and from then on names the second one.
    let moved = false;
    const stale = await fakeNode((args) => {
      if (args[0] === 'CLUSTER') return slotsReply('127.0.0.1', moved ? owner.port : staleHolder.port);
      if (args[0] === 'ROLE') return '*1\r\n$6\r\nmaster\r\n';
      if (args[0] === 'GET') {
        moved = true;
        return `-MOVED 1 127.0.0.1:${owner.port}\r\n`;
      }
      return '+OK\r\n';
    });
    const staleHolder = stale;
    servers.push(owner.server, stale.server);
    const seeds = { nodes: [{ host: '127.0.0.1', port: stale.port }], timeoutMs: 500 };
    const client = new RespClient({ url: 'redis://127.0.0.1:1', resolve: () => askCluster(seeds, 1), primaryOnly: true, cluster: true });
    try {
      expect(await client.call('GET', 'k')).toBe('hi');
      expect(owner.seen.some((args) => args[0] === 'GET')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('follows ASK once on a short-lived connection (ASKING first)', async () => {
    const target = await fakeNode((args) => (args[0] === 'GET' ? '$5\r\nasked\r\n' : '+OK\r\n'));
    const home = await fakeNode((args) => {
      if (args[0] === 'CLUSTER') return slotsReply('127.0.0.1', home.port);
      if (args[0] === 'ROLE') return '*1\r\n$6\r\nmaster\r\n';
      if (args[0] === 'GET') return `-ASK 1 127.0.0.1:${target.port}\r\n`;
      return '+OK\r\n';
    });
    servers.push(target.server, home.server);
    const seeds = { nodes: [{ host: '127.0.0.1', port: home.port }], timeoutMs: 500 };
    const client = new RespClient({ url: 'redis://127.0.0.1:1', resolve: () => askCluster(seeds, 1), primaryOnly: true, cluster: true });
    try {
      expect(await client.call('GET', 'k')).toBe('asked');
      expect(target.seen.map((args) => args[0])).toEqual(['ASKING', 'GET']);
    } finally {
      await client.close();
    }
  });
});

describe('the coordinator in cluster mode', () => {
  it('puts every key under one hash tag', async () => {
    const node = await fakeNode((args) => {
      if (args[0] === 'CLUSTER') return slotsReply('127.0.0.1', node.port);
      if (args[0] === 'ROLE') return '*1\r\n$6\r\nmaster\r\n';
      if (args[0] === 'XADD') return '$3\r\n1-0\r\n';
      if (args[0] === 'EVALSHA' || args[0] === 'EVAL') return '*3\r\n$1\r\na\r\n:1\r\n:1\r\n';
      return ':1\r\n';
    });
    servers.push(node.server);
    const coordinator = new ValkeyCoordinator('redis://127.0.0.1:1', 'myq', 'test', { cluster: { nodes: [{ host: '127.0.0.1', port: node.port }], natMap: {} } });
    try {
      await coordinator.enqueue({ executionId: 'e', workflowId: 'w', priority: 'high' } as never);
      await coordinator.setIfAbsent('lease:x', '1', 1000);
      await coordinator.campaign('me', 1000);
      await coordinator.admit('wf', 'e', { slots: 1, waiting: 0, overflow: 'queue', queueSize: 5 } as never, 1000);
      await coordinator.heartbeat({ id: 'me' } as never, 1000);
      const keys = node.seen.flatMap((args) => {
        if (args[0] === 'XADD') return [args[1]];
        if (args[0] === 'SET') return [args[1]];
        if (args[0] === 'EVALSHA' || args[0] === 'EVAL') return args.slice(3, 3 + Number(args[2]));
        return [];
      });
      expect(keys.length).toBeGreaterThan(5);
      for (const key of keys) expect(key).toMatch(/^\{myq\}:/);
      expect(new Set(keys.map(hashSlot)).size).toBe(1);
    } finally {
      await coordinator.close();
    }
  });
});

describe('settings', () => {
  it('reads LANDFLOW_VALKEY_CLUSTER and the address map, and refuses Sentinel as well', () => {
    const config = clusterConfig({ LANDFLOW_EXECUTIONS_MODE: 'queue', LANDFLOW_VALKEY_CLUSTER: 'a:7000,b', LANDFLOW_VALKEY_CLUSTER_NAT: 'x:6379=127.0.0.1:7000' });
    expect(config.cluster?.nodes).toEqual([{ host: 'a', port: 7000 }, { host: 'b', port: 6379 }]);
    expect(config.cluster?.natMap['x:6379']).toEqual({ host: '127.0.0.1', port: 7000 });
    expect(clusterConfig({}).cluster).toBeUndefined();
    const both = clusterConfig({ LANDFLOW_EXECUTIONS_MODE: 'queue', LANDFLOW_VALKEY_CLUSTER: 'a:1', LANDFLOW_VALKEY_SENTINELS: 's:2' });
    expect(() => checkClusterConfig(both, { LANDFLOW_DB: 'postgres' })).toThrow(ClusterConfigError);
  });

  it('encodes commands (sanity for the fakes)', () => {
    expect(encodeCommand(['GET', 'k']).toString()).toBe('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
  });
});
