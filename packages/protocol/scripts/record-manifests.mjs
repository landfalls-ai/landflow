// Records the bundled plugins' manifests into the test fixtures, so tests that read "recorded manifests" follow
// the plugins instead of drifting. Start the plugins first (`pnpm plugin:*`, or `pnpm dev:all`), then:
//
//   node packages/protocol/scripts/record-manifests.mjs [name=url ...]
//
// Each plugin's manifest is fetched from `GET <url>/landflow/v1/manifest` (default URLs are the dev ports below;
// `messaging=http://127.0.0.1:8104` overrides one) and written to test/fixtures/manifests/<name>.json here, and to
// apps/web/test/fixtures/plugin-manifests/<name>.json when the web tests keep a copy of that plugin. A plugin that
// does not answer is reported and its fixtures are left alone. `transports` and `maxConcurrency` are dropped: they
// follow the environment and the machine the plugin was started on, not its code. LANDFLOW_PLUGIN_TOKEN, when set,
// is sent as the bearer token.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const protocolFixtures = join(root, 'test/fixtures/manifests');
const webFixtures = join(root, '../../apps/web/test/fixtures/plugin-manifests');

const plugins = {
  'text-toolkit': 'http://127.0.0.1:7101',
  'py-insights': 'http://127.0.0.1:7102',
  'go-crypto': 'http://127.0.0.1:7103',
  messaging: 'http://127.0.0.1:7104',
  productivity: 'http://127.0.0.1:7105',
  google: 'http://127.0.0.1:7106',
  databases: 'http://127.0.0.1:7107',
};
for (const arg of process.argv.slice(2)) {
  const [name, url] = arg.split('=');
  if (!(name in plugins) || !url) throw new Error(`expected name=url with name one of ${Object.keys(plugins).join(', ')}, got ${arg}`);
  plugins[name] = url.replace(/\/+$/, '');
}

const headers = process.env.LANDFLOW_PLUGIN_TOKEN ? { authorization: `Bearer ${process.env.LANDFLOW_PLUGIN_TOKEN}` } : {};
let failed = 0;
for (const [name, url] of Object.entries(plugins)) {
  let manifest;
  try {
    const response = await fetch(`${url}/landflow/v1/manifest`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { transports: _transports, maxConcurrency: _maxConcurrency, ...rest } = await response.json();
    manifest = rest;
  } catch (err) {
    console.error(`${name}: ${url} did not answer (${err.message}); fixtures left as they were`);
    failed++;
    continue;
  }
  // The two copies keep the layout they were first recorded with.
  writeFileSync(join(protocolFixtures, `${name}.json`), JSON.stringify(manifest, null, 2));
  const web = join(webFixtures, `${name}.json`);
  if (existsSync(web)) writeFileSync(web, `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${name}: ${manifest.nodes?.length ?? 0} nodes, ${manifest.credentialTypes?.length ?? 0} credential types`);
}
process.exitCode = failed ? 1 : 0;
