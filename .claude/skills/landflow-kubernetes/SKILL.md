---
name: landflow-kubernetes
description: "Deploys, changes and debugs Landflow on Kubernetes (kustomize): pick an overlay, enable or add a component, add a new plugin as a Deployment and Service the host discovers, build and load images, apply, roll out, check the pods and the Plugins page, read logs, fix ErrImageNeverPull or a plugin that stays offline. Use when asked to run Landflow on Kubernetes or OrbStack, deploy a plugin to the cluster, add a component or overlay under deploy/k8s, set up queue mode, brokers, Ingress or telemetry in the cluster, or find out why a pod or plugin is not working."
---

# Landflow on Kubernetes

Local only: the OrbStack cluster (context `orbstack`), namespace `landflow-dev`, images built on this machine. Follow
the safety rules at the end before you run anything.

## 0. Where am I?

- If `docs/platform/kubernetes.md` and `deploy/k8s/` exist in this repository, read the local files.
- Otherwise you are in another repository that builds on Landflow. Fetch these from
  `https://github.com/landfalls-ai/landflow/blob/main/<path>`: `docs/platform/kubernetes.md` (the map and the component
  table), `docs/deployment.md` (the section "Kubernetes"), and, for a new plugin, `deploy/k8s/base/plugins/text-toolkit.yaml`.
  Copy manifests from there into your repository; do not assume a path of yours matches.

Read `docs/platform/kubernetes.md` first: it names every component, port and overlay. The step-by-step with every
check is `docs/deployment.md`, "Kubernetes". Do not repeat them here; use them.

## 1. Check the target before anything else

```bash
kubectl config current-context                  # not `orbstack`? use --context orbstack on every command, or stop
kubectl --context orbstack get ns landflow-dev  # the namespace may not exist yet: the overlay creates it
docker --context orbstack buildx ls             # use the builder named `orbstack`, never a shared one
```

If the cluster is not OrbStack's, stop and ask. Do not deploy anywhere else.

## 2. Pick the overlay

Render first, it applies nothing: `kubectl kustomize deploy/k8s/overlays/<name> | less`.

| You want | Overlay |
|---|---|
| the whole local Landflow (host, 20 plugins, code runner, Mailpit) | `orbstack` |
| Kafka, RabbitMQ, NATS, Valkey and broker faces on the plugins | `orbstack-brokers` |
| queue mode: two mains, two workers, Postgres, Valkey, MinIO | `orbstack-queue` |
| telemetry to Clickland (needs Clickland running in `clickland-dev`) | `orbstack-clickland` |
| telemetry in a local Grafana stack | `orbstack-observability` |
| plugins in other namespaces | `orbstack-cluster-wide` |
| an Ingress or Gateway API route (needs a Traefik in `landflow-ingress`) | `orbstack-ingress`, `orbstack-gateway-api` |

Overlays stack on `orbstack`, not on each other. Moving to a smaller overlay does not delete what the bigger one made:
each overlay's header comment lists what to delete.

## 3. Build the images

The build context is the repository root. Never push; OrbStack's cluster uses the local engine's images.

```bash
docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/host.Dockerfile -t landflow/host:k8s-dev .
# plugin: node-plugin.Dockerfile, go-plugin.Dockerfile or python-plugin.Dockerfile; ports from the table in docs/platform/kubernetes.md
docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/node-plugin.Dockerfile \
  --build-arg PLUGIN=<name> --build-arg HTTP_PORT=<71xx> --build-arg GRPC_PORT=<72xx> -t landflow/plugin-<name>:k8s-dev .
# the browser plugin has its own Dockerfile: -f plugins/browser/Dockerfile (the comment in components/browser/browser.yaml has the line)
docker --context orbstack buildx build --builder orbstack --load -f deploy/docker/code-runner.Dockerfile -t landflow/code-runner:k8s-dev .
docker --context orbstack images 'landflow/*'   # check the tag is there
```

Every manifest comment in `deploy/k8s/components/*/` carries the exact build line for its image: copy it.

## 4. Apply and roll out

```bash
kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack
kubectl --context orbstack -n landflow-dev rollout status deploy --timeout=180s
kubectl --context orbstack -n landflow-dev get deploy,svc
```

- A rebuilt image under the same `:k8s-dev` tag does not change the manifest, so `apply` does nothing. Restart:
  `kubectl --context orbstack -n landflow-dev rollout restart deploy/<name>`.
- The host needs up to five minutes to start (the startup probe allows it). Wait before calling it broken.
- Landflow is at http://localhost:53000 and Mailpit at http://localhost:58025 (the `local-access` component). Those
  ports clash with the Compose stack: run one at a time. Owner: `owner@landflow.test` / `landflow-dev-only`.
- To start with an empty database: scale `deploy/landflow-host` to 0, delete the PVC `landflow-data`, apply again.
  Ask the person first: it deletes workflows and credentials.

## 5. Enable a component

1. Read its `kustomization.yaml` header: it says what to build, what it needs (for example `queue-mode` needs
   `postgres`, `valkey` and `minio`) and what it patches on the host.
2. Add `- ../../components/<name>` under `components:` in a copy of an overlay, or use the overlay that already does.
3. Render, compare with the plain overlay (`diff <(kubectl kustomize A) <(kubectl kustomize B)`), then apply.
4. A component's patch only reaches objects already in the build: list a component that adds a Deployment before the
   one that patches every Deployment (see `overlays/orbstack-clickland`).

## 6. Add a plugin

Model: `deploy/k8s/base/plugins/text-toolkit.yaml` (Node), `go-crypto.yaml` (Go), `py-insights.yaml` (Python). The
plugin itself is built first with an SDK: see `docs/plugins.md` and the SDK skills of this plugin.

1. Pick the next free ports: HTTP `71xx`, gRPC `72xx` (7121 and 7221 are the last ones used, by grafana: start at 7122 and 7222).
2. Create `deploy/k8s/components/<name>/<name>.yaml` (a Deployment and a Service) and `kustomization.yaml`
   (`kind: Component`, `resources: [<name>.yaml]`). Copy the model and keep these, because the host depends on them:
   - Service label `landflow.dev/plugin: "true"` and annotation `landflow.dev/grpc-port: grpc`; the Service port named
     `grpc` (`appProtocol: grpc`) and one named `http`.
   - env `LANDFLOW_REGISTRY_URL=off` (discovered, so no announcing) and `LANDFLOW_REGISTRY_SECRET` from Secret
     `landflow-registry` key `secret` (the host refuses a plugin that cannot prove it).
   - labels `app.kubernetes.io/part-of: landflow` and `component: plugin` (the overlay's image-policy patch and the
     broker patches select on them).
   - readiness and liveness on `GET /landflow/v1/health` (the host follows readiness through EndpointSlices).
   - `runAsUser` 1000 for Node images, 10001 for Go and Python; read-only root filesystem with a `/tmp` `emptyDir`.
   - resources: requests 20m and 160Mi, limit 512Mi for Node and Python plugins; Go plugins use 96Mi and 256Mi (`go-crypto.yaml`); more only if the plugin needs it, as the browser does.
3. In the overlay: add `- ../../components/<name>` to `components:` and `- { name: landflow/plugin-<name>, newTag: k8s-dev }`
   to `images:` (the overlay's `imagePullPolicy: Never` patch covers every Deployment labelled `part-of=landflow`).
4. Build the image (step 3), render, apply. No host change is needed: discovery finds it.
5. Check (step 7). A plugin in a namespace other than the host's needs `LANDFLOW_K8S_NAMESPACES` and a Role there, or
   the `orbstack-cluster-wide` overlay.
6. Document it: the table in `docs/platform/kubernetes.md`, `docs/deployment.md` if the steps differ, and a history
   fragment in `docs/history.d/` (never `docs/history.md`; see `docs/development.md#history-fragments`).

## 7. Check health

```bash
kubectl --context orbstack -n landflow-dev get pods                                  # all Ready; workers may restart 2-3 times while Postgres starts
kubectl --context orbstack -n landflow-dev get svc -l landflow.dev/plugin=true       # what discovery sees
kubectl --context orbstack -n landflow-dev get endpointslices -l kubernetes.io/service-name=plugin-<name>   # a ready address
curl -s http://localhost:53000/api/health/ready
curl -s http://plugin-<name>.landflow-dev.svc.cluster.local:<71xx>/landflow/v1/health    # OrbStack resolves cluster names on the Mac
```

Then open the Plugins page: the plugin should show online, source `kubernetes`, namespace
`landflow-dev`, its nodes listed.

## 8. Read logs and fix the usual failures

```bash
kubectl --context orbstack -n landflow-dev logs deploy/landflow-host -c host --tail=200
kubectl --context orbstack -n landflow-dev logs deploy/plugin-<name> --tail=100
kubectl --context orbstack -n landflow-dev describe pod <pod>      # events: image pulls, probe failures
```

| Symptom | Cause and fix |
|---|---|
| `ErrImageNeverPull` | the image tag is not in OrbStack's engine: build it (step 3), check `docker images` |
| plugin not on the Plugins page | the Service lacks the label or a `grpc` port, or no ready pod; host log has `landflow.discovery.source=kubernetes` lines saying why |
| "did not prove the registry secret" | the plugin lacks `LANDFLOW_REGISTRY_SECRET` or has another value; compare the Secret and both Deployments |
| `services is forbidden` in the Plugins page feed | the Role or RoleBinding is missing in that namespace |
| plugin pods Ready but offline | the host cannot reach the pod: check NetworkPolicies and the port numbers |
| `runAsNonRoot` error | set `runAsUser` (1000 Node, 10001 Go and Python) |
| host restarted mid-build with a big Ollama model | the overlay's liveness allows 5 minutes; Spotlight on a 30B model can still starve the Mac |
| an agent's Ollama model cannot connect | its Server URL is `http://127.0.0.1:11434`, the pod itself; use `http://host.docker.internal:11434` |
| broker faces missing after editing `landflow-transport` | `kubectl ... rollout restart deploy -l app.kubernetes.io/component=plugin` (env is read at start) |

More in `docs/deployment.md`, "Troubleshooting". Do not look for the cause by deleting pods in a loop: read the events
and logs first.

## 9. Secrets

Use only the development values already in the repository (`deploy/.env.example` and the overlays' `secretGenerator`).
Never write a real token, key or password into a manifest, a ConfigMap or a commit. For a real deployment the person
supplies Secrets outside Git (`landflow-host`, `landflow-registry`, `landflow-external`); say so and stop: the repository
has no production overlay and you must not deploy one.

## Safety rules

- Context `orbstack` only; write `--context orbstack` and `-n landflow-dev` on every `kubectl` command. Never run
  against another context, and never deploy to a cloud.
- Never push an image or run `docker push`. Build with `--builder orbstack --load`.
- Touch only the Landflow namespace (`landflow-dev`, plus `landflow-ingress` for a Traefik you were asked for) and
  `landflow-*` Docker Compose projects. Other projects share this engine: do not stop, delete or prune their containers,
  images, volumes or namespaces. Never run `docker system prune`, `kubectl delete ns`, or `kubectl delete` with `--all`.
- Do not hand-edit the live database or `apps/web/.data`. Deleting the PVC `landflow-data` erases workflows and
  credentials: ask first.
- Render with `kubectl kustomize` before you apply, and say what you will change.
- Development credentials only. AWS calls, if a flow makes any, go to LocalStack on `http://127.0.0.1:54566` with dummy
  keys.
