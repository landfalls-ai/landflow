/**
 * Hello Node: the smallest plugin that shows the parts every integration has.
 *
 *  - a credential type with a "Test connection" check,
 *  - an action (`greet`) that uses the credential and sends items to one of two outputs,
 *  - a poll trigger (`newRequest`) that remembers where it stopped.
 */
import { defineCredentialType, defineNode, definePlugin, NodeOperationError, pollIntervalProperty } from '@landflow/sdk';

/** What the credential form holds. `apiKey` is a password field: masked in the UI and redacted from logs. */
export interface HelloApi {
  apiKey: string;
  salutation: string;
  [key: string]: string;
}

export const helloApi = defineCredentialType<HelloApi>({
  name: 'helloApi',
  displayName: 'Hello API',
  documentationUrl: 'https://example.com/hello-api',
  properties: [
    { name: 'apiKey', displayName: 'API key', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'salutation', displayName: 'Salutation', type: 'string', default: 'Hello' },
  ],
  // A real plugin makes one cheap authenticated call here with `ctx.http` (Slack `auth.test`, Telegram `getMe`).
  // The sample checks the key's shape so it needs no network.
  async test({ apiKey }) {
    return apiKey.startsWith('hello-') ? { ok: true, message: 'Key accepted' } : { ok: false, message: 'The key must start with "hello-"' };
  },
});

export const MAX_NAME_LENGTH = 50;

/** One action, two outputs: output 0 gets the greetings, output 1 the items that had nobody to greet. */
export const greet = defineNode({
  description: {
    name: 'greet',
    displayName: 'Hello: Greet',
    description: 'Greet the name in each item',
    version: 1,
    kind: 'action',
    categories: ['Examples'],
    icon: 'lucide:hand',
    subtitle: '{{name}}',
    idempotent: true, // the same input gives the same output, so a broker may deliver a call twice
    usableAsTool: true, // an agent may call it, and it becomes an MCP tool
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'Greeted' },
      { type: 'main', displayName: 'Skipped' },
    ],
    credentials: [{ name: 'helloApi', required: true }],
    properties: [
      { name: 'name', displayName: 'Name', type: 'string', default: '', description: 'Who to greet. An empty name goes to Skipped.' },
      { name: 'shout', displayName: 'Shout', type: 'boolean', default: false },
    ],
  },
  async execute(ctx) {
    const { salutation } = ctx.getCredentials<HelloApi>('helloApi');
    const greeted = [];
    const skipped = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      try {
        const name = ctx.getNodeParameter<string>('name', i).trim();
        if (name.length > MAX_NAME_LENGTH) {
          throw new NodeOperationError(`The name is longer than ${MAX_NAME_LENGTH} characters`, { itemIndex: i });
        }
        if (name === '') {
          skipped.push({ json: { ...item.json, reason: 'empty name' } });
          continue;
        }
        const text = `${salutation}, ${name}!`;
        greeted.push({ json: { ...item.json, greeting: ctx.getNodeParameter<boolean>('shout', i) ? text.toUpperCase() : text } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error; // the node is not set to continue: the step fails
        skipped.push({ json: { ...item.json, error: (error as Error).message }, pairedItem: { item: i } });
      }
    }
    ctx.logger.info('greeted', { greeted: greeted.length, skipped: skipped.length });
    return [greeted, skipped];
  },
});

/** The stand-in for the service a real trigger polls. Tests push to it. */
export const requests: Array<{ id: number; name: string }> = [];

/** A poll trigger: the host calls it every `pollInterval` seconds with the state the last call returned. */
export const newRequest = defineNode({
  description: {
    name: 'newRequest',
    displayName: 'Hello: New Request',
    description: 'Starts the workflow for each new greeting request',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'helloApi', required: true }],
    properties: [pollIntervalProperty(30)],
  },
  async execute(ctx) {
    ctx.getCredentials<HelloApi>('helloApi');
    const newest = Math.max(0, ...requests.map((r) => r.id));
    if (ctx.mode === 'manual') return requests.slice(-3).map((r) => ({ json: { ...r } })); // "Execute" in the editor: a few recent items, no state
    if (ctx.isFirstPoll()) {
      ctx.setPollState({ lastId: newest }); // baseline: remember where we are and emit nothing
      return [];
    }
    const lastId = ctx.getPollState<{ lastId: number }>()?.lastId ?? 0;
    ctx.setPollState({ lastId: Math.max(lastId, newest) });
    return requests.filter((r) => r.id > lastId).map((r) => ({ json: { ...r } }));
  },
});

export const plugin = definePlugin({
  info: { id: 'hello-node', name: 'Hello Node', version: '0.1.0', description: 'A small example plugin', icon: 'lucide:hand', color: '#16a34a', author: 'Landflow examples' },
  nodes: [greet, newRequest],
  credentialTypes: [helloApi],
});
