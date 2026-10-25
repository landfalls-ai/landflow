/**
 * Runs one Code node snippet (JavaScript) inside the process the code runner starts for it:
 *
 *   node --permission --allow-fs-read=<child dir, luxon, work dir> --allow-fs-write=<work dir>
 *        --disallow-code-generation-from-strings --max-old-space-size=<MB> js-runner.mjs
 *
 * The job arrives as JSON on stdin; answers go out as JSON lines on fd 3, so nothing the snippet does to stdout can
 * forge one: `{ type: 'log', level, message }` per console line, then one `{ type: 'result', items }` or
 * `{ type: 'error', error }`.
 *
 * The snippet runs in a `node:vm` context with n8n's Code node globals and none of Node's (`require` is an allowlist,
 * no `process`, `fetch` or timers beyond the usual ones). That context is not the security boundary: string code
 * generation is off everywhere so the classic `constructor.constructor('return process')` escape fails, and the
 * process itself is locked down by the permission model (file reads and writes, child processes, workers, addons and,
 * on Node 25+, the network), by the OS sandbox and limits the runner wraps it in, and in Docker by the container.
 * With `guards` on, network and signal APIs are also stubbed out here, so Node versions without a network permission
 * stay offline too.
 */
import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { formatWithOptions } from 'node:util';
import vm from 'node:vm';

/** The snippet's file name in stack traces; line numbers are the snippet's own (the wrapper line is offset away). */
const FILE = 'code.js';
const nodeRequire = createRequire(import.meta.url);
let finished = false;
/** Lines in the snippet: an error at the wrapper's closing line (unterminated code) is reported on the last one. */
let snippetLines = Infinity;

/** Blocking write of one JSON line to fd 3 (retries if the pipe is momentarily full). */
function send(message) {
  const buffer = Buffer.from(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(3, buffer, offset);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** The one final message (a result or an error); `message` may already be a JSON line. */
function finish(message) {
  if (finished) return;
  finished = true;
  send(message);
  // Timers the snippet left behind don't hold the answer back.
  process.exit(0);
}

/** `{ kind, name, message, line, column, itemIndex, stack }` with the snippet's frames only. */
function describe(error, itemIndex, kind = 'error') {
  const isObject = error !== null && typeof error === 'object';
  const name = isObject && typeof error.name === 'string' ? error.name : 'Error';
  const message = isObject && 'message' in error ? String(error.message) : String(error);
  const stack = isObject && typeof error.stack === 'string' ? error.stack : '';
  // Runtime frames read "at code.js:3:9"; a compile error is decorated as "code.js:3\n<source>\n   ^^^".
  const at = new RegExp(`${FILE.replace('.', '\\.')}:(\\d+)(?::(\\d+))?`).exec(stack);
  const reported = at ? Number(at[1]) : undefined;
  const line = reported === undefined ? undefined : Math.max(1, Math.min(reported, snippetLines));
  let column = at?.[2] ? Number(at[2]) : undefined;
  if (column === undefined && kind === 'syntax') {
    const caret = stack.split('\n')[2]?.indexOf('^') ?? -1;
    if (caret >= 0) column = caret + 1;
  }
  if (line !== reported) column = undefined;
  const frames = stack
    .split('\n')
    .filter((entry) => /^\s+at /.test(entry) && entry.includes(FILE))
    .map((entry) => `    ${entry.trim()}`);
  return {
    kind,
    name,
    message,
    ...(line !== undefined && { line }),
    ...(column !== undefined && { column }),
    ...(itemIndex !== undefined && { itemIndex }),
    stack: [`${name}: ${message}`, ...frames].join('\n'),
  };
}

/** Network, signals and addons throw, whatever route the snippet finds to them (defence in depth). */
function installGuards() {
  const deny = (what) =>
    function denied() {
      throw Object.assign(new Error(`${what} is disabled in the code sandbox`), { code: 'ERR_SANDBOX_DENIED' });
    };
  const network = deny('Network access');
  const net = nodeRequire('node:net');
  const dgram = nodeRequire('node:dgram');
  const dns = nodeRequire('node:dns');
  net.Socket.prototype.connect = network;
  net.Server.prototype.listen = network;
  net.connect = network;
  net.createConnection = network;
  for (const key of ['bind', 'connect', 'send']) dgram.Socket.prototype[key] = network;
  for (const target of [dns, dns.promises]) {
    for (const key of Object.keys(target)) if (/^(lookup|resolve|reverse)/.test(key) && typeof target[key] === 'function') target[key] = network;
  }
  globalThis.fetch = async () => network();
  globalThis.WebSocket = undefined;
  globalThis.EventSource = undefined;
  process.kill = deny('Sending signals');
  process.dlopen = deny('Loading native addons');
}

/** n8n's return contract: items (`{ json }`) or plain objects; a primitive becomes `{ json: { value } }`. */
function toItems(result) {
  if (result === undefined || result === null) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.json !== null && typeof entry.json === 'object' && !Array.isArray(entry.json)) {
      return { json: entry.json, ...(entry.pairedItem !== undefined && { pairedItem: entry.pairedItem }), ...(entry.binary !== undefined && { binary: entry.binary }) };
    }
    return { json: entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : { value: entry } };
  });
}

/** `$input`, `$('Node')`: n8n's accessors over a list of items; `.item` follows the current item. */
function accessor(list, currentIndex) {
  return {
    all: () => list,
    first: () => list[0],
    last: () => list[list.length - 1],
    get item() {
      return list[currentIndex()] ?? list[0];
    },
    get json() {
      return (list[currentIndex()] ?? list[0])?.json;
    },
    isExecuted: true,
  };
}

function restrictedRequire(allowed, luxon) {
  const allowAll = allowed.includes('*');
  return function require(name) {
    const bare = String(name).replace(/^node:/, '');
    if (bare === 'luxon' && luxon) return luxon;
    if (isBuiltin(bare) && (allowAll || allowed.includes(bare))) return nodeRequire(`node:${bare}`);
    const offered = allowAll ? 'any Node.js built-in module' : allowed.join(', ');
    throw Object.assign(new Error(`Cannot find module '${name}': the code sandbox offers ${offered}${luxon ? ' and luxon' : ''}`), { code: 'MODULE_NOT_FOUND' });
  };
}

async function main() {
  const text = fs.readFileSync(0, 'utf8');
  const context = vm.createContext({}, { name: 'Code node', codeGeneration: { strings: false, wasm: false } });
  // Parsed by the context's JSON, so the data is of the snippet's realm (`items instanceof Array` holds).
  const job = vm.runInContext('JSON.parse', context)(text);
  if (job.guards) installGuards();

  const luxon = job.luxonPath ? nodeRequire(job.luxonPath) : undefined;
  if (luxon && job.timezone) luxon.Settings.defaultZone = job.timezone;
  const items = Array.isArray(job.items) ? job.items : [];
  const outputs = job.nodeOutputs ?? {};
  let current = 0;
  const currentIndex = () => current;
  const log = (level) => (...args) => send({ type: 'log', level, message: formatWithOptions({ colors: false, depth: 6, breakLength: 160 }, ...args) });
  const now = luxon ? luxon.DateTime.now() : new Date();

  Object.assign(context, {
    console: { log: log('info'), info: log('info'), debug: log('debug'), warn: log('warn'), error: log('error'), trace: log('debug') },
    require: restrictedRequire(job.allowBuiltins ?? [], luxon),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    atob,
    btoa,
    structuredClone,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    ...(luxon && { DateTime: luxon.DateTime, Duration: luxon.Duration, Interval: luxon.Interval, Info: luxon.Info }),
    $now: now,
    $today: luxon ? now.startOf('day') : new Date(new Date().toDateString()),
    $vars: Object.freeze({ ...(job.variables ?? {}) }),
    $execution: job.execution ?? {},
    $workflow: job.workflow ?? {},
    $runIndex: 0,
    $node: Object.fromEntries(Object.entries(outputs).map(([name, list]) => [name, { json: list[0]?.json, items: list }])),
    $: (name) => {
      const list = outputs[name];
      if (!list) throw new Error(`Node "${name}" has not run yet (or produced no output)`);
      return accessor(list, currentIndex);
    },
    items,
    $input: accessor(items, currentIndex),
  });
  const setItem = (index) => {
    current = index;
    context.$itemIndex = index;
    context.item = items[index];
    context.$json = items[index]?.json ?? {};
  };

  // A declaration rather than `(async function () {…})`: unterminated code then fails as "Unexpected end of input"
  // instead of tripping over the wrapper's `)`. The wrapper line is offset away, so lines are the snippet's own.
  snippetLines = String(job.code).split('\n').length;
  let script;
  try {
    script = new vm.Script(`async function snippet() {\n${job.code}\n}`, { filename: FILE, lineOffset: -1 });
  } catch (error) {
    return finish({ type: 'error', error: describe(error, undefined, 'syntax') });
  }
  script.runInContext(context);
  const run = context.snippet;
  context.snippet = undefined;
  const output = [];
  if (job.mode === 'each') {
    for (let index = 0; index < items.length; index++) {
      setItem(index);
      let result;
      try {
        result = await run();
      } catch (error) {
        return finish({ type: 'error', error: describe(error, index) });
      }
      for (const item of toItems(result)) output.push({ ...item, pairedItem: { item: index } });
    }
  } else {
    setItem(0);
    try {
      output.push(...toItems(await run()));
    } catch (error) {
      return finish({ type: 'error', error: describe(error) });
    }
  }
  let json;
  try {
    json = JSON.stringify(output, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  } catch (error) {
    return finish({ type: 'error', error: { kind: 'error', name: 'TypeError', message: `The returned data isn't JSON: ${error.message}` } });
  }
  finish(`{"type":"result","items":${json}}`);
}

// The event loop ran dry while the snippet still awaited something that can never settle.
process.on('beforeExit', () =>
  finish({ type: 'error', error: { kind: 'error', name: 'Error', message: 'The code awaited a promise that never settles' } }),
);
main().catch((error) => finish({ type: 'error', error: describe(error) }));
