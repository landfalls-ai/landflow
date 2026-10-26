/**
 * Kubernetes plugin discovery (lib/server/plugins/kubernetes.ts) against a fake watch stream: plugins come and go with
 * their Services, go offline when no pod is ready and come back, re-pull the manifest when the ready pods change,
 * survive watch errors (backoff, 410 → re-list) and missed events (resync), stay in their namespaces, and read their
 * ports from annotations or named ports. The registry part runs for real against SDK plugin servers: discovered
 * endpoints carry their origin and must prove LANDFLOW_REGISTRY_SECRET when it is set (docs/protocol.md §13).
 *
 * Spreading over pods: the ready pods' addresses from the EndpointSlices (by port name, IPv6 too) go to the registry,
 * which sends each call to the pod with the fewest calls in flight while the manifest is pulled once, through the
 * Service; unready pods leave, new ones join. LANDFLOW_K8S_NAMESPACES=* lists and watches every namespace at once.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin, REGISTRY_PROOF_HEADER, registryProof, type IPlugin } from '@landflow/sdk';
import type { grpc } from '@landflow/protocol/grpc';
import type { EndpointOrigin, PluginStatus } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });
Object.assign(process.env, { LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false' });

const { KubernetesDiscovery, parseNamespaces, podEndpoints, registryTarget, serviceEndpoints } = await import('@/lib/server/plugins/kubernetes');
const { PooledPluginClient } = await import('@/lib/server/plugins/clients');
type PluginClient = import('@/lib/server/plugins/clients').PluginClient;
type KubeApi = import('@/lib/server/plugins/kubernetes').KubeApi;
type KubeKind = import('@/lib/server/plugins/kubernetes').KubeKind;
type KubeObject = import('@/lib/server/plugins/kubernetes').KubeObject;
type DiscoveryTarget = import('@/lib/server/plugins/kubernetes').DiscoveryTarget;
const { registry } = await import('@/lib/server/plugins/registry');
const { createFetchHandler } = await import('@landflow/sdk/http');
const { serveGrpc } = await import('@landflow/sdk/grpc');

// ---------------------------------------------------------------------------
// Fakes: the Kubernetes API (list + a watch stream we drive) and the registry
// ---------------------------------------------------------------------------

interface FakeWatch {
  kind: KubeKind;
  namespace: string;
  resourceVersion: string;
  emit(type: string, object: object): void;
  end(error?: Error): void;
  ended: boolean;
}

class FakeKube implements KubeApi {
  readonly store = new Map<string, Map<string, KubeObject>>();
  readonly lists: Array<{ kind: KubeKind; namespace: string; labelSelector: string }> = [];
  readonly watches: FakeWatch[] = [];
  listFailures = 0;
  /** Which kind's lists fail while `listFailures` lasts (default: any). */
  failingKind?: KubeKind;
  rv = 100;

  private bucket(kind: KubeKind, namespace: string) {
    const key = `${kind}/${namespace}`;
    if (!this.store.has(key)) this.store.set(key, new Map());
    return this.store.get(key)!;
  }

  async list(kind: KubeKind, namespace: string, labelSelector: string) {
    this.lists.push({ kind, namespace, labelSelector });
    if (this.listFailures > 0 && (!this.failingKind || this.failingKind === kind)) {
      this.listFailures--;
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    // `*`: every namespace's objects of that kind (a cluster-wide list).
    const items = namespace === '*' ? [...this.store.entries()].filter(([key]) => key.startsWith(`${kind}/`)).flatMap(([, bucket]) => [...bucket.values()]) : [...this.bucket(kind, namespace).values()];
    return { resourceVersion: String(this.rv), items: structuredClone(items) };
  }

  watch(kind: KubeKind, namespace: string, _selector: string, resourceVersion: string, onEvent: (event: { type: string; object: KubeObject }) => void, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const watch: FakeWatch = {
        kind,
        namespace,
        resourceVersion,
        ended: false,
        emit: (type, object) => !watch.ended && onEvent({ type, object: structuredClone(object) as KubeObject }),
        end: (error) => {
          watch.ended = true;
          if (error) reject(error);
          else resolve();
        },
      };
      signal.addEventListener('abort', () => watch.end(), { once: true });
      this.watches.push(watch);
    });
  }

  current(kind: KubeKind, namespace: string) {
    return this.watches.filter((w) => w.kind === kind && w.namespace === namespace && !w.ended).at(-1);
  }

  /** Store and announce on the open watch (unless `silent`: an event the watch missed). */
  put(kind: KubeKind, namespace: string, object: KubeObject, silent = false) {
    const bucket = this.bucket(kind, namespace);
    const name = object.metadata!.name!;
    const type = bucket.has(name) ? 'MODIFIED' : 'ADDED';
    object.metadata!.resourceVersion = String(++this.rv);
    bucket.set(name, object);
    if (!silent) for (const watch of [this.current(kind, namespace), this.current(kind, '*')]) watch?.emit(type, object);
  }

  delete(kind: KubeKind, namespace: string, name: string, silent = false) {
    const bucket = this.bucket(kind, namespace);
    const object = bucket.get(name);
    bucket.delete(name);
    const deleted = object && { ...object, metadata: { ...object.metadata, resourceVersion: String(++this.rv) } };
    if (deleted && !silent) for (const watch of [this.current(kind, namespace), this.current(kind, '*')]) watch?.emit('DELETED', deleted);
  }
}

class FakeTarget implements DiscoveryTarget {
  readonly endpoints = new Map<string, { status: PluginStatus; origin: EndpointOrigin; adds: number }>();
  readonly calls: string[] = [];
  readonly failing = new Set<string>();

  async add(endpoint: string, origin: EndpointOrigin) {
    this.calls.push(`add ${endpoint}`);
    if (this.failing.has(endpoint)) throw new Error('connection refused');
    this.endpoints.set(endpoint, { status: 'online', origin, adds: (this.endpoints.get(endpoint)?.adds ?? 0) + 1 });
  }
  offline(endpoint: string) {
    this.calls.push(`offline ${endpoint}`);
    const entry = this.endpoints.get(endpoint);
    if (entry) entry.status = 'offline';
  }
  remove(endpoint: string) {
    this.calls.push(`remove ${endpoint}`);
    this.endpoints.delete(endpoint);
  }
  status(endpoint: string) {
    return this.endpoints.get(endpoint)?.status;
  }
  /** The pods each endpoint's calls go to, as discovery last set them. */
  readonly pods = new Map<string, string[]>();
  backends(endpoint: string, pods: string[]) {
    this.calls.push(`backends ${endpoint} ${pods.length}`);
    if (pods.length) this.pods.set(endpoint, pods);
    else this.pods.delete(endpoint);
  }
}

const service = (name: string, namespace: string, extra: { ports?: Array<{ name?: string; port: number; appProtocol?: string }>; annotations?: Record<string, string>; clusterIP?: string } = {}): KubeObject => ({
  metadata: { name, namespace, labels: { 'landflow.dev/plugin': 'true' }, ...(extra.annotations && { annotations: extra.annotations }) },
  spec: { clusterIP: extra.clusterIP ?? '10.96.0.7', ports: extra.ports ?? [{ name: 'grpc', port: 7203 }, { name: 'http', port: 7103 }] },
});

/** An EndpointSlice of `serviceName` with one endpoint per entry of `ready` (pod uids `<pod>-<i>`, addresses 10.1.0.<i + 1>). */
const slice = (serviceName: string, namespace: string, ready: boolean[], pod = 'pod'): KubeObject => ({
  metadata: { name: `${serviceName}-x1`, namespace, labels: { 'kubernetes.io/service-name': serviceName, 'landflow.dev/plugin': 'true' } },
  ports: [{ name: 'grpc', port: 7203 }, { name: 'http', port: 7103 }],
  endpoints: ready.map((r, i) => ({ addresses: [`10.1.0.${i + 1}`], conditions: { ready: r }, targetRef: { uid: `${pod}-${i}` } })),
});

const grpcOf = (name: string, namespace: string, port = 7203) => `grpc://${name}.${namespace}.svc.cluster.local:${port}`;

const running: Array<InstanceType<typeof KubernetesDiscovery>> = [];
function discover(namespaces: string[], extra: { kube?: FakeKube; target?: FakeTarget; sleeps?: number[]; spread?: 'pods' | 'service' } = {}) {
  const kube = extra.kube ?? new FakeKube();
  const target = extra.target ?? new FakeTarget();
  const sleeps = extra.sleeps ?? [];
  const notes: string[] = [];
  const discovery = new KubernetesDiscovery({
    api: kube,
    namespaces,
    target,
    ...(extra.spread && { spread: extra.spread }),
    debounceMs: 0,
    resyncMs: 0,
    backoff: { initialMs: 10, maxMs: 40, jitter: false },
    notify: (message) => notes.push(message),
    // Record the delay but wait only a moment, so backoff is checked without slowing the tests down.
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(ms, 5));
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
      });
    },
  });
  running.push(discovery);
  discovery.start();
  return { kube, target, sleeps, notes, discovery };
}

/** Wait until every kind in every namespace has an open watch. */
const watching = (kube: FakeKube, namespaces: string[]) =>
  vi.waitFor(() => {
    for (const namespace of namespaces) for (const kind of ['services', 'endpointslices'] as const) expect(kube.current(kind, namespace)).toBeDefined();
  });

afterEach(() => {
  for (const discovery of running.splice(0)) discovery.stop();
});

// ---------------------------------------------------------------------------
// Annotation and port parsing
// ---------------------------------------------------------------------------

describe('serviceEndpoints', () => {
  it('reads the gRPC port from a named port, the annotation (number or name) or appProtocol', () => {
    expect(serviceEndpoints(service('go-crypto', 'lf'))).toEqual({ endpoints: ['grpc://go-crypto.lf.svc.cluster.local:7203'] });
    const ports = [{ name: 'rpc', port: 9000 }, { name: 'web', port: 8080 }];
    expect(serviceEndpoints(service('p', 'lf', { ports, annotations: { 'landflow.dev/grpc-port': '9000' } })).endpoints).toEqual(['grpc://p.lf.svc.cluster.local:9000']);
    expect(serviceEndpoints(service('p', 'lf', { ports, annotations: { 'landflow.dev/grpc-port': 'rpc' } })).endpoints).toEqual(['grpc://p.lf.svc.cluster.local:9000']);
    expect(serviceEndpoints(service('p', 'lf', { ports: [{ name: 'x', port: 50051, appProtocol: 'kubernetes.io/h2c' }] })).endpoints).toEqual(['grpc://p.lf.svc.cluster.local:50051']);
    // The annotation wins over a port named grpc.
    expect(serviceEndpoints(service('p', 'lf', { ports: [{ name: 'grpc', port: 1 }, { name: 'alt', port: 2 }], annotations: { 'landflow.dev/grpc-port': 'alt' } })).endpoints).toEqual(['grpc://p.lf.svc.cluster.local:2']);
  });

  it('adds HTTP with landflow.dev/http-port, and explains Services it cannot use', () => {
    expect(serviceEndpoints(service('p', 'lf', { annotations: { 'landflow.dev/http-port': 'http' } })).endpoints).toEqual(['grpc://p.lf.svc.cluster.local:7203', 'http://p.lf.svc.cluster.local:7103']);
    expect(serviceEndpoints(service('p', 'lf', { ports: [{ name: 'web', port: 80 }], annotations: { 'landflow.dev/http-port': '80' } })).endpoints).toEqual(['http://p.lf.svc.cluster.local:80']);
    expect(serviceEndpoints(service('p', 'lf', { annotations: { 'landflow.dev/grpc-port': '7999' } }))).toEqual({ endpoints: [], error: 'landflow.dev/grpc-port: "7999" is not a port of Service lf/p' });
    expect(serviceEndpoints(service('p', 'lf', { annotations: { 'landflow.dev/grpc-port': 'nope' } })).error).toContain('"nope" is not a port');
    expect(serviceEndpoints(service('p', 'lf', { ports: [{ name: 'web', port: 80 }] })).error).toBe('Service lf/p has no gRPC port: annotate landflow.dev/grpc-port or name a port "grpc"');
  });

  it('addresses Services by DNS name (custom cluster domain) or ClusterIP', () => {
    expect(serviceEndpoints(service('p', 'lf'), { clusterDomain: 'k8s.internal' }).endpoints).toEqual(['grpc://p.lf.svc.k8s.internal:7203']);
    expect(serviceEndpoints(service('p', 'lf'), { address: 'cluster-ip' }).endpoints).toEqual(['grpc://10.96.0.7:7203']);
    expect(serviceEndpoints(service('p', 'lf', { clusterIP: 'fd07::7' }), { address: 'cluster-ip' }).endpoints).toEqual(['grpc://[fd07::7]:7203']);
    // Headless: no ClusterIP, so the DNS name (which resolves to the pods).
    expect(serviceEndpoints(service('p', 'lf', { clusterIP: 'None' }), { address: 'cluster-ip' }).endpoints).toEqual(['grpc://p.lf.svc.cluster.local:7203']);
  });

  it('parses LANDFLOW_K8S_NAMESPACES, defaulting to the own namespace', () => {
    expect(parseNamespaces(undefined, 'landflow')).toEqual(['landflow']);
    expect(parseNamespaces(' ', 'landflow')).toEqual(['landflow']);
    expect(parseNamespaces('a, b,a,,c', 'landflow')).toEqual(['a', 'b', 'c']);
    // `*` is every namespace, whatever else is listed.
    expect(parseNamespaces('*', 'landflow')).toEqual(['*']);
    expect(parseNamespaces('a,*', 'landflow')).toEqual(['*']);
  });

  it('finds the ready pods of a Service port in its slices: by port name, unnamed, several slices, IPv6', () => {
    const slices: KubeObject[] = [
      { ports: [{ name: 'grpc', port: 7201 }, { name: 'http', port: 7101 }], endpoints: [{ addresses: ['10.1.0.2'], conditions: { ready: true } }, { addresses: ['10.1.0.1'], conditions: { ready: null } }, { addresses: ['10.1.0.3'], conditions: { ready: false } }] },
      { ports: [{ name: 'grpc', port: 7201 }], endpoints: [{ addresses: ['fd00::5'], conditions: { ready: true } }, { addresses: [] }] },
    ];
    expect(podEndpoints({ scheme: 'grpc', portName: 'grpc' }, slices)).toEqual(['grpc://10.1.0.1:7201', 'grpc://10.1.0.2:7201', 'grpc://[fd00::5]:7201']);
    expect(podEndpoints({ scheme: 'http', portName: 'http' }, slices)).toEqual(['http://10.1.0.1:7101', 'http://10.1.0.2:7101']);
    // A Service with one unnamed port: its slices name the port ''.
    expect(podEndpoints({ scheme: 'grpc', portName: '' }, [{ ports: [{ name: '', port: 9000 }], endpoints: [{ addresses: ['10.2.0.1'] }] }])).toEqual(['grpc://10.2.0.1:9000']);
    expect(podEndpoints({ scheme: 'grpc', portName: 'other' }, slices)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The watch loop
// ---------------------------------------------------------------------------

describe('KubernetesDiscovery', () => {
  it('adds a plugin with a ready pod, updates it when the Service changes and removes it with the Service', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('go-crypto', 'lf'));
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true]));
    const { target } = discover(['lf'], { kube });
    await vi.waitFor(() => expect(target.endpoints.get(grpcOf('go-crypto', 'lf'))).toMatchObject({ status: 'online', origin: { namespace: 'lf', service: 'go-crypto' } }));
    expect(kube.lists.map((l) => `${l.kind}/${l.namespace}?${l.labelSelector}`).sort()).toEqual(['endpointslices/lf?landflow.dev/plugin=true', 'services/lf?landflow.dev/plugin=true']);
    // The watch resumes from the list's resourceVersion.
    await watching(kube, ['lf']);
    expect(kube.current('services', 'lf')!.resourceVersion).toBe('102');

    // A new plugin arrives on the watch.
    kube.put('services', 'lf', service('text-toolkit', 'lf'));
    kube.put('endpointslices', 'lf', slice('text-toolkit', 'lf', [true]));
    await vi.waitFor(() => expect(target.status(grpcOf('text-toolkit', 'lf'))).toBe('online'));

    // The gRPC port moves (annotation): the old endpoint goes, the new one comes, an HTTP one is added.
    kube.put('services', 'lf', service('go-crypto', 'lf', { ports: [{ name: 'rpc', port: 9203 }, { name: 'http', port: 7103 }], annotations: { 'landflow.dev/grpc-port': 'rpc', 'landflow.dev/http-port': 'http' } }));
    await vi.waitFor(() => expect([...target.endpoints.keys()].filter((e) => e.includes('go-crypto')).sort()).toEqual([grpcOf('go-crypto', 'lf', 9203), 'http://go-crypto.lf.svc.cluster.local:7103']));
    expect(target.calls).toContain(`remove ${grpcOf('go-crypto', 'lf')}`);

    // Deleted Service: removed, not just offline. Losing the label counts the same.
    kube.delete('services', 'lf', 'go-crypto');
    await vi.waitFor(() => expect([...target.endpoints.keys()].some((e) => e.includes('go-crypto'))).toBe(false));
    const unlabelled = service('text-toolkit', 'lf');
    unlabelled.metadata!.labels = {};
    kube.put('services', 'lf', unlabelled);
    await vi.waitFor(() => expect(target.endpoints.size).toBe(0));
  });

  it('follows readiness: nothing until a pod is ready, offline (not dropped) at zero, back online, re-pulled on a rollout', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('py-insights', 'lf'));
    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', [false]));
    const { target } = discover(['lf'], { kube });
    await watching(kube, ['lf']);
    await new Promise((r) => setTimeout(r, 30));
    expect(target.calls).toEqual([]);
    const endpoint = grpcOf('py-insights', 'lf');

    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', [true]));
    await vi.waitFor(() => expect(target.status(endpoint)).toBe('online'));

    // Scaled to zero: the slice empties. The plugin stays registered, offline.
    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', []));
    await vi.waitFor(() => expect(target.status(endpoint)).toBe('offline'));
    expect(target.calls.filter((c) => c.startsWith('remove'))).toEqual([]);

    // Scaled back up: online again, through a fresh registration (manifest pulled again).
    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', [true], 'v1'));
    await vi.waitFor(() => expect(target.endpoints.get(endpoint)).toMatchObject({ status: 'online', adds: 2 }));

    // A rollout replaces the pods: same count, different pods → the manifest is pulled again (new version).
    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', [true, false], 'v1'));
    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', [true], 'v2'));
    await vi.waitFor(() => expect(target.endpoints.get(endpoint)!.adds).toBe(3));
    // Unchanged ready pods (a not-ready pod joining) re-pull nothing.
    kube.put('endpointslices', 'lf', slice('py-insights', 'lf', [true, false], 'v2'));
    await new Promise((r) => setTimeout(r, 30));
    expect(target.endpoints.get(endpoint)!.adds).toBe(3);
    // The slice going away entirely (with the Service still there) is zero ready pods too.
    kube.delete('endpointslices', 'lf', 'py-insights-x1');
    await vi.waitFor(() => expect(target.status(endpoint)).toBe('offline'));
  });

  it('retries a registration that fails with backoff while the pod stays ready', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('messaging', 'lf'));
    kube.put('endpointslices', 'lf', slice('messaging', 'lf', [true]));
    const target = new FakeTarget();
    const endpoint = grpcOf('messaging', 'lf');
    target.failing.add(endpoint);
    const { notes } = discover(['lf'], { kube, target });
    await vi.waitFor(() => expect(target.calls.filter((c) => c === `add ${endpoint}`).length).toBeGreaterThanOrEqual(3));
    expect(target.status(endpoint)).toBeUndefined();
    expect(notes.some((n) => n.includes('lf/messaging not registered yet (connection refused)'))).toBe(true);
    target.failing.delete(endpoint);
    await vi.waitFor(() => expect(target.status(endpoint)).toBe('online'));
  });

  it('re-lists on resync: missed events are corrected and ready plugins the registry lost are added again', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('databases', 'lf'));
    kube.put('endpointslices', 'lf', slice('databases', 'lf', [true]));
    const { target, discovery } = discover(['lf'], { kube });
    const databases = grpcOf('databases', 'lf');
    await vi.waitFor(() => expect(target.status(databases)).toBe('online'));
    await watching(kube, ['lf']);
    const listsBefore = kube.lists.length;

    // Events the watch never delivered: databases deleted, google-workspace created.
    kube.delete('services', 'lf', 'databases', true);
    kube.delete('endpointslices', 'lf', 'databases-x1', true);
    kube.put('services', 'lf', service('google-workspace', 'lf'), true);
    kube.put('endpointslices', 'lf', slice('google-workspace', 'lf', [true]), true);
    await new Promise((r) => setTimeout(r, 30));
    expect(target.status(databases)).toBe('online');

    discovery.resync();
    await vi.waitFor(() => expect(target.status(grpcOf('google-workspace', 'lf'))).toBe('online'));
    await vi.waitFor(() => expect(target.status(databases)).toBeUndefined());
    expect(kube.lists.length).toBe(listsBefore + 2);

    // The registry marked the plugin offline (failed health) although its pod is ready: resync registers it again.
    target.offline(grpcOf('google-workspace', 'lf'));
    discovery.resync();
    await vi.waitFor(() => expect(target.status(grpcOf('google-workspace', 'lf'))).toBe('online'));
  });

  it('backs off on list and watch errors, re-lists at once on 410 Gone, and resumes a watch the server closed', async () => {
    const kube = new FakeKube();
    kube.listFailures = 4;
    kube.failingKind = 'services';
    kube.put('services', 'lf', service('go-crypto', 'lf'));
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true]));
    const sleeps: number[] = [];
    // Services fail to list four times in a row: 10, 20, 40, 40 ms (doubling from initialMs, capped at maxMs).
    const { target, notes } = discover(['lf'], { kube, sleeps });
    await vi.waitFor(() => expect(target.status(grpcOf('go-crypto', 'lf'))).toBe('online'));
    expect(sleeps).toEqual([10, 20, 40, 40]);
    expect(notes.some((n) => n.includes('Forbidden (retrying in'))).toBe(true);
    await watching(kube, ['lf']);

    // A watch that fails: back off, then a fresh list (one more list call).
    sleeps.length = 0;
    let lists = kube.lists.length;
    kube.current('services', 'lf')!.end(new Error('connection reset'));
    await vi.waitFor(() => expect(kube.lists.length).toBe(lists + 1));
    expect(sleeps).toEqual([10]);
    await watching(kube, ['lf']);

    // 410 Gone (resourceVersion too old) as an ERROR event: re-list straight away, no backoff.
    sleeps.length = 0;
    lists = kube.lists.length;
    kube.current('endpointslices', 'lf')!.emit('ERROR', { kind: 'Status', code: 410, message: 'too old resource version' });
    await vi.waitFor(() => expect(kube.lists.length).toBe(lists + 1));
    await watching(kube, ['lf']);
    expect(sleeps).toEqual([]);

    // The server closing the watch (its timeout): resumed from the last resourceVersion seen, without a list.
    lists = kube.lists.length;
    kube.put('services', 'lf', service('go-crypto', 'lf'));
    const rv = String(kube.rv);
    kube.current('services', 'lf')!.end();
    await vi.waitFor(() => expect(kube.current('services', 'lf')?.resourceVersion).toBe(rv));
    expect(kube.lists.length).toBe(lists);
    expect(target.status(grpcOf('go-crypto', 'lf'))).toBe('online');
  });

  it('watches only its namespaces, and keeps same-named Services in different namespaces apart', async () => {
    const kube = new FakeKube();
    for (const namespace of ['team-a', 'team-b', 'other']) {
      kube.put('services', namespace, service('go-crypto', namespace));
      kube.put('endpointslices', namespace, slice('go-crypto', namespace, [true]));
    }
    const { target } = discover(['team-a', 'team-b'], { kube });
    await vi.waitFor(() => expect(target.endpoints.size).toBe(2));
    expect(target.endpoints.get(grpcOf('go-crypto', 'team-a'))!.origin).toEqual({ namespace: 'team-a', service: 'go-crypto' });
    expect(target.endpoints.get(grpcOf('go-crypto', 'team-b'))!.origin).toEqual({ namespace: 'team-b', service: 'go-crypto' });
    expect(new Set(kube.lists.map((l) => l.namespace))).toEqual(new Set(['team-a', 'team-b']));
    await watching(kube, ['team-a', 'team-b']);

    // An object from another namespace on a watch is ignored, whatever the watch sends.
    kube.current('services', 'team-a')!.emit('ADDED', service('stray', 'other'));
    kube.current('endpointslices', 'team-a')!.emit('ADDED', slice('stray', 'other', [true]));
    // A slice in team-b does not make team-a's Service ready.
    kube.put('endpointslices', 'team-a', slice('go-crypto', 'team-a', []));
    await vi.waitFor(() => expect(target.status(grpcOf('go-crypto', 'team-a'))).toBe('offline'));
    expect(target.status(grpcOf('go-crypto', 'team-b'))).toBe('online');
    expect([...target.endpoints.keys()].some((e) => e.includes('stray') || e.includes('.other.'))).toBe(false);
  });

  it('reports a Service it cannot use once, and picks it up when fixed', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('broken', 'lf', { ports: [{ name: 'web', port: 80 }] }));
    kube.put('endpointslices', 'lf', slice('broken', 'lf', [true]));
    const { target, notes } = discover(['lf'], { kube });
    await vi.waitFor(() => expect(notes.filter((n) => n.includes('no gRPC port'))).toHaveLength(1));
    kube.put('endpointslices', 'lf', slice('broken', 'lf', [true], 'again'));
    await new Promise((r) => setTimeout(r, 30));
    expect(notes.filter((n) => n.includes('no gRPC port'))).toHaveLength(1);
    expect(target.calls).toEqual([]);
    kube.put('services', 'lf', service('broken', 'lf', { ports: [{ name: 'web', port: 80 }], annotations: { 'landflow.dev/grpc-port': '80' } }));
    await vi.waitFor(() => expect(target.status('grpc://broken.lf.svc.cluster.local:80')).toBe('online'));
  });
});

describe('spreading over pods and every namespace', () => {
  it('hands the ready pods of each endpoint to the registry, and follows scale-ups, unready pods and scale-downs', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('go-crypto', 'lf', { annotations: { 'landflow.dev/http-port': 'http' } }));
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true]));
    const { target, discovery } = discover(['lf'], { kube });
    const grpc = grpcOf('go-crypto', 'lf');
    const http = 'http://go-crypto.lf.svc.cluster.local:7103';
    await vi.waitFor(() => expect(target.status(grpc)).toBe('online'));
    expect(target.pods.get(grpc)).toEqual(['grpc://10.1.0.1:7203']);
    expect(target.pods.get(http)).toEqual(['http://10.1.0.1:7103']);
    await watching(kube, ['lf']);

    // Scaled to 3, one not ready yet: two pods take calls; the manifest is pulled again once per endpoint (not per pod).
    const adds = target.endpoints.get(grpc)!.adds;
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true, true, false]));
    await vi.waitFor(() => expect(target.pods.get(grpc)).toEqual(['grpc://10.1.0.1:7203', 'grpc://10.1.0.2:7203']));
    await vi.waitFor(() => expect(target.endpoints.get(grpc)!.adds).toBe(adds + 1));
    // The third turns ready.
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true, true, true]));
    await vi.waitFor(() => expect(target.pods.get(grpc)).toHaveLength(3));
    // One turns unready: it stops getting calls.
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [false, true, true]));
    await vi.waitFor(() => expect(target.pods.get(grpc)).toEqual(['grpc://10.1.0.2:7203', 'grpc://10.1.0.3:7203']));
    expect(discovery.snapshot()).toMatchObject([{ service: 'lf/go-crypto', pods: { [grpc]: ['grpc://10.1.0.2:7203', 'grpc://10.1.0.3:7203'], [http]: ['http://10.1.0.2:7103', 'http://10.1.0.3:7103'] } }]);
    // None ready: calls go nowhere but the Service (offline anyway).
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [false, false, false]));
    await vi.waitFor(() => expect(target.status(grpc)).toBe('offline'));
    expect(target.pods.has(grpc)).toBe(false);
    // The Service goes: so do its pods.
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true]));
    await vi.waitFor(() => expect(target.pods.get(grpc)).toEqual(['grpc://10.1.0.1:7203']));
    kube.delete('services', 'lf', 'go-crypto');
    await vi.waitFor(() => expect(target.endpoints.size).toBe(0));
    expect(target.pods.size).toBe(0);
  });

  it('leaves calls on the Service with spread `service`', async () => {
    const kube = new FakeKube();
    kube.put('services', 'lf', service('go-crypto', 'lf'));
    kube.put('endpointslices', 'lf', slice('go-crypto', 'lf', [true, true]));
    const { target } = discover(['lf'], { kube, spread: 'service' });
    await vi.waitFor(() => expect(target.status(grpcOf('go-crypto', 'lf'))).toBe('online'));
    expect(target.pods.size).toBe(0);
  });

  it('with `*`, lists and watches every namespace at once and keeps namespaces apart', async () => {
    const kube = new FakeKube();
    for (const namespace of ['team-a', 'team-b']) {
      kube.put('services', namespace, service('go-crypto', namespace));
      kube.put('endpointslices', namespace, slice('go-crypto', namespace, [true]));
    }
    const { target } = discover(['*'], { kube });
    await vi.waitFor(() => expect(target.endpoints.size).toBe(2));
    expect(target.endpoints.get(grpcOf('go-crypto', 'team-a'))!.origin).toEqual({ namespace: 'team-a', service: 'go-crypto' });
    expect(target.endpoints.get(grpcOf('go-crypto', 'team-b'))!.origin).toEqual({ namespace: 'team-b', service: 'go-crypto' });
    // One cluster-wide list per kind, no per-namespace ones.
    expect(kube.lists.map((l) => `${l.kind}/${l.namespace}`).sort()).toEqual(['endpointslices/*', 'services/*']);
    await watching(kube, ['*']);

    // A namespace created later: its plugin shows up through the cluster-wide watch.
    kube.put('services', 'team-c', service('text-toolkit', 'team-c'));
    kube.put('endpointslices', 'team-c', slice('text-toolkit', 'team-c', [true]));
    await vi.waitFor(() => expect(target.status(grpcOf('text-toolkit', 'team-c'))).toBe('online'));
    // A slice in team-b does not make team-a's Service unready.
    kube.put('endpointslices', 'team-b', slice('go-crypto', 'team-b', []));
    await vi.waitFor(() => expect(target.status(grpcOf('go-crypto', 'team-b'))).toBe('offline'));
    expect(target.status(grpcOf('go-crypto', 'team-a'))).toBe('online');
    // An object without a namespace on a cluster-wide watch is ignored.
    kube.current('services', '*')!.emit('ADDED', { metadata: { name: 'nameless', labels: { 'landflow.dev/plugin': 'true' } }, spec: { ports: [{ name: 'grpc', port: 1 }] } });
    // Deleting the namespace's Service removes its plugin.
    kube.delete('services', 'team-c', 'text-toolkit');
    await vi.waitFor(() => expect(target.status(grpcOf('text-toolkit', 'team-c'))).toBeUndefined());
    expect([...target.endpoints.keys()].some((e) => e.includes('nameless'))).toBe(false);

    // A re-list (resync) replaces every namespace's objects at once.
    kube.delete('services', 'team-b', 'go-crypto', true);
    running.at(-1)!.resync();
    await vi.waitFor(() => expect(target.status(grpcOf('go-crypto', 'team-b'))).toBeUndefined());
    expect(target.status(grpcOf('go-crypto', 'team-a'))).toBe('online');
  });
});

describe('PooledPluginClient', () => {
  /** A fake client whose execute waits until released. */
  function fakeClient(endpoint: string, log: string[]) {
    const waiting: Array<() => void> = [];
    let closed = false;
    const client: PluginClient & { release(): void; get closed(): boolean } = {
      endpoint,
      transport: 'grpc',
      manifest: async () => {
        log.push(`manifest ${endpoint}`);
        return { plugin: { id: 'p' } } as never;
      },
      manifestWithProof: async () => ({ manifest: { plugin: { id: 'p' } } as never, proof: 'x' }),
      execute: async () => {
        log.push(`execute ${endpoint}`);
        await new Promise<void>((resolve) => waiting.push(resolve));
        return { outputs: [] } as never;
      },
      loadOptions: async () => (log.push(`options ${endpoint}`), []),
      testCredentials: async () => (log.push(`test ${endpoint}`), { ok: true }),
      webhookMethod: async () => (log.push(`webhookMethod ${endpoint}`), { ok: true } as never),
      receiveWebhook: async () => (log.push(`webhook ${endpoint}`), {} as never),
      health: async () => (log.push(`health ${endpoint}`), {} as never),
      close: () => {
        closed = true;
        log.push(`close ${endpoint}`);
      },
      release: () => waiting.shift()?.(),
      get closed() {
        return closed;
      },
    };
    return client;
  }

  it('sends each call to the pod with the fewest in flight (round robin among equals); manifest and health go to the Service', async () => {
    const log: string[] = [];
    const clients = new Map<string, ReturnType<typeof fakeClient>>();
    const create = (endpoint: string) => {
      const client = fakeClient(endpoint, log);
      clients.set(endpoint, client);
      return client;
    };
    const service = fakeClient('grpc://svc:7201', log);
    const pool = new PooledPluginClient(service, ['grpc://a:7201', 'grpc://b:7201'], create);
    pool.pluginId = 'p';
    expect(clients.get('grpc://a:7201')!.pluginId).toBe('p');

    const calls = [pool.execute({} as never), pool.execute({} as never), pool.execute({} as never)];
    await Promise.resolve();
    // a, b, then a again (both had one in flight: round robin).
    expect(log.filter((l) => l.startsWith('execute'))).toEqual(['execute grpc://a:7201', 'execute grpc://b:7201', 'execute grpc://a:7201']);
    expect(pool.stats()).toEqual([
      { endpoint: 'grpc://a:7201', inflight: 2, calls: 2 },
      { endpoint: 'grpc://b:7201', inflight: 1, calls: 1 },
    ]);
    // b has fewer in flight: the next call goes there.
    void pool.execute({} as never);
    await Promise.resolve();
    expect(log.filter((l) => l.startsWith('execute')).at(-1)).toBe('execute grpc://b:7201');
    await pool.manifest();
    await pool.manifestWithProof('c');
    await pool.health();
    await pool.loadOptions({} as never);
    expect(log).toEqual(expect.arrayContaining(['manifest grpc://svc:7201', 'health grpc://svc:7201']));
    expect(log.some((l) => l.startsWith('options grpc://svc'))).toBe(false);

    // A pod leaves while two of its calls run: its client closes once they finish; a new pod joins.
    pool.setBackends(['grpc://b:7201', 'grpc://c:7201']);
    expect(clients.get('grpc://a:7201')!.closed).toBe(false);
    clients.get('grpc://a:7201')!.release();
    clients.get('grpc://a:7201')!.release();
    await Promise.all(calls.filter((_, i) => i !== 1));
    expect(clients.get('grpc://a:7201')!.closed).toBe(true);
    void pool.execute({} as never);
    await Promise.resolve();
    expect(log.filter((l) => l.startsWith('execute')).at(-1)).toBe('execute grpc://c:7201');

    // A re-pulled manifest swaps the Service client and keeps the pods.
    const next = fakeClient('grpc://svc:7201', log);
    pool.replacePrimary(next);
    expect(service.closed).toBe(true);
    expect(pool.stats().map((s) => s.endpoint)).toEqual(['grpc://b:7201', 'grpc://c:7201']);
    // No pods: calls go through the Service.
    pool.setBackends([]);
    await pool.testCredentials({} as never);
    expect(log.at(-1)).toBe('test grpc://svc:7201');
    pool.close();
    expect(next.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The registry side, for real: origin, offline/remove, and the registry secret
// ---------------------------------------------------------------------------

const noop = defineNode({
  description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  execute: (ctx) => ctx.getInputData().map((item) => ({ json: { ...item.json, echoed: true } })),
});
const pluginNamed = (id: string) => definePlugin({ info: { id, name: `K8s ${id}`, version: '1.0.0' }, nodes: [noop] });

/** An HTTP plugin whose manifest's proof header `rewrite` may replace (another secret) or drop (an older SDK). */
async function httpPlugin(plugin: IPlugin, rewrite?: (proof: string | null, challenge: string | null) => string | null): Promise<{ server: Server; url: string }> {
  const handle = createFetchHandler(plugin);
  const server = createServer(async (req, res) => {
    const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])));
    const response = await handle(new Request(`http://plugin${req.url}`, { headers }));
    const out = Object.fromEntries(response.headers);
    if (rewrite) {
      const proof = rewrite(response.headers.get(REGISTRY_PROOF_HEADER), headers.get('x-landflow-registry-challenge'));
      delete out[REGISTRY_PROOF_HEADER];
      if (proof) out[REGISTRY_PROOF_HEADER] = proof;
    }
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('discovered endpoints in the registry', () => {
  const servers: Server[] = [];
  let grpcServer: grpc.Server;
  const GRPC_PORT = 47381;
  beforeAll(async () => {
    grpcServer = await serveGrpc(pluginNamed('k8s-grpc'), { port: GRPC_PORT, host: '127.0.0.1' });
  });
  afterAll(() => {
    grpcServer.forceShutdown();
    for (const server of servers) server.close();
  });
  afterEach(() => {
    delete process.env.LANDFLOW_REGISTRY_SECRET;
  });

  it('registers with source kubernetes and the namespace, goes offline with a reason, and is removed', async () => {
    const { server, url } = await httpPlugin(pluginNamed('k8s-plain'));
    servers.push(server);
    const target = registryTarget();
    await target.add(url, { namespace: 'landflow-dev', service: 'k8s-plain' });
    const summary = () => registry.list().find((p) => p.id === 'k8s-plain');
    expect(summary()).toMatchObject({ source: 'kubernetes', status: 'online', endpoints: [{ endpoint: url, source: 'kubernetes', origin: { namespace: 'landflow-dev', service: 'k8s-plain' } }] });
    expect(target.status(url)).toBe('online');

    target.offline(url, 'no ready pod behind Service landflow-dev/k8s-plain');
    expect(summary()).toMatchObject({ status: 'offline', endpoints: [{ status: 'offline', lastError: 'no ready pod behind Service landflow-dev/k8s-plain' }] });
    expect(registry.nodeTypes().find((t) => t.type === 'k8s-plain.echo')).toMatchObject({ available: false });

    // A refresh (Plugins page) keeps the origin.
    await registry.refresh('k8s-plain');
    expect(summary()).toMatchObject({ status: 'online', endpoints: [{ origin: { namespace: 'landflow-dev', service: 'k8s-plain' } }] });

    target.remove(url);
    expect(summary()).toBeUndefined();
    expect(target.status(url)).toBeUndefined();
  });

  it('with LANDFLOW_REGISTRY_SECRET set, takes a discovered plugin only with a valid proof, over HTTP and gRPC', async () => {
    process.env.LANDFLOW_REGISTRY_SECRET = 'k8s-s3cret';
    const target = registryTarget();
    const origin = { namespace: 'landflow-dev', service: 'x' };

    // The SDK answers by itself (plugin and host share the secret here): accepted over both transports.
    const good = await httpPlugin(pluginNamed('k8s-proven'));
    servers.push(good.server);
    await target.add(good.url, origin);
    expect(registry.list().find((p) => p.id === 'k8s-proven')?.status).toBe('online');
    await target.add(`grpc://127.0.0.1:${GRPC_PORT}`, origin);
    expect(registry.list().find((p) => p.id === 'k8s-grpc')?.status).toBe('online');

    // A plugin without the secret (or an older SDK) sends no proof; one with another secret sends a wrong one.
    const silent = await httpPlugin(pluginNamed('k8s-silent'), () => null);
    const wrong = await httpPlugin(pluginNamed('k8s-wrong'), (_proof, challenge) => registryProof('another-secret', 'k8s-wrong', challenge ?? ''));
    // A proof for another plugin id (replayed from a real plugin) does not count either.
    const replayed = await httpPlugin(pluginNamed('k8s-replayed'), (_proof, challenge) => registryProof('k8s-s3cret', 'k8s-proven', challenge ?? ''));
    servers.push(silent.server, wrong.server, replayed.server);
    await expect(target.add(silent.url, origin)).rejects.toThrow('did not prove the registry secret');
    await expect(target.add(wrong.url, origin)).rejects.toThrow('wrong registry proof');
    await expect(target.add(replayed.url, origin)).rejects.toThrow('wrong registry proof');
    expect(registry.list().map((p) => p.id)).not.toEqual(expect.arrayContaining(['k8s-silent']));
    expect(registry.list().some((p) => ['k8s-silent', 'k8s-wrong', 'k8s-replayed'].includes(p.id))).toBe(false);

    // Other sources are unchanged: a static seed needs no proof (it is configured on the host).
    await registry.addEndpoint(silent.url, 'static');
    expect(registry.list().find((p) => p.id === 'k8s-silent')?.status).toBe('online');

    // Without the secret, discovered plugins need no proof.
    delete process.env.LANDFLOW_REGISTRY_SECRET;
    await target.add(wrong.url, origin);
    expect(registry.list().find((p) => p.id === 'k8s-wrong')?.status).toBe('online');
    for (const id of ['k8s-proven', 'k8s-grpc', 'k8s-silent', 'k8s-wrong']) registry.remove(id);
  });

  it('spreads executions over the pods it was given, pulls the manifest once through the Service, and follows pod changes', async () => {
    // Three servers of one plugin: the Service and two pods. Each counts what it serves.
    const hits = new Map<string, string[]>();
    const counted = async (name: string) => {
      const handle = createFetchHandler(pluginNamed('k8s-pods'));
      const server = createServer(async (req, res) => {
        hits.set(name, [...(hits.get(name) ?? []), req.url ?? '']);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])));
        const response = await handle(new Request(`http://plugin${req.url}`, { method: req.method, headers, ...(chunks.length && { body: Buffer.concat(chunks) }) }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const serviceUrl = await counted('service');
    const podA = await counted('a');
    const podB = await counted('b');
    const target = registryTarget();
    target.backends!(serviceUrl, [podA, podB]);
    await target.add(serviceUrl, { namespace: 'landflow-dev', service: 'k8s-pods' });

    const resolveType = (registry as unknown as { resolveType(type: string): { execute(request: object): Promise<{ outputs: Array<Array<{ json: object }>> }> } }).resolveType.bind(registry);
    const run = (n: number) =>
      resolveType('k8s-pods.echo').execute({
        protocol: 'landflow.plugin/v1', executionId: `e${n}`, mode: 'manual', node: { id: 'n', name: 'Echo', type: 'k8s-pods.echo', typeVersion: 1 }, parameters: {}, itemParameters: [{}], inputs: [[{ json: { n } }]],
      });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(run));
    expect(results.map((r) => r.outputs[0]![0]!.json)).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ n, echoed: true })));
    const executes = (name: string) => (hits.get(name) ?? []).filter((url) => url.includes('execute')).length;
    expect(executes('a')).toBe(3);
    expect(executes('b')).toBe(3);
    expect(executes('service')).toBe(0);
    // The manifest came from the Service only.
    expect((hits.get('service') ?? []).filter((url) => url.includes('manifest'))).toHaveLength(1);
    expect((hits.get('a') ?? []).some((url) => url.includes('manifest'))).toBe(false);
    expect(registry.endpointBackends(serviceUrl)).toEqual([
      { endpoint: podA, inflight: 0, calls: 3 },
      { endpoint: podB, inflight: 0, calls: 3 },
    ]);

    // Pod a goes, pod c comes; a refresh (manifest re-pull) keeps the pods.
    const podC = await counted('c');
    target.backends!(serviceUrl, [podB, podC]);
    await registry.refresh('k8s-pods');
    await Promise.all([7, 8].map(run));
    expect(executes('a')).toBe(3);
    expect(executes('b') + executes('c')).toBe(5);
    expect(executes('c')).toBeGreaterThanOrEqual(1);
    expect((hits.get('service') ?? []).filter((url) => url.includes('manifest'))).toHaveLength(2);

    // No pods: through the Service.
    target.backends!(serviceUrl, []);
    await run(9);
    expect(executes('service')).toBe(1);
    target.remove(serviceUrl);
    expect(registry.endpointBackends(serviceUrl)).toEqual([]);
  });
});
