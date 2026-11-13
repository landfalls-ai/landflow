#!/usr/bin/env python3
"""
End-to-end check of the queue-mode stack (deploy/compose.queue.yml) through its published ports:

  load    webhook calls through the load balancer run on both workers (and use a plugin the mains registered);
  worker  a worker killed mid-run: another worker continues the run from its last checkpoint;
  leader  the leader main killed: the other main takes over and the schedule keeps firing.

  python3 deploy/scripts/queue-e2e.py            # all three, about three minutes
  python3 deploy/scripts/queue-e2e.py worker     # just one

Each check creates and publishes its own "Queue E2E" workflow (the schedule is unpublished at the end) and starts
the containers it killed again. Python 3 standard library only; uses `docker` for kill / start.
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from pathlib import Path

LB = 'http://127.0.0.1:53080'
MAINS = {'main-1': 'http://127.0.0.1:53081', 'main-2': 'http://127.0.0.1:53082'}
WORKERS = {'worker-1': 'http://127.0.0.1:55691', 'worker-2': 'http://127.0.0.1:55692'}
COMPOSE = ['docker', 'compose', '-f', str(Path(__file__).resolve().parent.parent / 'compose.queue.yml')]
OWNER = {'email': 'owner@landflow.test', 'password': 'landflow-dev-only'}
SUFFIX = time.strftime('%H%M%S')

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
failures = 0


def say(message):
    print(f'  {message}', flush=True)


def check(ok, message):
    global failures
    print(f"  \033[{'32mok  ' if ok else '31mFAIL'}\033[0m  {message}", flush=True)
    if not ok:
        failures += 1


def call(method, path, body=None, base=LB, timeout=60, raw=False):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(base + path, data=data, method=method, headers={'content-type': 'application/json'} if data else {})
    try:
        with opener.open(request, timeout=timeout) as response:
            text = response.read().decode()
            return (response.status, text) if raw else json.loads(text or 'null')
    except urllib.error.HTTPError as error:
        if raw:
            return error.code, error.read().decode()
        raise RuntimeError(f'{method} {path}: HTTP {error.code} {error.read().decode()[:300]}') from None


def health(url):
    try:
        with urllib.request.urlopen(url + '/healthz', timeout=3) as response:
            return json.loads(response.read())
    except Exception:
        return None


def wait_for(what, check_fn, timeout, every=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check_fn()
        if value:
            return value
        time.sleep(every)
    raise RuntimeError(f'timed out after {timeout} s waiting for {what}')


def node(name, type_, parameters=None, version=1, x=0):
    return {'id': name, 'name': name, 'type': type_, 'typeVersion': version, 'position': [x, 0], 'parameters': parameters or {}}


def workflow(name, nodes, edges):
    """Create and publish a workflow; returns its id."""
    for index, n in enumerate(nodes):
        n['position'] = [index * 240, 0]
    connections = [{'id': f'e{i}', 'type': 'main', 'source': s, 'target': t, 'sourceIndex': 0, 'targetIndex': 0} for i, (s, t) in enumerate(edges)]
    created = call('POST', '/api/workflows', {'name': f'Queue E2E: {name} {SUFFIX}', 'nodes': nodes, 'connections': connections})
    workflow_id = created['workflow']['id']
    call('POST', f'/api/workflows/{workflow_id}/publish', {})
    return workflow_id


def set_node(name, field, value):
    return node(name, 'core.set', {'mode': 'manual', 'includeOtherFields': True, 'fields': {'values': [{'name': field, 'type': 'string', 'value': value}]}})


def compose(*args):
    subprocess.run([*COMPOSE, *args], check=True, capture_output=True)


def container(service):
    return f'landflow-queue-{service}-1'


def start_again(service):
    compose('start', service)
    if service in WORKERS:
        wait_for(f'{service} healthy', lambda: health(WORKERS[service]), 90)
    else:
        wait_for(f'{service} up', lambda: _reachable(MAINS[service]), 120)


def _reachable(base):
    """Ready, not just answering: /api/health/ready answers 503 (an HTTPError here) until the boot is done."""
    try:
        urllib.request.urlopen(base + '/api/health/ready', timeout=3).read()
        return True
    except Exception:
        return False


def parse(stamp):
    """An ISO timestamp (UTC, with milliseconds) as epoch seconds."""
    return time.mktime(time.strptime(stamp[:19], '%Y-%m-%dT%H:%M:%S')) + float('0' + stamp[19:].rstrip('Z'))


def processed():
    return {name: (health(url) or {}).get('processed', 0) for name, url in WORKERS.items()}


# ---------------------------------------------------------------------------


def check_load(calls=40):
    print('load: webhook calls spread over the workers')
    path = f'queue-e2e-load-{SUFFIX}'
    workflow('load', [
        node('Webhook', 'core.webhook', {'path': path, 'method': 'POST', 'respond': 'lastNode'}),
        set_node('Text', 'text', '{{ $json.body.text }}'),
        node('Slugify', 'text-toolkit.slugify', {'field': 'text', 'outputField': 'slug'}),
    ], [('Webhook', 'Text'), ('Text', 'Slugify')])
    before = processed()

    def one(i):
        status, text = call('POST', f'/api/webhook/{path}', {'text': f'Hello Queue {i}'}, raw=True)
        return status, (json.loads(text) if status == 200 else text)

    started = time.time()
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(one, range(calls)))
    elapsed = time.time() - started
    good = [r for i, r in enumerate(results) if r[0] == 200 and isinstance(r[1], dict) and r[1].get('slug') == f'hello-queue-{i}']
    check(len(good) == calls, f'{len(good)}/{calls} calls answered with their slug in {elapsed:.1f} s')
    time.sleep(1)
    after = processed()
    delta = {name: after[name] - before.get(name, 0) for name in WORKERS}
    check(all(d > 0 for d in delta.values()) and sum(delta.values()) >= calls, f'jobs per worker: {delta}')


def check_worker_kill():
    print('worker: a worker killed mid-run, another continues the run from its checkpoint')
    path = f'queue-e2e-long-{SUFFIX}'
    workflow('worker kill', [
        node('Webhook', 'core.webhook', {'path': path, 'method': 'POST', 'respond': 'immediately'}),
        set_node('Before', 'before', 'done'),
        node('Wait', 'core.wait', {'resume': 'timeInterval', 'amount': 20, 'unit': 'seconds'}, version=2),
        set_node('After', 'after', 'done'),
    ], [('Webhook', 'Before'), ('Before', 'Wait'), ('Wait', 'After')])
    status, text = call('POST', f'/api/webhook/{path}', {}, raw=True)
    check(status == 202, f'webhook answered at once: HTTP {status} {text[:120]}')
    execution_id = json.loads(text)['executionId']
    busy = wait_for('a worker to take the run', lambda: next((name for name, url in WORKERS.items() if (health(url) or {}).get('active')), None), 30, 0.25)
    other = next(name for name in WORKERS if name != busy)
    other_before = processed()[other]
    time.sleep(3)  # into the Wait, after the checkpoint that follows Before
    killed_at = time.time()
    subprocess.run(['docker', 'kill', container(busy)], check=True, capture_output=True)
    say(f'{execution_id} ran on {busy}: killed it (SIGKILL)')
    record = wait_for('the run to finish on the other worker', lambda: (lambda e: e if e['status'] not in ('running', 'queued') else None)(call('GET', f'/api/executions/{execution_id}')['execution']), 180, 2)
    took = time.time() - killed_at
    check(record['status'] == 'success', f"finished {record['status']} {took:.0f} s after the kill")
    check(bool(record.get('resumedAfterRestart')), f"continued from checkpoint {record.get('resumedAfterRestart', {}).get('stepId')}, nodes {record.get('executionOrder')}")
    check(processed()[other] > other_before, f'{other} took the job over')
    start_again(busy)
    say(f'{busy} started again')


def check_leader_kill():
    print('leader: the leader main killed, the other takes over and the schedule keeps firing')
    workflow_id = workflow('schedule', [
        node('Every 5 s', 'core.schedule', {'rule': {'interval': [{'field': 'seconds', 'secondsInterval': 5}]}}),
        set_node('Tick', 'tick', '{{ $now }}'),
    ], [('Every 5 s', 'Tick')])
    try:
        status = call('GET', '/api/settings/workers')
        leader = status['leader']['holder']
        token = status['leader']['token']
        survivor = next(name for name in MAINS if name != leader)

        def runs():
            listed = call('GET', f'/api/executions?workflowId={workflow_id}&limit=200', base=MAINS[survivor])['executions']
            return sorted(e['startedAt'] for e in listed)

        wait_for('two scheduled runs', lambda: len(runs()) >= 2, 40)
        killed_at = time.time()
        subprocess.run(['docker', 'kill', container(leader)], check=True, capture_output=True)
        say(f'{leader} led (fencing token {token}): killed it (SIGKILL)')
        new_status = wait_for(f'{survivor} to lead', lambda: (lambda s: s if s['leader'].get('holder') == survivor else None)(call('GET', '/api/settings/workers', base=MAINS[survivor])), 60, 0.5)
        failover = time.time() - killed_at
        check(failover < 30, f"{survivor} leads after {failover:.1f} s (fencing token {new_status['leader']['token']})")
        stamp = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(killed_at)) + f'.{int(killed_at % 1 * 1000):03d}Z'
        before = [t for t in runs() if t <= stamp]
        after = wait_for('two scheduled runs after the failover', lambda: (lambda r: r if len(r) >= 2 else None)([t for t in runs() if t > stamp]), 60)
        gap = (parse(after[0]) - parse(before[-1])) if before else 0
        check(gap < 30, f'the schedule kept firing: last run before the kill {before[-1][11:23] if before else "-"}, then {", ".join(t[11:23] for t in after)} (gap {gap:.1f} s)')
    finally:
        call('POST', f'/api/workflows/{workflow_id}/unpublish', {})
    start_again(leader)
    follower = call('GET', '/api/settings/workers', base=MAINS[leader])
    check(follower['self'].get('leader') is False, f"{leader} is back as a follower ({follower['leader'].get('holder')} leads)")


def main():
    which = sys.argv[1:] or ['load', 'worker', 'leader']
    call('POST', '/api/auth/login', OWNER)
    status = call('GET', '/api/settings/workers')
    say(f"queue mode: {len(status.get('instances', []))} processes, {status['leader'].get('holder')} leads")
    checks = {'load': check_load, 'worker': check_worker_kill, 'leader': check_leader_kill}
    for name in which:
        try:
            checks[name]()
        except Exception as error:  # noqa: BLE001 - report and go on
            check(False, f'{name}: {error}')
    print('passed' if not failures else f'{failures} failed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
