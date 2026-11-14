# Durable local telemetry: a PVC, retention, and the first-increment gap

## Problem

[limitations.md](../limitations.md), "Local telemetry stack": `landflow-lgtm` keeps everything in an `emptyDir`
(`deploy/k8s/components/observability/lgtm.yaml`, volume `data`, `sizeLimit: 4Gi`), so a restart loses every trace,
metric and log; and the dashboard's totals use `increase()`, which cannot see the first increment of a new series, so
after a host restart the first run, approval or call of each kind is missing from the stat panels
(`agent-runs.json`: `sum(increase(landflow_agent_runs_total[$__range]))` and five siblings, plus the per-tool tables
at lines ~403/453 and the token panels at ~582/591). See [deployment.md](../deployment.md#telemetry-on-kubernetes).

## Goals / Non-goals

Goals:
- Traces, metrics and logs survive a pod restart on the OrbStack cluster, with a bounded size and age.
- Stat panels count the first increment of a series.
- Still one command: `kubectl --context orbstack apply -k deploy/k8s/overlays/orbstack-observability`.

Non-goals:
- Production-grade observability (HA, object storage, multi-tenant Mimir/Tempo). The component stays "for development only".
- Changing what the host exports (`apps/web/src/lib/server/telemetry/metrics.ts` counters such as `landflow.agent.runs`).
- Cloud storage classes; use the cluster's default (OrbStack's local-path style) class only. Nothing is pushed anywhere.

## Design

**PVC.** Follow the pattern in `deploy/k8s/components/package-cache/athens.yaml` (a `PersistentVolumeClaim`
`landflow-cache-go`, `ReadWriteOnce`, `requests.storage: 5Gi`). In `lgtm.yaml` add a PVC `landflow-lgtm-data`
(10Gi, labels `app.kubernetes.io/part-of: landflow-observability`) and replace the `data` volume's `emptyDir` with
`persistentVolumeClaim: { claimName: landflow-lgtm-data }`. The Deployment keeps `strategy: Recreate`, which is right
for an RWO volume. `/data` is where grafana/otel-lgtm 0.39.0 keeps Prometheus, Tempo, Loki, Pyroscope and Grafana state
(verify the subdirectories by `kubectl exec ... ls /data` in step 1). The Grafana database and any dashboard edits then
survive too; the provisioned dashboard still comes from the ConfigMap `landflow-grafana-dashboards`.

**Opt out.** The old behaviour stays one patch away: a second kustomize Component
`deploy/k8s/components/observability-ephemeral` (new) that patches the volume back to `emptyDir`, for people who want
a throwaway stack. Default for the `orbstack-observability` overlay is durable.

**Retention.** Bound the PVC with per-signal retention, set through env on the `lgtm` container (names to verify
against the image's run scripts in step 1, since 0.39.0 may hard-code some):
- Prometheus: `--storage.tsdb.retention.time` and `--storage.tsdb.retention.size` (the image's `run-prometheus.sh`);
  target 15d / 3GB.
- Tempo: `compactor.compaction.block_retention` (target 72h).
- Loki: `limits_config.retention_period` with the compactor on (target 168h).
If the image lacks env hooks, mount override config files from a new ConfigMap generator entry in
`components/observability/kustomization.yaml`, the way `otelcol-config.yaml` is already mounted with `subPath`.
The Collector config (`otelcol-config.yaml`) is untouched.

**Recording rule for the first increment.** Cause: Prometheus `increase()` needs two samples in the range; a counter
that first appears with value N (after a host restart the OTel SDK starts the cumulative series again; with
`delta_to_cumulative` in the metrics pipeline the first delta becomes the series' first sample) has no previous sample.
Options, in order of preference:
1. Do the fix in the pipeline: before export, have the Collector emit an initial zero sample. Not available as a stock
   processor, so skip.
2. A **recording rule** in Prometheus: `landflow:agent_runs:increase` defined with an `or` against the raw counter at
   the range start, e.g. `increase(m[$r]) + (m unless m offset $r)`, i.e. add the counter's value where the series did
   not exist at the start of the range. A rule cannot take `$__range`, so panels keep the expression but use a small
   helper form instead; recording rules fit fixed windows (5m, 1h, 1d) and the dashboard picks by range.
3. In the host: create each counter's known label sets at zero at boot (`telemetry/metrics.ts`), so the first real
   increment is a second sample. Covers only low-cardinality labels; tool names are unbounded.
Recommended: panel expression `sum(increase(m[$__range]) or (m unless m offset $__range))` for the stat panels
(no rule needed for single-number tiles), plus recording rules for the 1h and 1d windows used by alerting later.
Rules need Prometheus's `rule_files`; mount a `landflow-rules.yaml` from a ConfigMap into the image's Prometheus config
directory (path to verify; if the image offers no rule hook, use Grafana-managed recording rules instead).

## Implementation plan

1. Inspect the running 0.39.0 pod (read-only `kubectl --context orbstack -n landflow-dev exec`) for `/data` layout and Prometheus/Tempo/Loki flags. Output: notes in the history row.
2. PVC + volume swap in `lgtm.yaml`. Test: apply the overlay, run an agent, `kubectl rollout restart deploy/landflow-lgtm`, confirm the trace and the dashboard totals persist (script under `deploy/scripts/`, extending the existing smoke style).
3. Ephemeral Component and README note in `deploy/README.md`. Test: `kubectl kustomize` of both overlays renders (a check in whatever script validates kustomize today, `docs/development.md` lists them).
4. Retention settings (env or mounted config). Test: set a 1h Tempo retention in a scratch run and confirm blocks are removed; document defaults.
5. First-increment fix in `agent-runs.json` (all `increase()` stat/table panels), with the `unless ... offset` form. Test: PromQL against a synthetic series via Prometheus's API (`/api/v1/query`) after restarting the host once; stat equals the real run count.
6. Rules ConfigMap for 1h/1d recording rules (only if step 1 found a hook).

## Docs to update

`docs/deployment.md#telemetry-on-kubernetes` (replace "storage is an emptyDir" with the PVC, retention, how to wipe it:
delete the PVC `landflow-lgtm-data`; the "Back to the plain overlay" paragraph must also delete the PVC),
`docs/limitations.md` (remove both clauses of the Local telemetry stack line), `docs/roadmap.md`, `docs/history.md`,
`deploy/README.md` if it lists components.

## Risks and open questions

- Does `grafana/otel-lgtm:0.39.0` expose retention knobs? If not, config overrides risk breaking on image bumps.
- RWO PVC with `Recreate` means a few seconds of gap in OTLP export on restart; exporters retry, acceptable locally.
- Disk fill on the Docker VM shared with other projects (CLAUDE.md: do not prune): keep the PVC small and size-bounded.
- `unless ... offset` inflates a series that existed before the range but had a restart reset inside it? Check with a reset test; `increase()` already handles resets.
- Kubernetes-only: the Compose stack (`deploy/compose*.yml`) has no LGTM; out of scope.

## Effort and first slice

**S to M.** First slice: the PVC and volume swap (step 2), which closes the "restart loses it" half. The
`increase()` panel fix (step 5) is the second small, independent slice.
