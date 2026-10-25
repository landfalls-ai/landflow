/**
 * Kubernetes discovery (LANDFLOW_PLUGIN_DISCOVERY=kubernetes). Plugins are the Services labelled
 * `landflow.dev/plugin=true` in LANDFLOW_K8S_NAMESPACES (default: the host's own namespace). The gRPC port is the
 * `landflow.dev/grpc-port` annotation (a Service port number or name) or a port named `grpc`; `landflow.dev/http-port`
 * adds an HTTP endpoint. A Service's EndpointSlices say whether a pod is ready:
 *
 * - ready → the registry pulls the manifest through its usual path, proving LANDFLOW_REGISTRY_SECRET when it is set
 *   (registry-proof.ts, docs/protocol.md §13), and retries with backoff while that fails;
 * - a different set of ready pods (a rollout, a scale-up) → the manifest is pulled again, so upgrades show;
 * - no ready pod → the plugin is marked offline, not dropped (saved workflows still open);
 * - Service deleted or unlabelled → its endpoints are removed (and the plugin with its last endpoint).
 *
 * Services and EndpointSlices are listed, then watched from that resourceVersion. A watch the server closes is
 * resumed; one that fails is retried after an exponential backoff, from a fresh list; everything is re-listed every
 * LANDFLOW_K8S_RESYNC_SECONDS. Credentials: in-cluster (the pod's service account) inside a pod, else the kubeconfig
 * (KUBECONFIG or ~/.kube/config) with LANDFLOW_K8S_CONTEXT, or its current context. It runs next to announce, static
 * seeds and scan: all of them feed the same registry.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { EndpointOrigin, PluginStatus } from '../../shared/types';
import { bus } from '../bus';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { registry } from './registry';

export const PLUGIN_LABEL_SELECTOR = 'landflow.dev/plugin=true';
export const GRPC_PORT_ANNOTATION = 'landflow.dev/grpc-port';
export const HTTP_PORT_ANNOTATION = 'landflow.dev/http-port';
const SERVICE_NAME_LABEL = 'kubernetes.io/service-name';
/** The server ends each watch after this long (before client-node's 30 s request timeout); it is then resumed. */
const WATCH_TIMEOUT_SECONDS = 25;

// ---------------------------------------------------------------------------
// The slice of the Kubernetes API discovery uses (tests pass a fake watch stream)
// ---------------------------------------------------------------------------

export type KubeKind = 'services' | 'endpointslices';

interface KubeMeta {
  name?: string;
  namespace?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface KubeService {
  metadata?: KubeMeta;
  spec?: { clusterIP?: string; ports?: Array<{ name?: string; port: number; appProtocol?: string }> };
}

export interface KubeEndpointSlice {
  metadata?: KubeMeta;
  endpoints?: Array<{ addresses?: string[]; conditions?: { ready?: boolean | null }; targetRef?: { uid?: string } }> | null;
}

export type KubeObject = KubeService & KubeEndpointSlice;

/** A watch event: ADDED, MODIFIED, DELETED, BOOKMARK, or ERROR (a Status object; 410 means the resourceVersion is gone). */
export interface KubeWatchEvent {
  type: string;
  object: KubeObject & { code?: number; message?: string };
}

export interface KubeApi {
  list(kind: KubeKind, namespace: string, labelSelector: string): Promise<{ resourceVersion: string; items: KubeObject[] }>;
  /** Streams events from `resourceVersion` until the server closes the watch (resolves) or it fails (rejects); `signal` stops it. */
  watch(kind: KubeKind, namespace: string, labelSelector: string, resourceVersion: string, onEvent: (event: KubeWatchEvent) => void, signal: AbortSignal): Promise<void>;
}

/** What discovery does to the registry (registryTarget() in production). */
export interface DiscoveryTarget {
  add(endpoint: string, origin: EndpointOrigin): Promise<unknown>;
  offline(endpoint: string, reason: string): void;
  remove(endpoint: string): void;
  status(endpoint: string): PluginStatus | undefined;
}

export interface KubernetesDiscoveryOptions {
  api: KubeApi;
  namespaces: string[];
  target: DiscoveryTarget;
  labelSelector?: string;
  /** `dns` (default): <service>.<namespace>.svc.<clusterDomain>; `cluster-ip`: the Service's ClusterIP. */
  address?: 'dns' | 'cluster-ip';
  clusterDomain?: string;
  /** Full re-list interval (default 5 minutes); 0 turns it off. */
  resyncMs?: number;
  /** Watch failures and failed registrations back off from `initialMs`, doubling up to `maxMs`, with ±20 % jitter. */
  backoff?: { initialMs?: number; maxMs?: number; jitter?: boolean };
  /** Coalesces bursts of events per Service (a rollout touches its EndpointSlices several times). */
  debounceMs?: number;
  /** Discovery problems for the Plugins page's feed and the log. */
  notify?: (message: string, level: 'info' | 'warn') => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Service → endpoints
// ---------------------------------------------------------------------------

/** The registry endpoints a plugin Service stands for, or why it has none. */
export function serviceEndpoints(service: KubeService, options: { address?: 'dns' | 'cluster-ip'; clusterDomain?: string } = {}): { endpoints: string[]; error?: string } {
  const { name = '', namespace = '', annotations = {} } = service.metadata ?? {};
  const ports = service.spec?.ports ?? [];
  const pick = (annotation: string, names: string[], protocols: string[]): { port?: number; error?: string } => {
    const value = annotations[annotation]?.trim();
    if (value) {
      const port = /^\d+$/.test(value) ? ports.find((p) => p.port === Number(value)) : ports.find((p) => p.name === value);
      return port ? { port: port.port } : { error: `${annotation}: "${value}" is not a port of Service ${namespace}/${name}` };
    }
    return { port: (ports.find((p) => p.name && names.includes(p.name)) ?? ports.find((p) => p.appProtocol && protocols.includes(p.appProtocol)))?.port };
  };
  const grpc = pick(GRPC_PORT_ANNOTATION, ['grpc', 'landflow-grpc'], ['grpc', 'kubernetes.io/h2c']);
  const http = pick(HTTP_PORT_ANNOTATION, [], []);
  const error = grpc.error ?? http.error;
  if (error) return { endpoints: [], error };
  if (!grpc.port && !http.port) return { endpoints: [], error: `Service ${namespace}/${name} has no gRPC port: annotate ${GRPC_PORT_ANNOTATION} or name a port "grpc"` };
  const clusterIP = service.spec?.clusterIP;
  const host =
    options.address === 'cluster-ip' && clusterIP && clusterIP !== 'None' ? (clusterIP.includes(':') ? `[${clusterIP}]` : clusterIP) : `${name}.${namespace}.svc.${options.clusterDomain ?? 'cluster.local'}`;
  return { endpoints: [...(grpc.port ? [`grpc://${host}:${grpc.port}`] : []), ...(http.port ? [`http://${host}:${http.port}`] : [])] };
}

/** Ready pods of a slice, as `<pod uid>@<address>` (an unknown readiness counts as ready, as Kubernetes defines it). */
function readyPods(slice: KubeEndpointSlice): string[] {
  return (slice.endpoints ?? []).filter((e) => e.conditions?.ready !== false && e.addresses?.length).map((e) => `${e.targetRef?.uid ?? ''}@${e.addresses![0]}`);
}

/** LANDFLOW_K8S_NAMESPACES: a comma-separated list; empty means the host's own namespace. */
export function parseNamespaces(setting: string | undefined, own: string): string[] {
  const list = (setting ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list.length ? list : [own])];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface Applied {
  endpoints: string[];
  /** Ready pods when last reconciled; a change while ready re-pulls the manifest. */
  fingerprint: string;
  ready: boolean;
  /** Endpoints the registry accepted. */
  registered: Set<string>;
  attempts: number;
  retry?: NodeJS.Timeout;
  problem?: string;
}

class WatchGone extends Error {}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export class KubernetesDiscovery {
  private readonly services = new Map<string, KubeService>();
  private readonly slices = new Map<string, KubeEndpointSlice>();
  private readonly applied = new Map<string, Applied>();
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; resync: boolean }>();
  private readonly watches = new Map<string, { relist: boolean; controller?: AbortController }>();
  private readonly stopper = new AbortController();
  private resyncTimer?: NodeJS.Timeout;
  private readonly namespaces: Set<string>;
  private readonly labelSelector: string;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly notify: (message: string, level: 'info' | 'warn') => void;

  constructor(private readonly options: KubernetesDiscoveryOptions) {
    this.namespaces = new Set(options.namespaces);
    this.labelSelector = options.labelSelector ?? PLUGIN_LABEL_SELECTOR;
    this.sleep = options.sleep ?? abortableSleep;
    this.notify = options.notify ?? (() => {});
  }

  start() {
    for (const namespace of this.namespaces) for (const kind of ['services', 'endpointslices'] as const) void this.reflect(kind, namespace);
    const resyncMs = this.options.resyncMs ?? 300_000;
    if (resyncMs > 0) {
      this.resyncTimer = setInterval(() => this.resync(), resyncMs);
      this.resyncTimer.unref?.();
    }
  }

  stop() {
    this.stopper.abort();
    clearInterval(this.resyncTimer);
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    for (const state of this.applied.values()) clearTimeout(state.retry);
    this.pending.clear();
  }

  /** Re-list everything now: missed events are corrected and ready plugins that are offline in the registry are tried again. */
  resync() {
    for (const watch of this.watches.values()) {
      watch.relist = true;
      watch.controller?.abort();
    }
  }

  private backoff(attempt: number): number {
    const { initialMs = 1_000, maxMs = 30_000, jitter = true } = this.options.backoff ?? {};
    const delay = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(jitter ? delay * (0.8 + Math.random() * 0.4) : delay);
  }

  /** List, then watch one kind in one namespace, until stopped. */
  private async reflect(kind: KubeKind, namespace: string) {
    const { api } = this.options;
    const watch = { relist: true } as { relist: boolean; controller?: AbortController };
    this.watches.set(`${kind}/${namespace}`, watch);
    let resourceVersion = '';
    let failures = 0;
    while (!this.stopper.signal.aborted) {
      try {
        if (watch.relist) {
          watch.relist = false;
          const list = await api.list(kind, namespace, this.labelSelector);
          this.replace(kind, namespace, list.items);
          resourceVersion = list.resourceVersion;
          if (failures) this.notify(`Kubernetes: watching ${kind} in ${namespace} again`, 'info');
          failures = 0;
        }
        const controller = new AbortController();
        watch.controller = controller;
        const stop = () => controller.abort();
        this.stopper.signal.addEventListener('abort', stop, { once: true });
        let failure: Error | undefined;
        const started = Date.now();
        try {
          await api.watch(
            kind,
            namespace,
            this.labelSelector,
            resourceVersion,
            (event) => {
              if (failure || controller.signal.aborted) return;
              if (event.type === 'ERROR') {
                failure = event.object?.code === 410 ? new WatchGone('resourceVersion expired') : new Error(`watch error ${event.object?.code ?? ''}: ${event.object?.message ?? 'unknown'}`);
                controller.abort();
                return;
              }
              resourceVersion = event.object?.metadata?.resourceVersion ?? resourceVersion;
              if (event.type !== 'BOOKMARK') this.apply(kind, namespace, event.type, event.object);
            },
            controller.signal,
          );
        } finally {
          this.stopper.signal.removeEventListener('abort', stop);
        }
        if (failure) throw failure;
        // Closed by the server (its timeout) or by resync(): resume, or re-list. Never spin on a watch that closes at once.
        if (!watch.relist && Date.now() - started < 1_000) await this.sleep(1_000, this.stopper.signal);
      } catch (error) {
        if (this.stopper.signal.aborted) break;
        watch.relist = true;
        if (error instanceof WatchGone || (error as { statusCode?: number }).statusCode === 410) continue;
        failures++;
        const delay = this.backoff(failures);
        this.notify(`Kubernetes: ${kind} in ${namespace}: ${(error as Error).message ?? error} (retrying in ${Math.round(delay / 100) / 10} s)`, 'warn');
        await this.sleep(delay, this.stopper.signal);
      }
    }
  }

  private serviceKeyOf(kind: KubeKind, namespace: string, object: KubeObject): string | undefined {
    const name = kind === 'services' ? object.metadata?.name : object.metadata?.labels?.[SERVICE_NAME_LABEL];
    return name ? `${namespace}/${name}` : undefined;
  }

  /** A fresh list: the namespace's objects of that kind are exactly `items`. */
  private replace(kind: KubeKind, namespace: string, items: KubeObject[]) {
    const store: Map<string, KubeObject> = kind === 'services' ? this.services : this.slices;
    const touched = new Set<string>();
    for (const [key, object] of store) {
      if (!key.startsWith(`${namespace}/`)) continue;
      store.delete(key);
      const service = this.serviceKeyOf(kind, namespace, object);
      if (service) touched.add(service);
    }
    for (const object of items) {
      if (!this.accepts(namespace, object)) continue;
      store.set(`${namespace}/${object.metadata!.name}`, object);
      const service = this.serviceKeyOf(kind, namespace, object);
      if (service) touched.add(service);
    }
    for (const key of touched) this.schedule(key, true);
    // Plugins whose Service and slices both vanished while the watch was down are in `applied` only.
    for (const key of this.applied.keys()) if (key.startsWith(`${namespace}/`)) this.schedule(key, true);
  }

  private apply(kind: KubeKind, namespace: string, type: string, object: KubeObject) {
    if (!this.accepts(namespace, object)) return;
    const store: Map<string, KubeObject> = kind === 'services' ? this.services : this.slices;
    const key = `${namespace}/${object.metadata!.name}`;
    const previous = store.get(key);
    // A Service that loses the label is no plugin any more (a label-selector watch reports that as DELETED anyway).
    const gone = type === 'DELETED' || (kind === 'services' && !this.matchesSelector(object));
    if (gone) store.delete(key);
    else store.set(key, object);
    for (const service of new Set([previous && this.serviceKeyOf(kind, namespace, previous), this.serviceKeyOf(kind, namespace, object)])) if (service) this.schedule(service, false);
  }

  /** Only objects of the watched namespaces (and with a name) count, whatever a watch sends. */
  private accepts(namespace: string, object: KubeObject): boolean {
    const meta = object?.metadata;
    return Boolean(meta?.name) && this.namespaces.has(namespace) && (!meta!.namespace || meta!.namespace === namespace);
  }

  private matchesSelector(object: KubeObject): boolean {
    const labels = object.metadata?.labels ?? {};
    return this.labelSelector.split(',').every((term) => {
      const [key, value] = term.split('=').map((s) => s.trim());
      return value === undefined ? key in labels : labels[key] === value;
    });
  }

  private schedule(key: string, resync: boolean) {
    const pending = this.pending.get(key);
    if (pending) clearTimeout(pending.timer);
    const merged = resync || Boolean(pending?.resync);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.reconcile(key, merged);
    }, this.options.debounceMs ?? 300);
    timer.unref?.();
    this.pending.set(key, { timer, resync: merged });
  }

  /** Bring the registry in line with one Service and its EndpointSlices. */
  private reconcile(key: string, resync: boolean) {
    if (this.stopper.signal.aborted) return;
    const { target } = this.options;
    const service = this.services.get(key);
    const previous = this.applied.get(key);
    const parsed = service ? serviceEndpoints(service, this.options) : { endpoints: [] };
    const desired = parsed.endpoints;
    for (const endpoint of previous?.registered ?? []) if (!desired.includes(endpoint)) target.remove(endpoint);
    if (parsed.error && parsed.error !== previous?.problem) this.notify(`Kubernetes: ${parsed.error}`, 'warn');
    if (!service) {
      clearTimeout(previous?.retry);
      this.applied.delete(key);
      return;
    }
    const namespace = key.split('/')[0];
    const pods = [...this.slices.entries()]
      .filter(([sliceKey, slice]) => sliceKey.startsWith(`${namespace}/`) && `${namespace}/${slice.metadata?.labels?.[SERVICE_NAME_LABEL]}` === key)
      .flatMap(([, slice]) => readyPods(slice))
      .sort();
    const state: Applied = {
      endpoints: desired,
      fingerprint: pods.join(','),
      ready: pods.length > 0,
      registered: new Set([...(previous?.registered ?? [])].filter((e) => desired.includes(e))),
      attempts: previous?.attempts ?? 0,
      retry: previous?.retry,
      problem: parsed.error,
    };
    this.applied.set(key, state);
    if (!state.ready) {
      clearTimeout(state.retry);
      state.retry = undefined;
      state.attempts = 0;
      for (const endpoint of state.registered) if (target.status(endpoint) === 'online') target.offline(endpoint, `no ready pod behind Service ${key}`);
      return;
    }
    const changed = !previous?.ready || previous.fingerprint !== state.fingerprint;
    const todo = desired.filter((e) => changed || !state.registered.has(e) || (resync && target.status(e) !== 'online'));
    if (todo.length) void this.connect(key, todo);
  }

  /** Register (or re-pull) endpoints; failures are retried with backoff while the Service still has ready pods. */
  private async connect(key: string, endpoints: string[]) {
    const [namespace, service] = key.split('/') as [string, string];
    const before = this.applied.get(key);
    if (!before) return;
    clearTimeout(before.retry);
    before.retry = undefined;
    endpoints = endpoints.filter((endpoint) => before.endpoints.includes(endpoint));
    if (!endpoints.length) return;
    const results = await Promise.allSettled(endpoints.map((endpoint) => this.options.target.add(endpoint, { namespace, service })));
    if (this.stopper.signal.aborted) return;
    const current = this.applied.get(key);
    const failed: string[] = [];
    results.forEach((result, i) => {
      const endpoint = endpoints[i]!;
      const wanted = current?.endpoints.includes(endpoint);
      if (result.status === 'rejected') {
        if (wanted) failed.push(endpoint);
        return;
      }
      // The Service changed or went away while we connected.
      if (!current || !wanted) return this.options.target.remove(endpoint);
      current.registered.add(endpoint);
      if (!current.ready) this.options.target.offline(endpoint, `no ready pod behind Service ${key}`);
    });
    if (!current) return;
    if (!failed.length || !current.ready) {
      current.attempts = 0;
      return;
    }
    current.attempts++;
    const delay = this.backoff(current.attempts);
    const reason = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason as Error | undefined;
    if (current.attempts === 1 || current.attempts % 5 === 0) this.notify(`Kubernetes: ${key} not registered yet (${reason?.message ?? reason}); retrying`, 'warn');
    current.retry = setTimeout(() => void this.connect(key, failed), delay);
    current.retry.unref?.();
  }

  /** What discovery currently sees, for tests and troubleshooting. */
  snapshot() {
    return [...this.applied.entries()].map(([key, state]) => ({ service: key, endpoints: state.endpoints, ready: state.ready, registered: [...state.registered], ...(state.problem && { problem: state.problem }) }));
  }
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/** The registry as discovery's target: endpoints carry their origin and prove the registry secret. */
export function registryTarget(): DiscoveryTarget {
  return {
    add: (endpoint, origin) => registry.addEndpoint(endpoint, 'kubernetes', undefined, { origin, requireProof: true }),
    offline: (endpoint, reason) => void registry.withdraw(endpoint, reason),
    remove: (endpoint) => void registry.removeEndpoint(endpoint),
    status: (endpoint) => registry.endpointStatus(endpoint),
  };
}

/** Kubernetes credentials: in-cluster inside a pod (unless LANDFLOW_K8S_CONTEXT is set), else the kubeconfig. */
export async function kubeApiFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ api: KubeApi; namespace: string; context: string }> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  const wanted = env.LANDFLOW_K8S_CONTEXT?.trim();
  let namespace: string;
  // Literal paths: the pod's service account (a computed path would make Turbopack trace the whole project).
  if (!wanted && env.KUBERNETES_SERVICE_HOST && existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')) {
    kc.loadFromCluster();
    namespace = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
  } else {
    kc.loadFromDefault();
    if (wanted) {
      if (!kc.getContextObject(wanted)) throw new Error(`LANDFLOW_K8S_CONTEXT: no context "${wanted}" in the kubeconfig`);
      kc.setCurrentContext(wanted);
    }
    if (!kc.getCurrentCluster()) throw new Error('No Kubernetes cluster: run in a pod, or set KUBECONFIG / LANDFLOW_K8S_CONTEXT');
    namespace = kc.getContextObject(kc.getCurrentContext())?.namespace ?? 'default';
  }
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const discovery = kc.makeApiClient(k8s.DiscoveryV1Api);
  const watcher = new k8s.Watch(kc);
  const api: KubeApi = {
    async list(kind, ns, labelSelector) {
      const list = kind === 'services' ? await core.listNamespacedService({ namespace: ns, labelSelector }) : await discovery.listNamespacedEndpointSlice({ namespace: ns, labelSelector });
      return { resourceVersion: list.metadata?.resourceVersion ?? '', items: list.items as KubeObject[] };
    },
    watch(kind, ns, labelSelector, resourceVersion, onEvent, signal) {
      const path = kind === 'services' ? `/api/v1/namespaces/${ns}/services` : `/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices`;
      return new Promise((resolve, reject) => {
        let controller: AbortController | undefined;
        const stop = () => controller?.abort();
        signal.addEventListener('abort', stop, { once: true });
        const query = { labelSelector, resourceVersion: resourceVersion || undefined, allowWatchBookmarks: true, timeoutSeconds: WATCH_TIMEOUT_SECONDS };
        watcher
          .watch(path, query, (type, object) => onEvent({ type, object }), (error: { name?: string } | null) => {
            signal.removeEventListener('abort', stop);
            // client-node aborts every watch request after 30 s: a timeout is an ordinary end, like the server closing it.
            if (!error || signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') resolve();
            else reject(error);
          })
          .then((c) => {
            controller = c;
            if (signal.aborted) c.abort();
          }, reject);
      });
    },
  };
  return { api, namespace, context: kc.getCurrentContext() };
}

/** Starts discovery from the environment once per process (bootstrap.ts calls it with LANDFLOW_PLUGIN_DISCOVERY=kubernetes). */
export function startKubernetesDiscovery(): Promise<KubernetesDiscovery | undefined> {
  return singleton('kubernetes-discovery', async () => {
    const notify = (message: string, level: 'info' | 'warn') => {
      logger[level](message, { 'landflow.discovery.source': 'kubernetes' });
      if (level === 'warn') bus.publish({ channel: 'registry', event: { type: 'plugin.error', endpoint: 'kubernetes', message } });
    };
    try {
      const { api, namespace, context } = await kubeApiFromEnv();
      const namespaces = parseNamespaces(process.env.LANDFLOW_K8S_NAMESPACES, namespace);
      const address = process.env.LANDFLOW_K8S_ADDRESS === 'cluster-ip' ? 'cluster-ip' : 'dns';
      const resyncSeconds = Number(process.env.LANDFLOW_K8S_RESYNC_SECONDS ?? 300);
      const discovery = new KubernetesDiscovery({
        api,
        namespaces,
        target: registryTarget(),
        address,
        ...(process.env.LANDFLOW_K8S_CLUSTER_DOMAIN && { clusterDomain: process.env.LANDFLOW_K8S_CLUSTER_DOMAIN }),
        ...(process.env.LANDFLOW_K8S_LABEL_SELECTOR && { labelSelector: process.env.LANDFLOW_K8S_LABEL_SELECTOR }),
        resyncMs: Number.isFinite(resyncSeconds) ? resyncSeconds * 1000 : 300_000,
        notify,
      });
      discovery.start();
      logger.info('Kubernetes plugin discovery started', { 'k8s.context': context, 'k8s.namespaces': namespaces.join(','), 'k8s.address': address });
      return discovery;
    } catch (error) {
      notify(`Kubernetes discovery not started: ${(error as Error).message}`, 'warn');
      return undefined;
    }
  });
}
