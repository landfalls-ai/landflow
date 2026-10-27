/**
 * Kubernetes plugin discovery against a real cluster: LANDFLOW_INTEGRATION=k8s. Deploys the Go crypto plugin
 * (landflow/plugin-go-crypto:k8s-dev, a local image) into LANDFLOW_K8S_IT_NAMESPACE (default landflow-dev) of kube
 * context LANDFLOW_K8S_IT_CONTEXT (default orbstack; always set explicitly, never the kubeconfig's current one), and
 * runs discovery from this process with the real registry:
 *
 * - a pod with the wrong LANDFLOW_REGISTRY_SECRET is ready but not registered (no valid proof);
 * - with the right secret (a rollout) it is discovered and its node runs over gRPC;
 * - scaled to 0 it goes offline (nodes kept, unavailable); scaled back to 1 it is online and callable again;
 * - scaled to 2, its calls are spread over both pods (each pod's log shows its share of the runs), the manifest is not
 *   pulled per pod, and scaled back to 1 the gone pod gets no more calls;
 * - deleting the Service removes it.
 *
 * Needs the image built locally (docs/deployment.md, "Kubernetes") and the namespace. Everything it creates is labelled
 * with a run id, discovery only looks at that run's Services, and afterAll deletes them.
 *
 *   (cd apps/web && LANDFLOW_INTEGRATION=k8s npx vitest run test/kubernetes.integration.test.ts)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';

const enabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').some((s) => ['k8s', 'all'].includes(s.trim()));
const CONTEXT = process.env.LANDFLOW_K8S_IT_CONTEXT ?? 'orbstack';
const NAMESPACE = process.env.LANDFLOW_K8S_IT_NAMESPACE ?? 'landflow-dev';
const IMAGE = process.env.LANDFLOW_K8S_IT_IMAGE ?? 'landflow/plugin-go-crypto:k8s-dev';
const RUN = `it${Date.now().toString(36)}`;
const NAME = `go-crypto-${RUN}`;
const SECRET = `registry-${RUN}`;
const ENDPOINT = `grpc://${NAME}.${NAMESPACE}.svc.cluster.local:7203`;

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

type K8s = typeof import('@kubernetes/client-node');
type Discovery = import('@/lib/server/plugins/kubernetes').KubernetesDiscovery;
type Registry = (typeof import('@/lib/server/plugins/registry'))['registry'];

describe.skipIf(!enabled)(`Kubernetes discovery on ${CONTEXT}/${NAMESPACE}`, () => {
  // Set up in beforeAll: a skipped suite's body still runs at collection time.
  let apps: InstanceType<K8s['AppsV1Api']>;
  let core: InstanceType<K8s['CoreV1Api']>;
  let mergePatch: ReturnType<K8s['setHeaderOptions']>;
  let registry: Registry;
  let discovery: Discovery | undefined;

  const deployment = (secret: string, replicas: number) => ({
    metadata: { name: NAME, labels: { 'app.kubernetes.io/name': NAME, 'landflow.dev/test-run': RUN } },
    spec: {
      replicas,
      selector: { matchLabels: { 'app.kubernetes.io/name': NAME } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': NAME, 'landflow.dev/test-run': RUN } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'plugin',
              image: IMAGE,
              imagePullPolicy: 'Never',
              ports: [{ name: 'http', containerPort: 7103 }, { name: 'rpc', containerPort: 7203 }],
              env: [{ name: 'LANDFLOW_REGISTRY_URL', value: 'off' }, { name: 'LANDFLOW_REGISTRY_SECRET', value: secret }],
              readinessProbe: { httpGet: { path: '/landflow/v1/health', port: 'http' }, periodSeconds: 1, failureThreshold: 1 },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            },
          ],
        },
      },
    },
  });

  const readyReplicas = async () => (await apps.readNamespacedDeployment({ name: NAME, namespace: NAMESPACE })).status?.readyReplicas ?? 0;
  const status = () => registry.endpointStatus(ENDPOINT);
  const plugin = () => registry.list().find((p) => p.endpoints.some((e) => e.endpoint === ENDPOINT));
  const encode = async (value: string) => {
    const resolved = registry.resolve('go-crypto.base64');
    if ('error' in resolved) throw new Error(resolved.error);
    const request: ExecuteRequest = {
      protocol: 'landflow.plugin/v1',
      executionId: `ex_${RUN}`,
      mode: 'manual',
      node: { id: 'n1', name: 'Base64', type: 'go-crypto.base64', typeVersion: 1 },
      parameters: { operation: 'encode', field: 'value' },
      itemParameters: [{ operation: 'encode', field: 'value' }],
      inputs: [[{ json: { value } }]],
    };
    return (await resolved.execute(request)).outputs[0]?.[0]?.json.value;
  };

  beforeAll(async () => {
    Object.assign(process.env, { LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_REGISTRY_SECRET: SECRET });
    const k8s = await import('@kubernetes/client-node');
    const { KubernetesDiscovery, kubeApiFromEnv, registryTarget } = await import('@/lib/server/plugins/kubernetes');
    ({ registry } = await import('@/lib/server/plugins/registry'));
    // The context is always explicit: never the kubeconfig's current one.
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    kc.setCurrentContext(CONTEXT);
    apps = kc.makeApiClient(k8s.AppsV1Api);
    core = kc.makeApiClient(k8s.CoreV1Api);
    mergePatch = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch);
    await core.readNamespace({ name: NAMESPACE });
    await apps.createNamespacedDeployment({ namespace: NAMESPACE, body: deployment('not-the-host-secret', 1) });
    await core.createNamespacedService({
      namespace: NAMESPACE,
      body: {
        metadata: { name: NAME, labels: { 'landflow.dev/plugin': 'true', 'landflow.dev/test-run': RUN }, annotations: { 'landflow.dev/grpc-port': 'rpc' } },
        spec: { selector: { 'app.kubernetes.io/name': NAME }, ports: [{ name: 'rpc', port: 7203, targetPort: 'rpc' }] },
      },
    });
    const { api } = await kubeApiFromEnv({ ...process.env, LANDFLOW_K8S_CONTEXT: CONTEXT, KUBERNETES_SERVICE_HOST: '' });
    discovery = new KubernetesDiscovery({
      api,
      namespaces: [NAMESPACE],
      target: registryTarget(),
      labelSelector: `landflow.dev/plugin=true,landflow.dev/test-run=${RUN}`,
      debounceMs: 100,
      backoff: { initialMs: 250, maxMs: 2_000 },
      resyncMs: 30_000,
    });
    discovery.start();
  });

  afterAll(async () => {
    discovery?.stop();
    await core.deleteNamespacedService({ name: NAME, namespace: NAMESPACE }).catch(() => {});
    await apps.deleteNamespacedDeployment({ name: NAME, namespace: NAMESPACE, propagationPolicy: 'Foreground' }).catch(() => {});
    registry?.removeEndpoint(ENDPOINT);
    delete process.env.LANDFLOW_REGISTRY_SECRET;
  });

  it('does not register a ready pod that cannot prove the registry secret', async () => {
    await vi.waitFor(async () => expect(await readyReplicas()).toBe(1), { timeout: 60_000, interval: 500 });
    await vi.waitFor(() => expect(discovery!.snapshot()).toEqual([expect.objectContaining({ service: `${NAMESPACE}/${NAME}`, ready: true, registered: [] })]), { timeout: 20_000, interval: 250 });
    // Several attempts (with backoff) fail on the proof.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(status()).toBeUndefined();
  });

  it('discovers the plugin once its pods hold the secret, and runs its node over gRPC', async () => {
    await apps.patchNamespacedDeployment({ name: NAME, namespace: NAMESPACE, body: deployment(SECRET, 1) }, mergePatch);
    await vi.waitFor(() => expect(status()).toBe('online'), { timeout: 90_000, interval: 250 });
    expect(plugin()).toMatchObject({ id: 'go-crypto', source: 'kubernetes', status: 'online', endpoints: [{ endpoint: ENDPOINT, transport: 'grpc', origin: { namespace: NAMESPACE, service: NAME } }] });
    expect(await encode('landflow')).toBe('bGFuZGZsb3c=');
  });

  it('goes offline when scaled to 0, keeping its nodes, and is callable again when scaled back up', async () => {
    await apps.patchNamespacedDeployment({ name: NAME, namespace: NAMESPACE, body: { spec: { replicas: 0 } } }, mergePatch);
    await vi.waitFor(() => expect(status()).toBe('offline'), { timeout: 60_000, interval: 250 });
    expect(plugin()).toMatchObject({ status: 'offline', endpoints: [{ lastError: `no ready pod behind Service ${NAMESPACE}/${NAME}` }] });
    expect(registry.nodeTypes().find((t) => t.type === 'go-crypto.base64')).toMatchObject({ available: false });
    expect(registry.resolve('go-crypto.base64')).toMatchObject({ error: expect.stringContaining('offline') });

    await apps.patchNamespacedDeployment({ name: NAME, namespace: NAMESPACE, body: { spec: { replicas: 1 } } }, mergePatch);
    await vi.waitFor(() => expect(status()).toBe('online'), { timeout: 90_000, interval: 250 });
    expect(await encode('k8s')).toBe('azhz');
  });

  it('spreads calls over its ready pods when scaled to 2, and drops the pod that goes when scaled back to 1', async () => {
    const backends = () => registry.endpointBackends(ENDPOINT);
    await apps.patchNamespacedDeployment({ name: NAME, namespace: NAMESPACE, body: { spec: { replicas: 2 } } }, mergePatch);
    await vi.waitFor(async () => expect(await readyReplicas()).toBe(2), { timeout: 90_000, interval: 500 });
    await vi.waitFor(() => expect(backends()).toHaveLength(2), { timeout: 30_000, interval: 250 });
    await vi.waitFor(() => expect(status()).toBe('online'), { timeout: 30_000, interval: 250 });

    const resolved = registry.resolve('go-crypto.hash');
    if ('error' in resolved) throw new Error(resolved.error);
    const ids = Array.from({ length: 8 }, (_, i) => `ex_${RUN}_spread_${i}`);
    const before = new Map(backends().map((b) => [b.endpoint, b.calls]));
    for (const executionId of ids) {
      const parameters = { algorithm: 'sha256', field: 'value', encoding: 'hex', outputField: 'hash' };
      const request: ExecuteRequest = { protocol: 'landflow.plugin/v1', executionId, mode: 'manual', node: { id: 'n2', name: 'Hash', type: 'go-crypto.hash', typeVersion: 1 }, parameters, itemParameters: [parameters], inputs: [[{ json: { value: executionId } }]] };
      expect((await resolved.execute(request)).outputs[0]?.[0]?.json.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // One after the other: round robin, four each.
    expect(backends().map((b) => b.calls - (before.get(b.endpoint) ?? 0))).toEqual([4, 4]);
    // Each pod's log shows the runs it served.
    // (Pods of the earlier rollout may still be terminating: only the two the calls went to.)
    const pods = (await core.listNamespacedPod({ namespace: NAMESPACE, labelSelector: `app.kubernetes.io/name=${NAME}` })).items.filter((pod) =>
      backends().some((b) => pod.status?.podIP && b.endpoint === `grpc://${pod.status.podIP}:7203`),
    );
    expect(pods).toHaveLength(2);
    const served = await Promise.all(pods.map(async (pod) => {
      const log = await core.readNamespacedPodLog({ name: pod.metadata!.name!, namespace: NAMESPACE });
      return ids.filter((id) => log.includes(id));
    }));
    expect(served.map((list) => list.length)).toEqual([4, 4]);
    expect(new Set(served.flat())).toEqual(new Set(ids));

    await apps.patchNamespacedDeployment({ name: NAME, namespace: NAMESPACE, body: { spec: { replicas: 1 } } }, mergePatch);
    await vi.waitFor(() => expect(backends()).toHaveLength(1), { timeout: 60_000, interval: 250 });
    expect(await encode('one')).toBe('b25l');
    expect(status()).toBe('online');
  });

  it('removes the plugin when its Service is deleted', async () => {
    await core.deleteNamespacedService({ name: NAME, namespace: NAMESPACE });
    await vi.waitFor(() => expect(plugin()).toBeUndefined(), { timeout: 30_000, interval: 250 });
    expect(registry.nodeTypes().some((t) => t.type === 'go-crypto.base64')).toBe(false);
  });
});
