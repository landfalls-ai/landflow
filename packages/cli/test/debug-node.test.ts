/**
 * `landflow debug-node`: against the real host (test/host.ts) it runs one node of a recorded execution against a plugin
 * served on localhost (the fixture of apps/web/test), prints the debug result and stores nothing in the execution; it is
 * refused while the owner's setting is off, for an unlisted plugin host, and for a node the execution never ran.
 * The host side is tested in apps/web/test/debug-node.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

// The fixture lives with the web tests: it is the plugin both suites serve on localhost.
interface DemoPlugin {
  url: string;
  port: number;
  close(): Promise<void>;
}
// Untyped on purpose: the fixture pulls in the plugin SDK, whose types this package's tsconfig does not build.
const fixture = (await import(/* @vite-ignore */ new URL('../../../apps/web/test/fixtures/debug-demo-plugin.ts', import.meta.url).href)) as {
  startDemoPlugin(options: { variant: 'buggy' | 'fixed' }): Promise<DemoPlugin>;
  demoPlugin(variant: 'buggy' | 'fixed'): unknown;
};

let host: Host;
let cli: ReturnType<typeof cliFor>;
let local: DemoPlugin;
let execution = '';

beforeAll(async () => {
  host = await startHost();
  local = await fixture.startDemoPlugin({ variant: 'fixed' });
  (await web('lib/server/plugins/registry')).registry.registerBuiltin(fixture.demoPlugin('buggy'));
  const owner = await (await web('lib/server/auth/users')).createOwner({ email: 'dbgnode-owner@landflow.test', name: 'Owner', password: 'correct horse battery staple' });
  const key = (await web('lib/server/auth/api-keys')).createApiKey(owner, { label: 'cli', scopes: ['admin'] });
  cli = cliFor(host, { env: { LANDFLOW_API_KEY: key.token } });
  const store = (await web('lib/server/store')).store;
  const workflow = store.saveWorkflow({
    id: 'wf_cli_debugnode',
    name: 'Shouts',
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Shout', name: 'Shout', type: 'debugdemo.shout', typeVersion: 1, position: [0, 0], parameters: { suffix: '?' } },
    ],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Shout', sourceIndex: 0, targetIndex: 0 }],
  });
  const ran = await (await web('lib/server/runner')).runWorkflow({ workflow, mode: 'manual', startNodeId: 'Shout', triggerItems: [{ json: { text: 'order 42' } }] });
  execution = ran.executionId;
});
afterAll(async () => {
  await local?.close();
  await host?.close();
});

describe('debug-node', () => {
  it('is refused while the owner has not turned the override on', async () => {
    const refused = await cli(['debug-node', execution, 'Shout', '--plugin-url', local.url, '--json']);
    expect(refused.code).not.toBe(0);
    expect(JSON.stringify(refused.json)).toMatch(/off/);
  });

  it('runs one node against the local plugin, tagged, and stores nothing', async () => {
    (await web('lib/server/debug-node/settings')).updateDebugNodeSettings({ enabled: true, allowedHosts: ['127.0.0.1'] });
    const store = (await web('lib/server/store')).store;
    const before = JSON.stringify(store.getExecution(execution));
    const result = await cli(['debug-node', execution, 'Shout', '--plugin-url', local.url, '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, debugRun: true, status: 'success', node: 'Shout', output: [{ shouted: 'ORDER 42?', build: 'fixed' }], recorded: { status: 'error' } });
    expect(JSON.stringify(store.getExecution(execution))).toBe(before);
    const human = await cli(['debug-node', execution, 'Shout', '--plugin-url', local.url]);
    expect(human.stdout).toMatch(/DEBUG RUN \(not recorded\)/);
    expect(human.stdout).toMatch(/ORDER 42\?/);
  });

  it('shows the plugin’s own failure and exits 1', async () => {
    const buggy = await fixture.startDemoPlugin({ variant: 'buggy' });
    try {
      const failed = await cli(['debug-node', execution, 'Shout', '--plugin-url', buggy.url]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toMatch(/cannot handle digits/);
    } finally {
      await buggy.close();
    }
  });

  it('refuses an unlisted host, an unrun node, bad arguments, and leaves no live token behind', async () => {
    const unlisted = await cli(['debug-node', execution, 'Shout', '--plugin-url', 'http://tunnel.example.test:' + local.port, '--json']);
    expect(unlisted.code).not.toBe(0);
    expect(JSON.stringify(unlisted.json)).toMatch(/not on the owner/);
    expect((await cli(['debug-node', execution, 'Start', '--plugin-url', local.url])).code).toBe(3); // never ran in this execution
    expect((await cli(['debug-node', execution, 'Shout'])).code).toBe(2); // no --plugin-url
    expect((await cli(['debug-node', execution, 'Shout', '--plugin-url', local.url, '--ttl', '2h'])).code).toBe(2);
    const listed = await cli(['debug-token', '--execution', execution, '--list', '--json']);
    const live = (listed.json.tokens as Array<{ revokedAt?: string; uses: number; scopes: string[] }>).filter((t) => t.scopes.includes('runs:debug') && !t.revokedAt && t.uses === 0);
    expect(live).toHaveLength(0);
  });
});
