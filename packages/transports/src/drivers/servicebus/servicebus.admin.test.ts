/** `createEntities` against a fake client library: which entities a real namespace gets, and the Manage-rights error. */
import { describe, expect, it, vi } from 'vitest';

const created: string[] = [];
let denied = false;
vi.mock('@azure/service-bus', () => ({
  ServiceBusClient: class {
    createSender() {
      return { createMessageBatch: async () => ({ maxSizeInBytes: 1_048_576 }), sendMessages: async () => undefined, close: async () => undefined };
    }
    async close() {}
  },
  ServiceBusAdministrationClient: class {
    async queueExists() { return false; }
    async topicExists() { return false; }
    async subscriptionExists() { return false; }
    async createQueue(name: string, options?: { requiresSession?: boolean }) {
      if (denied) throw Object.assign(new Error('401 Unauthorized'), { statusCode: 401, code: 'UnauthorizedAccess' });
      created.push(`queue ${name}${options?.requiresSession ? ' (session)' : ''}`);
    }
    async createTopic(name: string) { created.push(`topic ${name}`); }
    async createSubscription(topic: string, name: string) { created.push(`subscription ${topic}/${name}`); }
  },
}));

const { ServiceBusDriver } = await import('./index');
const REAL = 'Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc=';
const spec = (name: string, role: 'request' | 'reply' | 'registry') => ({ name, role, delivery: role === 'request' ? ('shared' as const) : ('broadcast' as const), durable: role === 'request', ttlMs: 60_000 });

describe('createEntities on a real namespace', () => {
  it('creates the plugin queue, the session reply queue, and the broadcast topic with its pool', async () => {
    created.length = 0;
    const driver = new ServiceBusDriver();
    await driver.connect({ connectionId: 'real', connectionString: REAL });
    await driver.declare([spec('landflow.v1.plugin.demo', 'request'), spec('landflow.v1.reply.host-1', 'reply'), spec('landflow.v1.registry', 'registry')]);
    expect(created).toContain('queue landflow.v1.plugin.demo');
    expect(created).toContain('queue landflow.v1.reply (session)');
    expect(created).toContain('topic landflow.v1.broadcast');
    expect(created.filter((c) => c.startsWith('subscription landflow.v1.broadcast/bc-'))).toHaveLength(16);
    await driver.close();
  });

  it('is off for the emulator, and a key without Manage rights gets an error naming the entity', async () => {
    created.length = 0;
    const emulator = new ServiceBusDriver();
    await emulator.connect({ connectionId: 'emu', connectionString: `${REAL};UseDevelopmentEmulator=true;` });
    await emulator.declare([spec('landflow.v1.plugin.demo', 'request')]);
    expect(created).toEqual([]);
    await emulator.close();

    denied = true;
    const driver = new ServiceBusDriver();
    await driver.connect({ connectionId: 'real', connectionString: REAL });
    await expect(driver.declare([spec('landflow.v1.plugin.demo', 'request')])).rejects.toThrow(/cannot create queue "landflow\.v1\.plugin\.demo".*no Manage right/);
    await driver.close();
    denied = false;
  });
});
