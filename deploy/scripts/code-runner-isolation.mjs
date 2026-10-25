#!/usr/bin/env node
/**
 * Checks the dockerised code runner's isolation from inside snippets, through its published port: no network (an
 * internet address, DNS, an HTTPS fetch, the Mac and the network's gateway) and no writes outside /tmp.
 *
 *   node deploy/scripts/code-runner-isolation.mjs [url]     # default http://127.0.0.1:53300
 *
 * The secret is LANDFLOW_CODE_RUNNER_SECRET (default: the compose file's dev value). Every attempt prints the error
 * that stopped it, which shows the layer: "disabled in the code sandbox" is an in-process guard, ENETUNREACH or a
 * DNS failure is the container's internal network, EROFS the read-only root filesystem. With the runner's guards off
 * (CODE_RUNNER_GUARDS=off, diagnostics only) the same checks show what the container alone stops. Exits 1 if any
 * attempt gets through.
 */
const url = (process.argv[2] ?? `http://127.0.0.1:${process.env.LANDFLOW_CODE_RUNNER_PORT ?? 53300}`).replace(/\/+$/, '');
const secret = process.env.LANDFLOW_CODE_RUNNER_SECRET ?? 'landflow-code-runner-dev-only';
const headers = { 'content-type': 'application/json', 'x-landflow-runner-secret': secret };

async function run(language, code) {
  const response = await fetch(`${url}/v1/run`, { method: 'POST', headers, body: JSON.stringify({ language, mode: 'all', code, items: [] }) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`${language} snippet failed: ${result.error.message}\n${result.error.stack ?? ''}`);
  return result.items[0].json;
}

const PYTHON_NETWORK = `
import socket, urllib.request
out = {}
def attempt(name, action):
    try:
        action()
        out[name] = 'CONNECTED'
    except BaseException as error:
        out[name] = f'{type(error).__name__}: {error}'
attempt('tcp 1.1.1.1:443', lambda: socket.create_connection(('1.1.1.1', 443), timeout=3).close())
attempt('dns example.com', lambda: socket.getaddrinfo('example.com', 443))
attempt('https://example.com', lambda: urllib.request.urlopen('https://example.com', timeout=5))
attempt('mac host.docker.internal:3000', lambda: socket.create_connection(('host.docker.internal', 3000), timeout=3).close())
# The Docker host's side of the bridge (x.x.x.1) on an ordinary internal network, where every port published on
# 0.0.0.0 answers: the dev server, the dockerised host and common services of other projects.
try:
    subnet = socket.gethostbyname(socket.gethostname()).rsplit('.', 1)[0]
except OSError:
    subnet = '172.17.0'
for port in (3000, 53000, 5432, 6379, 8080):
    attempt(f'docker host {subnet}.1:{port}', lambda: socket.create_connection((subnet + '.1', port), timeout=2).close())
routes = open('/proc/net/route').read().splitlines()[1:]
out['default route'] = 'present' if any(line.split()[1] == '00000000' for line in routes) else 'none'
return out
`;

const PYTHON_FILES = `
import os
out = {}
for path in ('/app/x', '/etc/x', '/x', '/usr/local/bin/x', '/tmp/../app/x'):
    try:
        open(path, 'w').write('x')
        out['write ' + path] = 'WRITTEN'
    except OSError as error:
        out['write ' + path] = f'{type(error).__name__}: {error}'
open('inside.txt', 'w').write('ok')
out['write <work dir>/inside.txt'] = 'ok: ' + os.getcwd()
root = [line for line in open('/proc/self/mounts') if line.split()[1] == '/']
out['/ mount options'] = root[0].split()[3].split(',')[0] if root else 'unknown'
out['uid'] = os.getuid()
return out
`;

const JS_NETWORK = `
const out = { 'typeof fetch': typeof fetch };
const attempt = async (name, action) => {
  try { await action(); out[name] = 'CONNECTED'; } catch (error) { out[name] = (error.code ? error.code + ': ' : '') + error.message; }
};
await attempt('net 1.1.1.1:443', () => new Promise((resolve, reject) => { const s = require('net').connect(443, '1.1.1.1'); s.setTimeout(3000, () => reject(new Error('timeout'))); s.on('connect', resolve).on('error', reject); }));
await attempt('https://example.com', () => new Promise((resolve, reject) => require('https').get('https://example.com', resolve).on('error', reject)));
return out;
`;

const JS_FILES = `
const out = {};
for (const path of ['/app/x', '/etc/x', '/tmp/outside-work-dir']) {
  try { require('fs').writeFileSync(path, 'x'); out['write ' + path] = 'WRITTEN'; } catch (error) { out['write ' + path] = (error.code ? error.code + ': ' : '') + error.message; }
}
return out;
`;

const info = await (await fetch(`${url}/v1/info`, { headers })).json();
console.log(`code runner ${info.version} at ${url}: node ${info.languages.javascript.version}, python ${info.languages.python?.version ?? '-'}`);
console.log(`isolation: ${Object.entries(info.isolation).map(([key, value]) => `${key}=${value}`).join(' ')}\n`);

let leaks = 0;
for (const [title, language, code] of [
  ['Python: network', 'python', PYTHON_NETWORK],
  ['Python: file system', 'python', PYTHON_FILES],
  ['JavaScript: network', 'javascript', JS_NETWORK],
  ['JavaScript: file system', 'javascript', JS_FILES],
]) {
  console.log(title);
  for (const [check, outcome] of Object.entries(await run(language, code))) {
    const leaked = outcome === 'CONNECTED' || outcome === 'WRITTEN' || (check === 'default route' && outcome !== 'none');
    if (leaked) leaks++;
    console.log(`  ${leaked ? 'LEAK' : 'ok  '}  ${check.padEnd(32)} ${outcome}`);
  }
}
console.log(leaks ? `\n${leaks} attempt(s) got through` : '\nevery attempt was blocked');
process.exit(leaks ? 1 : 0);
