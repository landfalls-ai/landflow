#!/usr/bin/env python3
"""
Compare every installed transport on the same call: webhook -> transport-bench.echo, pinned to HTTP, gRPC and each broker.

  python3 deploy/scripts/transport-bench.py                                  # defaults: a few minutes
  python3 deploy/scripts/transport-bench.py --kinds http,grpc,nats,kafka --calls 100 --sizes 100B,64KiB
  python3 deploy/scripts/transport-bench.py --out bench.json --secret-file ~/landflow-transport.secret

What it does (docs/transports.md, phase 7):
  1. starts plugins/transport-bench (one node, Echo) with tsx on --port (HTTP) and --port + 1 (gRPC), with a broker face for
     every benchmarked kind (LANDFLOW_TRANSPORTS + LANDFLOW_<KIND>_URL), and lets it announce itself to the host;
  2. creates one broker connection per kind ("TMP T4-D <kind>") through /api/transports/connections;
  3. publishes two webhook workflows, "TMP T4-D baseline" (webhook -> Set, core nodes only) and "TMP T4-D echo"
     (webhook -> transport-bench.echo), so engine and HTTP overhead can be subtracted;
  4. per kind: pins the plugin to it (PATCH /api/plugins/transport-bench), warms up, then times --calls sequential calls per
     size (p50/p95/p99/mean, errors) and runs --concurrency callers for --duration seconds (calls/s). The host's own
     p50/p95 for the kind (the Plugins page numbers) are read back and the calls are checked to have gone over the kind;
  5. prints a table and writes --out as JSON; in a finally block stops the plugin and deletes everything it created.

The host (dev server) and the plugin must share LANDFLOW_TRANSPORT_SECRET: it is taken from the environment, or from
--secret-file (a file holding it). Its value is never printed.
Local only: brokers on 127.0.0.1 (deploy/compose.infra.yml), SQS on LocalStack with dummy keys, Pub/Sub and Service Bus
on their emulators. Python 3 standard library only; needs node_modules (tsx) in the repo.
"""
import argparse
import http.client
import json
import os
import re
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PLUGIN_DIR = ROOT / 'plugins' / 'transport-bench'
PLUGIN_ID = 'transport-bench'
OWNER = {'email': 'owner@landflow.test', 'password': 'landflow-dev-only'}  # dev-only owner (deploy/.env.example)
PREFIX = 'TMP T4-D'
SUFFIX = time.strftime('%H%M%S')
DIRECT = ('http', 'grpc')
DEV_USER, DEV_PASSWORD = 'landflow', 'landflow-dev-only'  # RabbitMQ and Artemis dev credentials (deploy/.env.example)

# Local brokers: where to probe, the connection's URL, its secrets and extra fields (host side), and the extra
# LANDFLOW_<KIND>_<FIELD> variables the plugin needs. Ports are the ones in deploy/compose.infra.yml.
BROKERS = {
    'kafka': dict(port=59092, url='kafka://127.0.0.1:59092'),
    'amqp': dict(port=55672, url='amqp://127.0.0.1:55672', user=DEV_USER, password=DEV_PASSWORD),
    'nats': dict(port=54222, url='nats://127.0.0.1:54222'),
    'jetstream': dict(port=54222, url='nats://127.0.0.1:54222'),
    'valkey': dict(port=56379, url='redis://127.0.0.1:56379'),
    'mqtt': dict(port=51883, url='mqtt://127.0.0.1:51883'),
    'amqp1': dict(port=55674, url='amqp://127.0.0.1:55674', user=DEV_USER, password=DEV_PASSWORD),
    'sqs': dict(port=54566, url='http://127.0.0.1:54566', fields={'region': 'us-east-1', 'endpoint': 'http://127.0.0.1:54566'}),
    'pubsub': dict(port=58085, url='pubsub://127.0.0.1:58085/landflow-dev'),
    'pulsar': dict(port=56650, url='pulsar://127.0.0.1:56650', fields={'adminUrl': 'http://127.0.0.1:58180'}),
    'servicebus': dict(port=55675, url='sb://127.0.0.1:55675', fields={'emulator': True}),
}

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
BASE = 'http://localhost:3000'
ORIGIN = BASE


def say(message=''):
    print(message, flush=True)


# ---------------------------------------------------------------------------- host API


def call(method, path, body=None, timeout=60, raw=False):
    data = None if body is None else json.dumps(body).encode()
    headers = {'content-type': 'application/json', 'origin': ORIGIN} if data is not None or method != 'GET' else {}
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with opener.open(request, timeout=timeout) as response:
            text = response.read().decode()
            return (response.status, text) if raw else json.loads(text or 'null')
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        if raw:
            return error.code, text
        raise RuntimeError(f'{method} {path}: HTTP {error.code} {text[:300]}') from None


def node(name, type_, parameters=None, version=1):
    return {'id': name, 'name': name, 'type': type_, 'typeVersion': version, 'position': [0, 0], 'parameters': parameters or {}}


def publish_workflow(name, path, middle):
    """webhook (responds with the last node) -> middle; created and published; returns the workflow id."""
    nodes = [node('Webhook', 'core.webhook', {'path': path, 'method': 'POST', 'respond': 'lastNode'}), middle]
    for index, n in enumerate(nodes):
        n['position'] = [index * 240, 0]
    connections = [{'id': 'e0', 'type': 'main', 'source': 'Webhook', 'target': middle['id'], 'sourceIndex': 0, 'targetIndex': 0}]
    created = call('POST', '/api/workflows', {'name': name, 'nodes': nodes, 'connections': connections})
    workflow_id = created['workflow']['id']
    call('POST', f'/api/workflows/{workflow_id}/publish', {})
    return workflow_id


def wait_for(what, fn, timeout, every=0.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(every)
    raise RuntimeError(f'timed out after {timeout:.0f} s waiting for {what}')


def plugin_view():
    return next((p for p in call('GET', '/api/plugins')['plugins'] if p['id'] == PLUGIN_ID), None)


def kind_summary(kind):
    plugin = plugin_view() or {}
    return next((t for t in plugin.get('transports', []) if t['kind'] == kind), None)


# ---------------------------------------------------------------------------- helpers


def parse_size(text):
    match = re.fullmatch(r'(\d+)\s*(b|kb|kib|mb|mib)?', text.strip().lower())
    if not match:
        raise argparse.ArgumentTypeError(f'"{text}" is not a size (100B, 64KiB, 1MiB)')
    unit = {None: 1, 'b': 1, 'kb': 1000, 'kib': 1024, 'mb': 1000 ** 2, 'mib': 1024 ** 2}[match.group(2)]
    return int(match.group(1)) * unit


def size_label(n):
    for unit, factor in (('MiB', 1024 ** 2), ('KiB', 1024)):
        if n >= factor and n % factor == 0:
            return f'{n // factor}{unit}'
    return f'{n}B'


def reachable(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def read_secret(secret_file):
    if os.environ.get('LANDFLOW_TRANSPORT_SECRET'):
        return os.environ['LANDFLOW_TRANSPORT_SECRET']
    if secret_file:
        return Path(secret_file).expanduser().read_text().strip()
    sys.exit('LANDFLOW_TRANSPORT_SECRET is not set: export the dev server\'s value or pass --secret-file <a file holding it>')


def percentile(sorted_values, q):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, max(0, int(round(q * len(sorted_values) + 0.5)) - 1))]


def summarize(latencies_ms, errors):
    values = sorted(latencies_ms)
    if not values:
        return dict(n=0, errors=errors)
    return dict(n=len(values), errors=errors, p50=percentile(values, 0.50), p95=percentile(values, 0.95), p99=percentile(values, 0.99),
                mean=statistics.fmean(values), min=values[0], max=values[-1])


# ---------------------------------------------------------------------------- the bench plugin


class BenchPlugin:
    def __init__(self, kinds, port, secret, log_path):
        self.kinds = kinds
        self.port = port
        self.secret = secret
        self.log_path = log_path
        self.process = None

    def env(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'GOOGLE_'))}
        env.update({
            'AWS_SHARED_CREDENTIALS_FILE': '/dev/null', 'AWS_CONFIG_FILE': '/dev/null',  # SQS is LocalStack only
            'LANDFLOW_HTTP_PORT': str(self.port), 'LANDFLOW_GRPC_PORT': str(self.port + 1),
            'LANDFLOW_REGISTRY_URL': BASE, 'LANDFLOW_ADVERTISE_HOST': '127.0.0.1', 'LANDFLOW_MCP': 'off',
            'LANDFLOW_TRANSPORT_SECRET': self.secret,
            'LANDFLOW_TRANSPORTS': ','.join(['http', 'grpc', *self.kinds]),
        })
        for kind in self.kinds:
            spec, upper = BROKERS[kind], kind.upper()
            env[f'LANDFLOW_{upper}_URL'] = spec['url']
            if spec.get('user'):
                env[f'LANDFLOW_{upper}_USERNAME'], env[f'LANDFLOW_{upper}_PASSWORD'] = spec['user'], spec['password']
            for name, value in spec.get('fields', {}).items():
                env[f'LANDFLOW_{upper}_{name.upper()}'] = 'true' if value is True else str(value)
        return env

    def start(self):
        tsx = ROOT / 'node_modules' / '.bin' / 'tsx'
        tsx = PLUGIN_DIR / 'node_modules' / '.bin' / 'tsx' if (PLUGIN_DIR / 'node_modules' / '.bin' / 'tsx').exists() else tsx
        log = open(self.log_path, 'w')
        self.process = subprocess.Popen([str(tsx), 'src/main.ts'], cwd=PLUGIN_DIR, env=self.env(), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        return self

    def alive(self):
        return self.process is not None and self.process.poll() is None

    def listening(self):
        """Started: the faces are up and the plugin announced itself (a broker face that fails later stops the process)."""
        try:
            announced = 'announced ' in Path(self.log_path).read_text()
        except OSError:
            announced = False
        return self.alive() and announced and reachable(self.port) and reachable(self.port + 1)

    def last_error(self):
        try:
            lines = [json.loads(line) for line in Path(self.log_path).read_text().splitlines() if line.startswith('{')]
            errors = [line.get('msg', '') for line in lines if line.get('level') == 'error']
            return (errors or [''])[-1][:200]
        except Exception:  # noqa: BLE001
            return Path(self.log_path).read_text()[-200:]

    def stop(self):
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.process.wait(timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except Exception:  # noqa: BLE001
                    pass
        self.process = None


def start_plugin(kinds, port, secret, log_dir):
    """Start the plugin with a face for every kind; kinds whose face stops it from starting are dropped (and returned as skipped)."""
    skipped = {}
    candidates = list(kinds)
    while True:
        plugin = BenchPlugin(candidates, port, secret, log_dir / 'plugin.log').start()
        try:
            wait_for('the plugin to listen', lambda: plugin.listening() or not plugin.alive(), 60)
        except RuntimeError:
            pass
        if plugin.listening():
            return plugin, skipped
        reason = plugin.last_error()
        plugin.stop()
        if not candidates:
            raise RuntimeError(f'the bench plugin does not start even with http and grpc only: {reason}')
        # find the culprits one by one
        say(f'  the plugin did not start with {",".join(candidates)} ({reason[:120]}); trying each kind alone')
        good = []
        for kind in candidates:
            alone = BenchPlugin([kind], port, secret, log_dir / f'plugin-{kind}.log').start()
            try:
                wait_for('the plugin to listen', lambda: alone.listening() or not alone.alive(), 45)
            except RuntimeError:
                pass
            if alone.listening():
                good.append(kind)
            else:
                skipped[kind] = f'the plugin cannot start its {kind} face: {alone.last_error()}'
            alone.stop()
            time.sleep(0.3)
        if good == candidates:
            raise RuntimeError('the plugin fails to start with all kinds together but each alone is fine: ' + reason)
        candidates = good


def drop_jetstream_stream():
    """Delete the work-queue stream the JetStream face created for the bench plugin (it would capture the plugin's core NATS subject later)."""
    script = (
        "const { createRequire } = require('node:module'); const r = createRequire(process.cwd() + '/package.json');"
        "(async () => { const { connect } = r('@nats-io/transport-node'); const { jetstreamManager } = r('@nats-io/jetstream');"
        "const nc = await connect({ servers: 'nats://127.0.0.1:54222' });"
        f"try {{ await (await jetstreamManager(nc)).streams.delete('landflow_v1_plugin_{PLUGIN_ID}'); }} catch (e) {{ if (!/not found/i.test(String(e.message))) throw e; }}"
        "await nc.close(); })().catch((e) => { console.error(e.message); process.exit(1); });"
    )
    result = subprocess.run(['node', '-e', script], cwd=ROOT / 'packages' / 'transports', capture_output=True, text=True, timeout=30)
    say('  deleted the JetStream stream of the bench plugin' if result.returncode == 0 else f'  could not delete the JetStream stream: {result.stderr[:150]}')


# ---------------------------------------------------------------------------- calling


class Caller:
    """Webhook calls over persistent connections (one per thread), so connection set-up is not in the numbers."""

    def __init__(self, base):
        parts = urllib.parse.urlsplit(base)
        self.host, self.port = parts.hostname, parts.port or 80
        self.local = threading.local()

    def conn(self):
        connection = getattr(self.local, 'connection', None)
        if connection is None:
            connection = self.local.connection = http.client.HTTPConnection(self.host, self.port, timeout=60)
        return connection

    def post(self, path, body):
        """(ok, milliseconds, response length)."""
        data = json.dumps(body).encode()
        started = time.perf_counter()
        try:
            connection = self.conn()
            connection.request('POST', path, body=data, headers={'content-type': 'application/json'})
            response = connection.getresponse()
            payload = response.read()
            ok = response.status == 200
            length = len(payload)
        except Exception:  # noqa: BLE001
            self.local.connection = None
            ok, length = False, 0
        return ok, (time.perf_counter() - started) * 1000, length


def run_sequential(caller, path, body, calls):
    latencies, errors = [], 0
    for _ in range(calls):
        ok, ms, _ = caller.post(path, body)
        if ok:
            latencies.append(ms)
        else:
            errors += 1
    return summarize(latencies, errors)


def run_concurrent(caller, path, body, concurrency, duration):
    stop = time.time() + duration
    results = []
    lock = threading.Lock()

    def worker():
        mine = []
        while time.time() < stop:
            ok, ms, _ = caller.post(path, body)
            mine.append((ok, ms))
        with lock:
            results.extend(mine)

    started = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for future in [pool.submit(worker) for _ in range(concurrency)]:
            future.result()
    elapsed = time.time() - started
    ok = [ms for good, ms in results if good]
    return dict(summarize(ok, len(results) - len(ok)), per_second=len(ok) / elapsed if elapsed else 0, seconds=elapsed)


# ---------------------------------------------------------------------------- report


def fmt(value, digits=1):
    return '-' if value is None else f'{value:.{digits}f}'


def print_table(rows, baselines):
    head = ['kind', 'size', 'p50 ms', 'p95 ms', 'p99 ms', 'mean ms', 'err', 'calls/s', 'dp50 ms', 'host p50']
    table = [head]
    for row in rows:
        base = baselines.get(row['size'])
        seq, conc = row.get('sequential', {}), row.get('concurrent', {})
        delta = None if (row['kind'] == 'baseline' or not base or seq.get('p50') is None) else seq['p50'] - base['p50']
        errors = seq.get('errors', 0) + conc.get('errors', 0)
        table.append([row['kind'], size_label(row['size']), fmt(seq.get('p50')), fmt(seq.get('p95')), fmt(seq.get('p99')), fmt(seq.get('mean')),
                      str(errors), fmt(conc.get('per_second'), 0) if conc else '-', ('+' + fmt(delta)) if delta is not None and delta >= 0 else fmt(delta),
                      fmt(row.get('host', {}).get('p50Ms'))])
    widths = [max(len(r[i]) for r in table) for i in range(len(head))]
    for index, r in enumerate(table):
        say('  '.join(cell.ljust(widths[i]) if i < 2 else cell.rjust(widths[i]) for i, cell in enumerate(r)))
        if index == 0:
            say('  '.join('-' * w for w in widths))


# ---------------------------------------------------------------------------- main


def main():
    global BASE, ORIGIN
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--base', default='http://localhost:3000', help='the host (default %(default)s)')
    parser.add_argument('--kinds', help='comma list; default: http, grpc and every broker kind the host lists whose local broker answers')
    parser.add_argument('--calls', type=int, default=40, help='sequential calls per kind and size (default %(default)s)')
    parser.add_argument('--warmup', type=int, default=5, help='warm-up calls per kind and size (default %(default)s)')
    parser.add_argument('--concurrency', type=int, default=8, help='callers in the throughput phase (default %(default)s; keep it under the plugin\'s maxConcurrency)')
    parser.add_argument('--duration', type=float, default=5.0, help='seconds of the throughput phase per kind and size; 0 skips it (default %(default)s)')
    parser.add_argument('--sizes', default='100B,256KiB', help='payload sizes (default %(default)s)')
    parser.add_argument('--port', type=int, default=7620, help='the plugin\'s HTTP port; gRPC is the next one (default %(default)s)')
    parser.add_argument('--out', help='write the results as JSON here')
    parser.add_argument('--secret-file', help='a file holding the host\'s LANDFLOW_TRANSPORT_SECRET (used when the variable is not set)')
    parser.add_argument('--discover-timeout', type=float, default=60, help='seconds to wait for the host to see the plugin on a broker (default %(default)s)')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))  # run the cleanup below on kill, too
    BASE = args.base.rstrip('/')
    ORIGIN = BASE
    sizes = [parse_size(s) for s in args.sizes.split(',') if s.strip()]
    secret = read_secret(args.secret_file)

    work = Path(os.environ.get('TMPDIR', '/tmp')) / f'transport-bench-{os.getpid()}'
    work.mkdir(parents=True, exist_ok=True)
    say(f'plugin log: {work}/plugin.log')
    created_workflows, created_connections = [], []  # (id, name)
    connection_ids = {}
    plugin = None
    rows, skipped, notes = [], {}, []
    baselines = {}
    started_at = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    try:
        call('POST', '/api/auth/login', OWNER)
        info = call('GET', '/api/transports')
        host_kinds = {k['kind']: k for k in info['kinds']}
        say(f'host {BASE}: {len(host_kinds)} transport kinds installed')

        wanted = [k.strip() for k in args.kinds.split(',')] if args.kinds else [*DIRECT, *[k for k in BROKERS if k in host_kinds and reachable(BROKERS[k]['port'])]]
        if not args.kinds:
            for kind in BROKERS:
                if kind not in wanted:
                    skipped[kind] = 'not installed on the host' if kind not in host_kinds else f'no broker answering on 127.0.0.1:{BROKERS[kind]["port"]}'
        if 'nats' in wanted and 'jetstream' in wanted:
            # A JetStream work-queue stream on landflow.v1.plugin.<id> captures the core NATS subject of the same plugin and answers its
            # requests with acks, so the two faces cannot be benchmarked in one run.
            if args.kinds:
                sys.exit('nats and jetstream cannot be benchmarked in one run (the JetStream stream captures the core subject): run them separately')
            wanted.remove('jetstream')
            skipped['jetstream'] = 'run it on its own: --kinds http,jetstream (a JetStream stream captures the core NATS subject of the same plugin)'
        kinds = []
        for kind in wanted:
            if kind not in host_kinds:
                skipped[kind] = 'not installed on the host'
            elif kind not in DIRECT and kind not in BROKERS:
                skipped[kind] = 'no local broker known for this kind (see BROKERS in this script)'
            elif kind not in DIRECT and not reachable(BROKERS[kind]['port']):
                skipped[kind] = f'no broker answering on 127.0.0.1:{BROKERS[kind]["port"]}'
            else:
                kinds.append(kind)
        brokers = [k for k in kinds if k not in DIRECT]
        say(f'benchmarking: {", ".join(kinds)}; sizes {", ".join(size_label(s) for s in sizes)}; {args.calls} sequential calls, '
            f'{args.concurrency} callers for {args.duration:g} s')

        # leftovers of an interrupted run
        for connection in call('GET', '/api/transports/connections')['connections']:
            if connection['name'].startswith(f'{PREFIX} ') and connection['source'] == 'database':
                call('DELETE', f'/api/transports/connections/{connection["id"]}')
        for wf in call('GET', '/api/workflows')['workflows']:
            if wf['name'].startswith(f'{PREFIX} '):
                call('POST', f'/api/workflows/{wf["id"]}/unpublish', {})
                call('DELETE', f'/api/workflows/{wf["id"]}')

        for kind in brokers:
            spec = BROKERS[kind]
            created = call('POST', '/api/transports/connections', {
                'name': f'{PREFIX} {kind}', 'kind': kind, 'config': {'url': spec['url'], **spec.get('fields', {})},
                **({'secrets': {'username': spec['user'], 'password': spec['password']}} if spec.get('user') else {})})
            created_connections.append((created['id'], f'{PREFIX} {kind}'))
            connection_ids[kind] = created['id']

        plugin, dropped = start_plugin(brokers, args.port, secret, work)
        for kind, why in dropped.items():
            skipped[kind] = why
            kinds.remove(kind)
        say(f'bench plugin up on :{args.port} (http) and :{args.port + 1} (grpc), faces: {", ".join(["http", "grpc", *[k for k in brokers if k not in dropped]])}')
        wait_for('the host to list the plugin', lambda: (plugin_view() or {}).get('status') == 'online', 60)

        tag = f'{SUFFIX}-{os.getpid()}'
        base_path, echo_path = f't4d-baseline-{tag}', f't4d-echo-{tag}'
        created_workflows.append((publish_workflow(f'{PREFIX} baseline', base_path, node('Set', 'core.set', {'mode': 'manual', 'includeOtherFields': True, 'fields': {'values': [
            {'name': 'ok', 'type': 'string', 'value': 'yes'}]}})), f'{PREFIX} baseline'))
        created_workflows.append((publish_workflow(f'{PREFIX} echo', echo_path, node('Echo', f'{PLUGIN_ID}.echo')), f'{PREFIX} echo'))
        caller = Caller(BASE)
        order = ['baseline', *kinds]

        for kind in order:
            if kind != 'baseline':
                caps = host_kinds[kind].get('capabilities') or {}
                if kind in brokers:
                    try:
                        # The plugin announces on the broker once at start; a host that was not listening yet (or a consumer group that was
                        # still joining) misses it, so register the brokered endpoint by hand if discovery does not happen.
                        attempts = {'next': time.time() + 10}

                        def discovered():
                            if (kind_summary(kind) or {}).get('online'):
                                return True
                            if time.time() >= attempts['next']:
                                attempts['next'] = time.time() + 10
                                call('POST', '/api/plugins', {'endpoint': f'{kind}://{connection_ids[kind]}/{PLUGIN_ID}'}, raw=True)
                            return False
                        wait_for(f'the host to see the plugin on {kind}', discovered, args.discover_timeout, 1.0)
                    except RuntimeError as error:
                        skipped[kind] = f'the host did not discover the plugin on {kind}: {error}'
                        say(f'  {kind}: skipped ({skipped[kind]})')
                        continue
                call('PATCH', f'/api/plugins/{PLUGIN_ID}', {'policy': {'mode': 'pinned', 'pinned': kind, 'objective': 'balanced'}})
            path = f'/api/webhook/{base_path if kind == "baseline" else echo_path}'
            for size in sizes:
                label = f'{kind} {size_label(size)}'
                cap = (host_kinds.get(kind, {}).get('capabilities') or {}).get('maxMessageBytes')
                if kind != 'baseline' and cap and size * 1.4 + 16 * 1024 > cap:
                    skipped[f'{kind} @ {size_label(size)}'] = f'message cap {size_label(int(cap))} is below the payload plus envelope'
                    say(f'  {label}: skipped (cap {int(cap)} B)')
                    continue
                body = {'payload': 'x' * size}
                warm = [caller.post(path, body) for _ in range(max(1, args.warmup))]
                if not warm[-1][0] or warm[-1][2] < size:
                    skipped[f'{kind} @ {size_label(size)}'] = 'warm-up call failed' if not warm[-1][0] else 'warm-up reply was shorter than the payload'
                    say(f'  {label}: skipped ({skipped[f"{kind} @ {size_label(size)}"]})')
                    continue
                before = (kind_summary(kind) or {}).get('auto', {}).get('calls', 0) if kind != 'baseline' else 0
                row = dict(kind=kind, size=size, sequential=run_sequential(caller, path, body, args.calls))
                if kind != 'baseline':
                    auto = (kind_summary(kind) or {}).get('auto') or {}
                    row['host'] = {k: auto.get(k) for k in ('p50Ms', 'p95Ms', 'calls', 'errorRate')}
                    gained = auto.get('calls', 0) - before
                    row['hostCallsDelta'] = gained
                    if gained < row['sequential']['n'] * 0.9:
                        notes.append(f'{label}: the host counted {gained} calls on {kind} for {row["sequential"]["n"]} successful ones; they may have gone over another transport')
                if args.duration > 0:
                    row['concurrent'] = dict(run_concurrent(caller, path, body, args.concurrency, args.duration), concurrency=args.concurrency)
                rows.append(row)
                if kind == 'baseline':
                    baselines[size] = row['sequential']
                seq = row['sequential']
                say(f'  {label}: p50 {fmt(seq.get("p50"))} ms, p95 {fmt(seq.get("p95"))} ms, errors {seq["errors"]}'
                    + (f', {row["concurrent"]["per_second"]:.0f} calls/s' if 'concurrent' in row else ''))

        say()
        print_table(rows, baselines)
        say()
        say('dp50 = p50 minus the baseline p50 at the same size (webhook -> Set, core nodes only): what the plugin hop adds. host p50 = the')
        say('host\'s own Plugins-page latency for the kind. calls/s is at the given concurrency; err counts both phases.')
        for kind, why in skipped.items():
            say(f'skipped {kind}: {why}')
        for note in notes:
            say(f'note: {note}')
        result = dict(startedAt=started_at, host=BASE, calls=args.calls, concurrency=args.concurrency, duration=args.duration, sizes=sizes,
                      rows=rows, baselines={str(k): v for k, v in baselines.items()}, skipped=skipped, notes=notes)
        if args.out:
            Path(args.out).write_text(json.dumps(result, indent=2))
            say(f'wrote {args.out}')
    finally:
        say('cleaning up')
        if plugin:
            plugin.stop()
        if 'jetstream' in kinds:
            drop_jetstream_stream()
        try:
            if plugin_view():
                call('PATCH', f'/api/plugins/{PLUGIN_ID}', {'policy': {'mode': 'auto', 'objective': 'balanced'}})
        except Exception as error:  # noqa: BLE001
            say(f'  could not reset the policy: {error}')
        for workflow_id, name in created_workflows:
            try:
                current = call('GET', f'/api/workflows/{workflow_id}')['workflow']
                if current['name'] == name and name.startswith(f'{PREFIX} '):
                    call('POST', f'/api/workflows/{workflow_id}/unpublish', {})
                    call('DELETE', f'/api/workflows/{workflow_id}')
            except Exception as error:  # noqa: BLE001
                say(f'  could not delete workflow {name}: {error}')
        for connection_id, name in created_connections:
            try:
                listed = [c for c in call('GET', '/api/transports/connections')['connections'] if c['id'] == connection_id]
                if listed and listed[0]['name'] == name and name.startswith(f'{PREFIX} '):
                    call('DELETE', f'/api/transports/connections/{connection_id}')
            except Exception as error:  # noqa: BLE001
                say(f'  could not delete connection {name}: {error}')
        try:
            if plugin_view():
                status, text = call('DELETE', f'/api/plugins/{PLUGIN_ID}', raw=True)
                say(f'  removed the {PLUGIN_ID} plugin from the host' if status == 200 else f'  {PLUGIN_ID} stays listed (offline): HTTP {status} {text[:100]}')
        except Exception as error:  # noqa: BLE001
            say(f'  could not remove the plugin: {error}')


if __name__ == '__main__':
    main()
