#!/usr/bin/env python3
"""
Write the Azure Service Bus emulator's entity file (deploy/infra/servicebus/Config.json).

The emulator has no management API: every queue, topic and subscription the Landflow driver uses must be in this file before the
emulator starts. The driver (packages/transports/src/drivers/servicebus, sdks/go/transport/servicebus) uses exactly:

  landflow.v1.plugin.<pluginId>   one queue per plugin (its request channel; the bundled plugins below, plus any id you pass)
  landflow.v1.instance            one session-enabled queue; the session id is the instance channel's name
  landflow.v1.reply               one session-enabled queue; the session id is the host process's reply channel
  landflow.v1.broadcast           one topic, with 16 session-enabled subscriptions bc-00 .. bc-15 (registry and control channels)

so only the per-plugin queues depend on your setup. (A different channel prefix changes the `landflow` part: --prefix.)
Real Azure namespaces need none of this: the drivers create missing entities through the administration API when the key has
Manage rights (createEntities, on by default outside the emulator).

  python3 deploy/scripts/servicebus-config.py                              # the bundled plugins + the conformance queues
  python3 deploy/scripts/servicebus-config.py --plugin my-plugin --plugin other --plugin transport-bench
  python3 deploy/scripts/servicebus-config.py --queue landflow.v1.plugin.foo       # a queue by its full name
  python3 deploy/scripts/servicebus-config.py --check                      # exit 1 if Config.json differs from what this would write
  python3 deploy/scripts/servicebus-config.py --from-host http://localhost:3000 --cookie-file cookies.txt   # every plugin the host knows

Then recreate the emulator (it reads the file at start; the SQL sidecar can stay):
  COMPOSE_BAKE=false docker compose -p landflow-infra -f deploy/compose.infra.yml --profile servicebus up -d --force-recreate --no-deps servicebus

Python 3 standard library only.
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / 'infra' / 'servicebus' / 'Config.json'
# The plugin ids of the bundled plugins (plugins/*, plus the host's `core`) and the benchmark plugin (deploy/scripts/transport-bench.py).
BUNDLED = ['core', 'text-toolkit', 'py-insights', 'go-crypto', 'messaging', 'productivity', 'google', 'databases', 'transport-bench']
# The driver conformance suites map their random channel names onto these fixed queues (servicebus.conformance.test.ts, conformance_test.go).
CONFORMANCE = ['declare', 'roundtrip', 'headers', 'share', 'nack', 'death', 'nobody', 'buffer', 'ttl', 'prefetch', 'order', 'stats', 'big']
CORE_CONFORMANCE_QUEUE = 'lfcore.v1.plugin'
BROADCAST_SUBSCRIPTIONS = 16


def queue(name, lock='PT1M', deliveries=10, session=False, ttl='PT5M'):
    return {
        'Name': name,
        'Properties': {
            'DeadLetteringOnMessageExpiration': False,
            'DefaultMessageTimeToLive': ttl,
            'DuplicateDetectionHistoryTimeWindow': 'PT20S',
            'ForwardDeadLetteredMessagesTo': '',
            'ForwardTo': '',
            'LockDuration': lock,
            'MaxDeliveryCount': deliveries,
            'RequiresDuplicateDetection': False,
            'RequiresSession': session,
        },
    }


def build(prefix, namespace, plugins, queues, conformance, subscriptions):
    base = f'{prefix}.v1'
    names = []
    for item in [f'{base}.plugin.{p}' for p in plugins] + list(queues):
        if item not in names:
            names.append(item)
    entities = [queue(n, deliveries=3) for n in names]
    entities.append(queue(f'{base}.reply', lock='PT30S', session=True))
    entities.append(queue(f'{base}.instance', session=True))
    if conformance:
        entities += [queue(f'lfconf.{n}') for n in CONFORMANCE] + [queue(CORE_CONFORMANCE_QUEUE)]
    sub = lambda n: {
        'Name': n,
        'Properties': {
            'DeadLetteringOnMessageExpiration': False,
            'DefaultMessageTimeToLive': 'PT1M',
            'LockDuration': 'PT1M',
            'MaxDeliveryCount': 10,
            'ForwardDeadLetteredMessagesTo': '',
            'ForwardTo': '',
            'RequiresSession': True,
        },
    }
    topic = {
        'Name': f'{base}.broadcast',
        'Properties': {'DefaultMessageTimeToLive': 'PT1M', 'DuplicateDetectionHistoryTimeWindow': 'PT20S', 'RequiresDuplicateDetection': False},
        'Subscriptions': [sub(f'bc-{i:02d}') for i in range(subscriptions)],
    }
    return {'UserConfig': {'Namespaces': [{'Name': namespace, 'Queues': entities, 'Topics': [topic]}], 'Logging': {'Type': 'Console'}}}


def plugin_ids_from_host(url, cookie_file):
    request = urllib.request.Request(url.rstrip('/') + '/api/plugins')
    if cookie_file:
        request.add_header('Cookie', '; '.join(line.split('\t')[5] + '=' + line.split('\t')[6].strip() for line in Path(cookie_file).read_text().splitlines()
                                              if line.strip() and (not line.startswith('#') or line.startswith('#HttpOnly_')) and len(line.split('\t')) >= 7))
    with urllib.request.urlopen(request, timeout=10) as response:
        data = json.load(response)
    return [p['id'] for p in (data if isinstance(data, list) else data.get('plugins', []))]


def main():
    ap = argparse.ArgumentParser(description='Write the Service Bus emulator entity file for the bundled plugins plus the ids you pass.')
    ap.add_argument('--plugin', action='append', default=[], metavar='ID', help='add the request queue of this plugin id (repeatable)')
    ap.add_argument('--queue', action='append', default=[], metavar='NAME', help='add a queue by its full name (repeatable)')
    ap.add_argument('--from-host', metavar='URL', help='add every plugin id the host at URL lists (GET /api/plugins)')
    ap.add_argument('--cookie-file', help='curl cookie file for --from-host (a signed-in session)')
    ap.add_argument('--no-bundled', action='store_true', help='leave out the bundled plugins (' + ', '.join(BUNDLED) + ')')
    ap.add_argument('--no-conformance', action='store_true', help='leave out the fixed queues the driver conformance suites use (lfconf.*, lfcore.v1.plugin)')
    ap.add_argument('--prefix', default='landflow', help='the channel prefix (default landflow)')
    ap.add_argument('--namespace', default='sbemulatorns', help='the emulator namespace (default sbemulatorns; the connection string does not name it)')
    ap.add_argument('--subscriptions', type=int, default=BROADCAST_SUBSCRIPTIONS, help='broadcast subscriptions, bc-00… (default 16: the driver\'s default pool)')
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT, help='where to write (default deploy/infra/servicebus/Config.json); - for stdout')
    ap.add_argument('--check', action='store_true', help='write nothing; exit 1 if --out differs')
    args = ap.parse_args()
    plugins = ([] if args.no_bundled else list(BUNDLED)) + args.plugin
    if args.from_host:
        plugins += plugin_ids_from_host(args.from_host, args.cookie_file)
    doc = build(args.prefix, args.namespace, plugins, args.queue, not args.no_conformance, args.subscriptions)
    text = json.dumps(doc, indent=2) + '\n'
    if str(args.out) == '-':
        sys.stdout.write(text)
        return 0
    if args.check:
        same = args.out.exists() and args.out.read_text() == text
        print(f'{args.out}: {"up to date" if same else "differs (run without --check)"}')
        return 0 if same else 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text)
    queues = [q['Name'] for q in doc['UserConfig']['Namespaces'][0]['Queues']]
    print(f'wrote {args.out}: {len(queues)} queues, topic {args.prefix}.v1.broadcast with {args.subscriptions} subscriptions')
    print('request queues: ' + ', '.join(q for q in queues if q.startswith(f'{args.prefix}.v1.plugin.')))
    print('Recreate the emulator to load it (see the header of this script).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
