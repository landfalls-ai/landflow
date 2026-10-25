# Developer-first and open-source workflow platforms and durable-execution engines (state as of 2026-10-25), with Landflow feature gaps

Scope: Temporal, Inngest, Trigger.dev, Restate, Hatchet (durable-execution engines); Windmill, Pipedream, Activepieces, Node-RED, Kestra (workflow platforms); n8n queue mode is a reference point. A Landflow comparison and gap matrix is in the last section.

Status flags to read first (details and sources are in the sections below):
- **Pipedream Workflows is being discontinued.** It shuts down on 2027-03-31. Workday agreed to acquire Pipedream in November 2025. Pipedream is no longer a viable reference product, but its design patterns are still instructive.
- **Kestra 2.0** shipped on 2026-09-08. It rewrites the engine and makes breaking DSL changes: ForEach, `pluginDefaults` and trigger `conditions` are removed.
- **Temporal Worker Versioning** reached GA on 2026-03-30. The older Version Sets and Assignment Rules have been removed.
- **Node-RED 5.0** shipped in June 2026. It requires Node.js 22.9 or later and drops 32-bit ARM.
- **Trigger.dev v3** is end-of-life. `queue.concurrencyLimit` is deprecated in favour of the `concurrency` option.
- **Windmill's low-code app editor** is now marked "legacy", in favour of full-code React or Svelte apps.

---

## 1. Durable execution: how do Temporal, Inngest, Trigger.dev, Restate and Hatchet persist step state, retry, sleep for days, wait for events or signals, version running workflows, and handle idempotency and exactly-once side effects?

### Takeaway
Every engine stores a record of each completed step outside the worker. After a crash it resumes by skipping or replaying the completed steps. The mechanisms differ:

| Engine | How state is persisted and resumed |
|---|---|
| Temporal | Full Event History plus deterministic replay of workflow code |
| Inngest, Hatchet, Windmill workflows-as-code | Step results memoized by step ID or checkpoint |
| Restate | A journal kept in a Rust, log-based server |
| Trigger.dev | CRIU process snapshot and restore, plus cached subtask results |

Versioning of in-flight runs also differs:
- **Pin the run** to the version it started on: Trigger.dev, Windmill, Restate, Temporal "Pinned".
- **Match steps by step ID**: Inngest.
- **Explicit patch markers**: Temporal "Auto-Upgrade".

No engine promises exactly-once external side effects. All of them tell users to make steps idempotent and to pass stable keys.

### Cited Findings

#### Temporal (event history + deterministic replay)
- The Event History is "a complete, ordered record of everything that happened in a Workflow Execution". The History Service persists it to Cassandra, MySQL, PostgreSQL or SQLite, with Elasticsearch optional for advanced Visibility. — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- Workflow code "must be deterministic because Temporal reruns it to rebuild state after a failure". A new Worker fetches the history and replays the code against it. Side effects belong in Activities. — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- Activities are supervised through configuration rather than custom code: a Retry Policy, timeouts and optional heartbeats. A failed Activity retries with backoff. An Activity whose Worker dies is rescheduled. — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- A Workflow "runs to completion, whether that takes a second or a year". Durable Timers can wait "for minutes or months". — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- Running Workflows can receive Signals and Updates and answer Queries. Large processes can be split into Child Workflows. — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- There are 8 SDKs: .NET, Go, Java, PHP, Python, Ruby, Rust and TypeScript, and workflows in different languages can call each other. Workers always run in the user's own infrastructure, including with Temporal Cloud. — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)
- **Worker Versioning** groups Workers into a Worker Deployment. Each release is a Deployment Version, identified by deployment name plus Build ID. Each Workflow type gets one of two behaviours:
  - **Pinned**: "guaranteed to complete on a single Worker Deployment Version". A running Pinned workflow can be moved with `temporal workflow update-options`.
  - **Auto-Upgrade**: the workflow moves to the latest version, and the user must keep it replay-safe with patching.
  
  Versions can be ramped by percentage (0–100) and pass through Inactive → Active → Draining → Drained. — [Temporal: Worker Versioning](https://docs.temporal.io/worker-versioning)
- **Patching** works like a feature flag. On first execution `patched()` writes a marker into history. On replay it returns `false` if no marker exists. A patch placed earlier in the code than its recorded marker causes a non-determinism error. — [Temporal: Patching](https://docs.temporal.io/patching)
- Worker Versioning went GA on 2026-03-30, with Upgrade on Continue-as-New and Worker Controller Autoscaling in Public Preview. — [Temporal Feature Changelog](https://temporal.io/changelog/type/feature) (seen via search summary)
- A third-party release tracker says Version Sets and Assignment Rules (the older Build-ID versioning) are removed in the current server line. — [releases.sh Temporal overview](https://releases.sh/temporal/overview) (third-party; treat the older approach as deprecated)
- 2026 GA and preview items:

  | Date (2026) | Item | Status |
  |---|---|---|
  | May 4 | Worker Controller for Kubernetes | GA |
  | May 5 | Task Queue Priority & Fairness | GA |
  | May 14 | External Storage for large payloads (Go and Python) | Public preview |
  | Aug 3 | Serverless Workers on AWS Lambda | Public preview |
  | Sep 4 | Rust SDK | GA |
  | Sep 15 | Standalone Activities in all six SDKs, with durable execution, priority/fairness, start delay and lifecycle controls | GA |
  | Oct 5 | Serverless Workers on Google Cloud Run | Public preview |

  — [Temporal Changelog](https://temporal.io/changelog)
- Standalone Activities support deduplication at submit time. — [Temporal: Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)

#### Inngest (step memoization over HTTP)
- A trigger (event, schedule or webhook) starts a run. Each named step's successful result is stored as a checkpoint. The SDK hashes the step ID to make the state key. On replay it returns saved results instead of re-running callbacks. "Code outside a step can run again each time the handler replays". — [Inngest: How functions are executed](https://www.inngest.com/docs/learn/how-functions-are-executed)
- Run state lives outside the app, so a run can resume on a different machine. In standard orchestration, each step is a separate HTTP request to the app. TypeScript SDK v4 uses in-process checkpointing by default and falls back to per-request orchestration on retries or parallel steps. Python always uses standard orchestration. — [Inngest: How functions are executed](https://www.inngest.com/docs/learn/how-functions-are-executed)
- Each step retries on its own. Completed steps return saved results, so only the failed step runs again. Inngest has no Temporal-style strict replay rules. — [Inngest: How functions are executed](https://www.inngest.com/docs/learn/how-functions-are-executed)
- `step.waitForEvent` takes an event name, an `if` match expression (e.g. `event.data.orderId == async.data.orderId`) and a `timeout`. It returns `null` if nothing matches in time. No compute runs while it waits. — [Inngest: How functions are executed](https://www.inngest.com/docs/learn/how-functions-are-executed)
- Documented limits:
  - `step.sleep` or `sleepUntil`: up to 1 year each.
  - Maximum run length: 30 days (Free), 90 (Pro), 366 (Business). This includes sleep and wait time.
  - 1,000 steps per function; 4 MiB per step return; 32 MiB total run state.
  - Step timeout: up to 2 hours, or less if the host's own timeout is shorter.
  
  — [Inngest: Usage limits](https://www.inngest.com/docs/usage-limits/inngest)
- **Idempotency:**
  - An event `id` deduplicates for 24 hours.
  - A function-level `idempotency` option takes a CEL expression (e.g. `event.data.cartId`) and allows one run per key per 24 hours.
  - "Rate limits and debounce control when work starts; they do not replace an idempotency key for an external effect."
  - For payments and similar effects, send a stable operation key derived from the business event, not a per-attempt ID.
  
  — [Inngest: Handling idempotency](https://www.inngest.com/docs/guides/handling-idempotency)
- **Versioning:** results match by step ID, so "You do not need version markers for compatible changes". Adding a step runs it. Changing a step's ID re-runs it. Removing a step ignores its saved result. Reordering logs a warning. For major rewrites, create a new function ID with mutually exclusive triggers and keep the old one deployed until in-flight runs drain. — [Inngest: Versioning](https://www.inngest.com/docs/learn/versioning)
- 2026 additions, all from aggregators of the Inngest changelog:
  - Durable Endpoints entered public beta in February 2026 for Next.js and Bun. They bring retries and observability to ordinary API handlers.
  - Experiments (A/B testing of step functions) arrived in June 2026, followed by Scoring and a Sessions view.
  - Realtime became first-class in the TS SDK, and the separate `@inngest/realtime` package is deprecated.
  
  — [releasebot.io Inngest](https://releasebot.io/updates/inngest), [releases.sh Inngest highlights](https://releases.sh/inngest/inngest-changelog/highlights) (aggregators)
- Durable Endpoints should last no longer than 60 seconds, and flow control does not apply to them. — [Inngest: How functions are executed](https://www.inngest.com/docs/learn/how-functions-are-executed); [Inngest: Flow control](https://www.inngest.com/docs/guides/flow-control)

#### Trigger.dev (CRIU checkpoint/restore + cached subtasks)
- Trigger.dev is "a serverless architecture (without timeouts!)". When a task waits on a subtask or a long pause, CRIU checkpoints its memory, CPU registers and file descriptors. Resources are released, then the process is restored when the wait ends. A `wait.for` or `wait.until` under 60 seconds does not checkpoint. Waiting time is not billed on Cloud. — [Trigger.dev: How it works](https://trigger.dev/docs/how-it-works)
- Retries restart the task from the beginning, but completed subtasks return cached results. `idempotencyKeys.create()` scopes a key to the run across retries, so only failed subtasks re-execute. — [Trigger.dev: How it works](https://trigger.dev/docs/how-it-works)
- **Waitpoint tokens:**
  - `wait.createToken({timeout, idempotencyKey, idempotencyKeyTTL, tags})` returns an `id`, a callback `url` and a `publicAccessToken`.
  - `wait.forToken()` suspends the run.
  - A token can be completed in four ways: through the SDK (`wait.completeToken`), by HTTP POST with a Bearer token, by a webhook POST to `url` (the body becomes the output), or from the browser using the public token (CORS enabled).
  - The intended uses are approvals and human-in-the-loop steps.
  - `inputStream.wait()` builds on tokens and provides typed streams.
  
  — [Trigger.dev: Wait for token](https://trigger.dev/docs/wait-for-token)
- **Versioning:**
  - Versions look like `20240313.1`, counted per environment.
  - A run locks to the latest version when it starts. Delayed runs lock when they begin executing. Retries stay on the original version.
  - `triggerAndWait` children lock to the parent's version, while fire-and-forget `trigger` children use the latest.
  - Replays rerun with the same inputs on the latest code.
  - Version skew protection pins each run to the deployment built from the same commit.
  
  — [Trigger.dev: Versioning](https://trigger.dev/docs/versioning); [Trigger.dev Changelog (Sep 23, 2026)](https://trigger.dev/changelog)
- **Trigger options:**
  - `idempotencyKey`, with `idempotencyKeyTTL` defaulting to 30 days.
  - `delay`; delayed runs can be cancelled or rescheduled.
  - `ttl`, which expires runs that have not started (capped at 14 days on Cloud).
  - `debounce`, `maxAttempts`, `machine`, `region`, `priority` and `maxDuration`.
  - Batch triggers take up to 1,000 runs per call.
  - Payloads over 512 KB are offloaded to object storage, payloads over 10 MB are rejected, and outputs can be up to 100 MB.
  
  — [Trigger.dev: Triggering](https://trigger.dev/docs/triggering)
- v4.5.4 (2026-07-14) ended v3 support. 4.5.0 is the last self-hosted version that officially runs v3. — [releases.sh: trigger.dev v4.5.4](https://releases.sh/release/rel_69xYZmUxD0kYFm4bDCUS1-trigger-dev-v4-5-4) (aggregator of GitHub release)

#### Restate (journal + virtual objects)
- Restate records each step in a journal: calls, DB updates, timers and their results. After a failure it replays the journal, skips completed steps and resumes. It aims for each invocation to run "exactly once". Requests that carry an idempotency key are deduplicated and return the original result. Failed `run` actions retry with exponential backoff. — [Restate: Durable execution](https://docs.restate.dev/concepts/durable_execution)
- Virtual Objects and Workflows keep state in an embedded K/V store with a single-writer guarantee per key. State updates are journaled together with steps. Services stay stateless because the server sends state with each request. On FaaS platforms, handlers suspend while waiting so idle time is not billed. — [Restate: Durable execution](https://docs.restate.dev/concepts/durable_execution)
- The server is a single Rust binary built on a stream-processing design. It sits in front of services like a reverse proxy and proxies all service-to-service calls, giving retries and no duplicate execution without a separate message queue. It runs as a single node or as a consensus-replicated HA cluster. — [Restate: Durable execution](https://docs.restate.dev/concepts/durable_execution)
- Durable timers survive failures: a 12-hour sleep that fails at hour 8 sleeps only 4 more hours. There is no hard sleep limit. A sleep inside an exclusive Virtual Object handler queues all other calls to that object. — [Restate: Durable timers (TS)](https://docs.restate.dev/develop/ts/durable-timers)
- Awakeables wait for external events. A handler creates one (an ID plus a promise), sends the ID out, and awaits the promise. Another handler or an external system resolves or rejects it. — [Restate: Agents guide](https://docs.restate.dev/develop/ts/agents.md) (via search summary)
- Versioning uses immutable deployments: each code version gets its own endpoint, and retries return to the same endpoint, so a request runs on one version. Handlers that run for days or months are discouraged; the docs recommend splitting them with delayed calls. — [Restate: Versioning](https://docs.restate.dev/operate/versioning)
- Restate 1.5 added a live execution timeline UI and per-service and per-handler retry policies, and launched alongside Restate Cloud. I could not confirm the release date. — [Restate 1.5 announcement](https://www.restate.dev/blog/announcing-restate-1-5)
- Restate raised a $20M Series A on 2026-09-30. — [xenospectrum](https://xenospectrum.com/en/restate-ai-agent-durable-execution-funding/) (third-party)

#### Hatchet (Postgres-backed durable tasks)
- Every task invocation is persisted, which enables retries and replays. The SDKs cover Python, TypeScript, Go and Ruby. The project is MIT-licensed and built on PostgreSQL. "Hatchet Lite" is available for simple self-hosting. — [Hatchet docs home](https://docs.hatchet.run/home)
- Durable tasks write a checkpoint to a durable event log at each step and resume from the last checkpoint. Durable tasks either wait (durable sleep, durable event waits) or spawn children. Waits can be combined with "or groups", e.g. sleep OR event. The docs pitch this for work that "can't safely be made idempotent". — [Hatchet: Durable execution](https://docs.hatchet.run/v1/durable-execution)

#### Windmill workflows-as-code and Pipedream (platforms with durable primitives)
- **Windmill workflows-as-code:**
  - Written in TypeScript (`workflow()`) or Python (`@workflow`).
  - Each `task()` runs as a separate job. `step()` memoizes inline values such as timestamps and UUIDs.
  - At an uncached `task`, `step`, `sleep` or `waitForApproval`, the workflow checkpoints and releases its worker slot. Replay requires deterministic orchestration code.
  - Runs are pinned to the script version they started on; a checkpoint from a different version fails the job.
  - Each retry attempt is its own step, and waiting between attempts holds no worker.
  
  — [Windmill: Workflows as code](https://www.windmill.dev/docs/core_concepts/workflows_as_code)
- **Pipedream:**
  - `$.flow.suspend` pauses a workflow at the end of the current step and returns `resume_url` and `cancel_url`. The default timeout is 24 hours. Suspended time is not billed.
  - `$.flow.rerun(delayMs, context, maxRetries)` reruns a step later, with `maxRetries` defaulting to 10. It is used for polling and HTTP callbacks.
  - Neither function suspends in the builder; they only take effect in production.
  
  — [Pipedream: $.flow.suspend / rerun](https://pipedream.com/docs/workflows/building-workflows/code/nodejs/rerun)

### Inferences
- Landflow's engine interprets a JSON graph. The graph is data, not user code, so Landflow does not need Temporal-style determinism constraints. The best fit is the **Inngest / Windmill-WAC / Hatchet "memoized step" model**: give each node execution a stable ID (node name + run index + item batch), persist its output before scheduling successors, and on restart rebuild the run from persisted node outputs. This is the same data Landflow's partial execution already reuses.
- Landflow plugins are already called over HTTP or gRPC. Restate's model (a proxy that journals calls between services) and Inngest's standard orchestration (one HTTP request per step) are close analogues. A "plugin call" can be the durable step boundary.
- Pinning a run to the workflow version it started on (Trigger.dev, Windmill, Restate, Temporal Pinned) is cheap for a graph tool: store an immutable snapshot per publish and reference it from the execution. Temporal-style patching would only matter for the engine's own interpreter code.
- No engine offers true exactly-once external effects. Landflow should pass a stable per-step idempotency key to plugins, as Inngest advises, and document that node authors must honour it.

### Gaps
- Inngest `cancelOn` semantics and limits, `step.invoke` and `step.ai` were not on the fetched pages.
- Hatchet's exact durable-sleep and wait-for-event API names and limits were not on the fetched pages.
- Restate's licence was not verified.
- I could not verify the Restate 1.5 release date.
- Trigger.dev `priority` and `maxDuration` semantics were linked but not described on the fetched page.

---

## 2. Flow control: concurrency limits, rate limiting, throttling, debouncing, batching, priorities, cancellation, timeouts — which platforms offer what?

### Takeaway
Inngest, Trigger.dev and Hatchet have the richest primitives. All three key limits per tenant with expressions (CEL or a concurrency key) and release slots while runs wait. Windmill covers concurrency limits, debouncing, priority, timeouts and caching in a visual-plus-code platform. Temporal added Priority & Fairness (GA in May 2026). Pipedream offered simple per-workflow workers plus fixed-window throttling. Kestra 2.0 added Quotas. Restate has only concurrency limits; rate limits and priorities are listed as planned.

### Cited Findings

#### Inngest
- Inngest has eight flow-control primitives:

  | Primitive | Behaviour |
  |---|---|
  | Step concurrency | Waiting runs do not hold a slot |
  | Throttling | Excess runs wait in the queue |
  | Rate limiting | Excess triggers are discarded |
  | Batching | Groups events into one run; cannot be combined with rate limiting or priority |
  | Singleton | One active run per key |
  | Debounce | Waits for a quiet period, so a burst starts one run |
  | Priority | Moves higher-value work ahead in the queue |
  | Multi-tenancy keys | Limits per tenant key; key-queue scheduling is Enterprise-only |

  — [Inngest: Flow control](https://www.inngest.com/docs/guides/flow-control)
- Order of evaluation:
  1. Rate limiting and batching run before scheduling.
  2. Debounce and singleton run at scheduling.
  3. Step concurrency applies at execution.
  
  A rate-limited run skips all other controls. — [Inngest: Flow control](https://www.inngest.com/docs/guides/flow-control)
- Plan limits:
  - Concurrent steps: 5 (Free), 100 (Pro), 500 (Business).
  - Batch capacity: 5, 100 and 500 events; batch timeout 30 seconds to 5 minutes; 10 MiB hard cap per batch.
  
  — [Inngest: Usage limits](https://www.inngest.com/docs/usage-limits/inngest)

#### Trigger.dev
- **Concurrency limits:**
  - Each environment has a base concurrency limit and a burstable limit (2.0x by default).
  - Per-task `concurrency: {total, perKey}`.
  - Shared named limits via `concurrencyLimit({name, ...})`; a task can hold one inline limit plus up to two named limits, and a run starts only when every limit it holds has capacity.
  - A `concurrencyKey` gives each tenant its own pool.
  - "Only actively executing runs count towards concurrency limits." Runs release their slots at checkpointed waits, and parents waiting on subtasks release theirs, which avoids deadlocks.
  
  — [Trigger.dev: Queue concurrency](https://trigger.dev/docs/queue-concurrency)
- At runtime the SDK can `override` or `reset` limits (overrides persist across deploys; per-key overrides have a TTL of 7 to 30 days) and `pause` or `resume` dequeuing. The older `queue: {concurrencyLimit}` still works but is deprecated. — [Trigger.dev: Queue concurrency](https://trigger.dev/docs/queue-concurrency)
- **Debounce** merges triggers that share a key and task. Leading mode (the default) runs with the first payload, and trailing mode runs with the last. `maxDelay` caps the total wait. Idempotency keys win over debounce keys. **TTL** expires runs that have not started; its clock starts at enqueue, or after the `delay` ends. — [Trigger.dev: Triggering](https://trigger.dev/docs/triggering)
- 2026 changelog:

  | Date (2026) | Change |
  |---|---|
  | Sep 20 | Multiple concurrency limits per task and runtime changes without a deploy |
  | Sep 30 | Concurrency page charts scheduling delay, backlog and throttling |
  | Oct 1 | v4.7.0: total cap for per-tenant concurrency |
  | Oct 14 | v4.7.4: per-key concurrency overrides |

  — [Trigger.dev Changelog](https://trigger.dev/changelog)

#### Hatchet
- Concurrency keys are CEL expressions over `input` and `additional_metadata`. Max runs can be a fixed number or, on engine 0.106.0 and later, a per-key CEL expression (e.g. a higher limit for premium accounts). Named limits can be shared across workflows. — [Hatchet: Concurrency](https://docs.hatchet.run/v1/concurrency)
- Strategies:
  - `GROUP_ROUND_ROBIN`: fair dequeue across keys.
  - `CANCEL_IN_PROGRESS`: the newest run replaces the running one, e.g. for search-as-you-type.
  - `CANCEL_NEWEST`: rejects new runs when the limit is reached.
  - "Cancel queued except newest" and "cancel queued except oldest".
  
  Several strategies can be combined on one workflow. Hatchet also has separate rate limits and per-task "slot cost" for heavy runs. — [Hatchet: Concurrency](https://docs.hatchet.run/v1/concurrency)
- Hatchet also has worker-level slot control, fairness and priorities. — [Hatchet docs home](https://docs.hatchet.run/home)

#### Windmill, Pipedream, Temporal, Restate, Kestra, Node-RED, n8n
- **Windmill:**
  - Concurrency limits cap concurrent runs of scripts and flows.
  - Job debouncing cancels pending duplicate jobs.
  - Caching reuses a result for N seconds.
  - Per-step custom timeout, per-step priority in the execution queue, sleep, early stop/break and early return.
  - Error handlers, and "lifetime" to delete a step's logs and results after the flow completes.
  
  — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Pipedream:**
  - Concurrency is set as a number of workers; 1 worker serializes events in order.
  - Throttling uses fixed windows: 0–10,000 events per 1–10,000 seconds, minutes or hours. A limit of 0 pauses the queue.
  - Queue size is 100 on the free tier and up to 10,000 on paid plans. "If the number of events emitted to a workflow exceeds the queue size, events will be lost."
  - Queues apply only to event-source triggers, not HTTP, cron, SDK or email triggers.
  
  — [Pipedream: Concurrency and throttling](https://pipedream.com/docs/workflows/building-workflows/settings/concurrency-and-throttling)
- **Temporal:** Task Queue Priority & Fairness went GA on 2026-05-05. Standalone Activities support priority/fairness and start delay. — [Temporal Changelog](https://temporal.io/changelog)
- **Restate:** "Opt-in concurrency limits cap concurrent invocations per scope". Rate limits and priorities are planned. — [Restate: Durable execution](https://docs.restate.dev/concepts/durable_execution)
- **Kestra 2.0:**
  - Quotas (OSS) limit the execution creation rate per flow, namespace or tenant.
  - Asset locking (`Acquire` and `Release` tasks) provides TTL-bounded write locks (EE).
  - Worker Groups 2.0 adds tag-based routing and capacity reservation (EE).
  
  — [Kestra 2.0 release blog](https://kestra.io/blogs/release-2-0)
- **Kestra triggers:** each trigger ID is limited to one active execution; if a scheduled execution is still running, the next one is queued. — [Kestra: Triggers](https://kestra.io/docs/workflow-components/triggers.md) (via search summary)
- **Node-RED 5.0:** the Delay node gained a burst mode, where messages pass at their arrival rate until the limit is reached and then block until the next interval. Rate limiting in Node-RED is a node in the flow, not an engine setting. — [Node-RED 5.0 release](https://nodered.org/blog/2026/06/09/version-5-0-released)
- **n8n queue mode:** per-worker `--concurrency` defaults to 10, and n8n recommends at least 5. — [n8n: Queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/)

### Inferences
- The minimum set Landflow should support:
  - Per-workflow concurrency with an optional key expression; Landflow's existing expression engine can play the role CEL plays in Inngest and Hatchet.
  - A per-workflow or per-node rate limit or throttle.
  - Debounce and singleton on triggers.
  - Per-node and per-run timeouts.
  - Cancel and cancel-in-progress.
- A Pipedream-style "N workers + X per interval" settings panel is the easiest to present in a visual tool. Inngest and Trigger.dev show the more powerful keyed version.
- Runs waiting on a durable sleep, event or approval must not hold a concurrency slot (Inngest, Trigger.dev and Windmill all do this). Otherwise long approval steps deadlock the limit. This depends on durability (section 1).
- Pipedream silently drops events when its queue overflows. That is a cautionary design point: Landflow's queue should be durable and bounded, with backpressure or an explicit dead-letter mechanism.

### Gaps
- Temporal's Task Queue rate-limit details were not fetched.
- Hatchet's rate-limit and priority pages were linked but not fetched.
- Windmill concurrency-limit details (keys, time windows) were not fetched beyond one-line descriptions.
- The precise semantics of Kestra flow-level `concurrency` and of backfill throttling were not verified.

---

## 3. Developer experience: workflows as code vs visual, git sync, CLI, local dev and testing, previews/branches, typed SDKs, multi-language scripts, approval steps/suspend-resume, auto-generated UIs and apps, dependency handling

### Takeaway
- **Windmill** has the broadest developer experience. It offers visual flows plus workflows-as-code, steps in about ten languages, and git sync. It also has a CLI, VS Code and JetBrains local dev, workspace forks and dev workspaces, auto-generated UIs from JSON Schema, and full-code apps.
- **Trigger.dev** has the best "code-first with environments" story: `dev`/`deploy`, preview branches, a CLI and version skew protection.
- **Kestra 2.0** is the closest analogue to Landflow's ambition: a no-code editor kept in sync with declarative YAML.
- **Pipedream** pioneered code-steps-in-a-visual-builder and suspend URLs. Its Workflows product is shutting down on 2027-03-31.

### Cited Findings

#### Windmill
- **Development workflow:**
  - Local development from the terminal, VS Code or JetBrains; a CLI.
  - Git sync of a workspace with a repo.
  - Workspace forks ("like Git branches") and dev workspaces.
  - Draft-and-deploy; deploy to prod from staging.
  - Protection rulesets that enforce governance on changes.
  - CI test scripts, and step mocking/pinned results.
  - Infrastructure as code (declarative YAML or a Kubernetes operator).
  - Real-time multiplayer editing.
  
  — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Languages, dependencies and execution:**
  - Languages referenced: TypeScript, Python, Bun, Deno, PowerShell, C#, Nu, Rust and Go; also SQL and dbt.
  - "Run scripts without managing a package file directly". Workspace dependencies, codebases and bundles with relative imports, preinstalled binaries, Docker containers and SSH execution.
  
  — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- Ruby and R are enabled on the Windows worker. — [Windmill v1.768.0 release](https://newreleases.io/project/github/windmill-labs/windmill/release/v1.768.0)
- **UIs and apps:**
  - Auto-generated UIs from script and flow parameters, using JSON Schema.
  - Full-code apps (React or Svelte frontends on Windmill backends), public apps, guest apps and scheduled PDF/PNG app reports.
  - The low-code drag-and-drop app editor is marked "legacy".
  
  — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Triggers:** schedules, webhooks, email, custom HTTP routes, WebSocket, Postgres, Kafka, NATS, SQS, MQTT, GCP Pub/Sub, Azure Event Grid, native triggers (Nextcloud, Google Drive, Google Calendar) and MCP. — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Data:**
  - Resources and resource types (typed connection schemas); encrypted variables and secrets, with re-encryption on key rotation.
  - Native S3, Azure Blob and GCS object storage; volumes; a custom instance Postgres database.
  - DuckDB "Pipelines" (alpha) with asset lineage.
  
  — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Workers:** worker groups for machines with different specs, dedicated workers, autoscaling, agent workers (no direct DB access) and high-availability failover. — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Approval steps:**
  - Any script can be set to "suspend until approval/resume".
  - `wmill.getResumeUrls()` generates one secret URL per required approval. A flow can require N approvals.
  - A schema form can be attached to the approval page (Cloud and EE). Timeouts auto-cancel, or the flow can continue with `SuspendedTimedOut` or `SuspendedDisapproved`.
  - Cloud and EE can require login, block self-approval or require a group.
  - Helpers exist for interactive Slack and Teams approvals.
  
  — [Windmill: Flow approval](https://www.windmill.dev/docs/flows/flow_approval)
- **Sandboxing:**
  - PID-namespace isolation via `unshare`, and NSJAIL, which adds filesystem isolation, optional network restriction and resource limits, and runs jobs as unprivileged users.
  - Scripts can opt in with a `sandbox` annotation or a `no_network` annotation.
  - "Job isolation is disabled by default in Windmill".
  
  — [Windmill: Security and process isolation](https://www.windmill.dev/docs/advanced/security_isolation)
- 2026 releases:
  - v1.752.0 (2026-07-07): SQL migrations for data tables.
  - v1.781.0 (2026-08-05): serves the 2026-07-28 MCP spec alongside the legacy protocol; a dev workspace can have its own dev workspace.
  
  — [Windmill v1.752.0](https://newreleases.io/project/github/windmill-labs/windmill/release/v1.752.0), [Windmill v1.781.0](https://newreleases.io/project/github/windmill-labs/windmill/release/v1.781.0)

#### Trigger.dev
- **CLI and build:**
  - Commands: `login`, `init`, `dev` and `deploy`; `--profile` switches between Cloud and self-hosted.
  - `deploy --env prod|staging|preview`, with a separate API key per environment.
  - `dev` runs task code locally while scheduling stays on the server, reloads on save and runs each task in a separate process. There is no offline dev mode.
  - Builds use esbuild and produce ESM; a Docker image is deployed; build extensions are available.
  - OpenTelemetry-based logs, correlated between parent and child tasks.
  
  — [Trigger.dev: How it works](https://trigger.dev/docs/how-it-works)
- 2026 changelog:

  | Date (2026) | Change |
  |---|---|
  | Sep 15 | v4.6.1: CLI commands for projects, runs and env management |
  | Sep 30 | Preview branches archive automatically after N days without deploys |
  | Oct 5 | "Ask Trigger" dashboard agent |
  | Oct 14 | v4.7.4: `runs.replay()` can change payloads and trigger settings |
  | Oct 20 | v4.7.5: CLI `tasks trigger` and span redaction before telemetry export |
  | Oct 23 | v4.8.0: hosted webhooks |

  — [Trigger.dev Changelog](https://trigger.dev/changelog)
- `trigger init` sets up the user's AI coding assistant (v4.5.0-rc.6, June 2026). Node 24 and Node 26 runtimes were added (v4.5.5–4.5.7, July 2026). — [Trigger.dev release notes summary via search](https://releasebot.io/updates/triggerdev) (aggregator)

#### Inngest
- The Dev Server can be used to test versioning. Pause a run with `step.sleep()`, change the code, resume, and confirm which results are reused. — [Inngest: Versioning](https://www.inngest.com/docs/learn/versioning)

#### Pipedream (status: Workflows shutting down)
- Pipedream's own docs carry the banner: "Workflows and String are shutting down on March 31, 2027." — [Pipedream: Concurrency and throttling](https://pipedream.com/docs/workflows/building-workflows/settings/concurrency-and-throttling); [Pipedream: $.flow.suspend](https://pipedream.com/docs/workflows/building-workflows/code/nodejs/rerun)
- Workday announced a definitive agreement to acquire Pipedream on 2025-11-19, describing it as an integration platform for AI agents with 3,000+ connectors. Closing was expected by 2026-01-31. — [Workday press release](https://newsroom.workday.com/2025-11-19-Workday-Signs-Definitive-Agreement-to-Acquire-Pipedream)
- Third-party sources add the following, which I did not see in a Pipedream primary source:
  - Workflows data, including credentials and OAuth tokens, is deleted by 2027-04-30.
  - No new signups or features.
  - Pipedream Connect (the API for embedding app connections and agent tool calls) is not affected.
  
  — [Webhook Relay migration post](https://webhookrelay.com/blog/pipedream-workflows-shutdown-migration/); [Hookdeck: Pipedream alternatives](https://hookdeck.com/webhooks/platforms/pipedream-alternatives) (competitor marketing)

#### Kestra (see section 5 for detail)
- Kestra 2.0 added a form-based no-code editor (OSS) kept in sync with YAML and the Copilot, plus a VS Code extension that pulls the flow schema from the connected instance. Unit tests can now assert FAILED, WARNING or KILLED outcomes via `expectedState`. — [Kestra 2.0 release blog](https://kestra.io/blogs/release-2-0)

### Inferences
- **Windmill's "flows plus workflows-as-code over the same job/worker substrate"** is the most transferable pattern for Landflow. Landflow's language-agnostic plugin protocol is already halfway to "steps in any language". The missing pieces are a code-runner plugin (Python/TS) with dependency resolution and sandboxing, and a serialized flow format that git sync and the CLI can round-trip.
- **Trigger.dev shows the minimum code-first loop:** `init`, `dev` (local execution, server scheduling, hot reload), `deploy --env`, preview environments and version pinning. For Landflow the equivalent is `landflow pull/push/run/test`, plus environments (dev/staging/prod) with separate credentials.
- **Approval steps are a UI layer on top of durable suspend.** Windmill, Trigger.dev and Pipedream all reduce them to "suspend + secret resume/cancel URL + optional form + timeout". Landflow's chat trigger and webhook infrastructure could serve resume URLs once runs are durable.
- **Auto-generated UIs:** Landflow's JSON node descriptor contract is analogous to Windmill's JSON-Schema-driven UIs. The same schema could render run forms, approval forms and MCP tool schemas.

### Gaps
- Pipedream's multi-language support (Node, Python, Go, Bash), data stores, file stores, GitHub sync and CLI were not verified this session. They are moot for new adoption given the shutdown.
- Windmill's licence (AGPL vs EE split) and which isolation features are EE-only were not stated on the fetched page.
- Kestra's Terraform provider is referenced only through the 2.0 breaking-change note.
- Temporal and Inngest CLI and local-dev details were not fetched.

---

## 4. Activepieces and Node-RED: notable open-source automation features (pieces framework, MCP, flows, dashboards, context storage, subflows)

### Takeaway
**Activepieces** is the most n8n-like of the group: an MIT-core visual builder with 760+ TypeScript "pieces". Its 2026 positioning is AI agents plus flows plus Tables, with a first-class MCP server and an AI-assisted piece builder.

**Node-RED** 5.0 (June 2026) is a mature flow-based runtime. Its notable primitives are scoped context storage with pluggable persistent stores, subflows, and Link nodes, which the Function node can now call and await. 5.0 focused on the editor rather than the engine.

### Cited Findings

#### Activepieces
- Positioning: "AI automation for teams, with governance and security built in".
  - Chat-to-build agents and flows (beta).
  - AI agents with tools and knowledge; flows (trigger plus steps) that call agents and vice versa; an AI Router.
  - Tables (rows and columns usable by both flows and agents); 760+ integrations.
  - An MCP server that MCP clients (Claude, Copilot, Cursor, Gemini CLI, Windsurf, Zed) can build from.
  - Flow publishing, version history and flow approvals.
  - Governance: bring-your-own AI keys, a vault for secrets, SSO/SCIM, projects with roles, app approval controls and audit logs streamed to a SIEM.
  - A one-command self-host; an Embed SDK (enterprise).
  
  — [Activepieces docs: Welcome](https://www.activepieces.com/docs)
- Pieces are built in TypeScript. Hot reload shows changes in the browser "within 7 seconds". The recommended path uses a piece-builder skill in Claude Code or Cursor to research the API, scaffold, implement and verify. Community PRs are invited. — [Activepieces: Building pieces overview](https://www.activepieces.com/docs/build-pieces/building-pieces/overview)
- The core is "released as open source under the MIT license". EE code (`packages/ee`, `packages/server/api/src/app/ee`) needs a commercial licence when self-hosted. — [Activepieces: License](https://www.activepieces.com/docs/about/license)
- The MCP piece (page dated August 2026) is open source and included on every plan, including self-hosted. It has one trigger, "MCP Tool", and one action, "Reply to MCP Client". This lets a flow act as an MCP tool. — [Activepieces MCP piece](https://www.activepieces.com/pieces/mcp) (via search summary)
- A single MCP server URL exposes the integrations, with OAuth on first use. — [Activepieces MCP server page](https://www.activepieces.com/mcp/mcp) (via search summary)

#### Node-RED
- Context has three scopes: node, flow (tab) and global. Subflow nodes share a separate flow context and can reach the parent's context with the `$parent.` prefix (since 0.20). By default context is in memory and lost on restart. — [Node-RED: Working with context](https://nodered.org/docs/user-guide/context)
- Built-in stores are `memory` and `localfilesystem`, and custom store plugins are supported. `localfilesystem` writes to `~/.node-red/context/` every 30 seconds. Multiple stores can be configured via `contextStorage`, with a `default` store, and the editor lets users choose which store a value goes to. — [Node-RED: Working with context](https://nodered.org/docs/user-guide/context)
- Node-RED 5.0 (blog dated 2026-06-09) changes:
  - **Editor:** split sidebars, new Explorer and Information panels, a built-in dark theme, accessibility work, pan/zoom improvements, documentation badges on nodes, and GitHub-style markdown alerts.
  - **Function node:** `node.linkcall` calls a Link node and awaits its response.
  - **Delay node:** burst mode.
  - **Debug sidebar:** pause toggle.
  - **Security:** TLS from PFX/P12 or env vars; SNI support in HTTP Request; OAuth token exchange; default admin CORS removed.
  
  — [Node-RED 5.0 released](https://nodered.org/blog/2026/06/09/version-5-0-released)
- Node-RED 5.0 breaking changes: Node.js 22.9.0 minimum (24 recommended); no 32-bit ARM Docker images, so a Raspberry Pi 3B or earlier cannot run it; credentials file now sits beside the flows file; touch radial menu removed. — [Node-RED 5.0 released](https://nodered.org/blog/2026/06/09/version-5-0-released)
- The latest stable is 5.0.4 (2026-07-30). — [Wikipedia: Node-RED](https://en.wikipedia.org/wiki/Node-RED) (secondary)

### Inferences
- Activepieces and Kestra 2.0 both expose flows as MCP tools via a dedicated trigger plus reply action, and Windmill also supports MCP. This makes "a workflow as an agent tool" a 2026 table-stakes feature for automation platforms. Landflow already has chat and webhook triggers, so an MCP-tool trigger (input schema from the descriptor) plus a reply node fits naturally.
- Activepieces' AI-assisted piece builder and hot reload set the developer-experience bar for plugin authoring. Landflow's SDKs (TS, Python, Go) plus autodiscovery are architecturally stronger (any language, out-of-process), but would benefit from a scaffold CLI and a hot-reload dev loop.
- Node-RED's context scopes and pluggable persistent stores are a lightweight alternative to full data tables. "Workflow static data" / KV state is a cheap gap for Landflow to close.
- `node.linkcall` and subflows show that "call another flow and await its result" is a core composition primitive. Landflow's inventory does not mention a sub-workflow node.

### Gaps
- Node-RED Projects (git-backed flows), Dashboard 2.0 and subflow environment properties were not verified this session.
- Activepieces' piece structure (auth, actions, polling vs webhook triggers), npm publishing, piece versioning, code-step sandboxing, worker/queue architecture and the git-sync/environments feature (and whether it is EE) were not on the fetched pages.
- Sources disagree on Activepieces piece counts: the vendor says 760+, and a third-party profile claims 280+ are MCP-exposed. I did not verify either figure.

---

## 5. Kestra: declarative YAML flows, namespaces, plugins, backfills, triggers, task runners

### Takeaway
Kestra 2.0 (2026-09-08, LTS, Apache 2.0) rebuilt the engine into a control plane and a data plane:
- Workers open one outbound gRPC stream, so they can run anywhere.
- The queue is decoupled from the database; Kafka Streams is removed.

It also added a no-code editor synced with YAML, flows as MCP tools, Quotas and draft revisions. Governance features (Policies, Promote, RBAC, Worker Groups 2.0, cloud-VM task runners) are EE.

### Cited Findings
- **Architecture:** the Executor, Scheduler, Webserver and Indexer form the control plane, and no user code runs there. Workers (tasks and polling triggers) are the only components with infrastructure access. In 1.x, workers needed DB credentials. In 2.0, each worker opens one outbound gRPC stream to the Worker Controller, needs no inbound ports and has no DB access. — [Kestra 2.0 engine rebuild](https://kestra.io/blogs/2026-09-01-kestra20-rebuild-engine); [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Backends:** the queue no longer depends on the DB, and the Kafka Streams engine was removed. Postgres can serve as both queue and repository, with Kafka, Redis or AMQP as queue options. Worker channels can use TLS, mTLS or JWT. — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- Kestra's own blog adds that OSS runs on JDBC and that the Redis, AMQP and Kafka queues are Enterprise-only. — [Kestra 2.0 vs Airflow/Dagster](https://kestra.io/blogs/kestra-2-0-airflow-dagster-alternative) (via search summary; consistent with the release post once the edition split is considered)
- 2.0 is an LTS release with a year of backported fixes and stays Apache 2.0. — [Kestra 2.0 landing](https://kestra.io/two-zero) (via search summary)
- **Draft revisions:** drafts never run, and triggers fall back to the last published revision. — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Agents (OSS, EE and Cloud):**
  - The MCP Tool Trigger plus a default per-tenant MCP server turn flows into agent tools, with generated config for Claude Desktop, Claude Code, Cursor and Codex.
  - The AI Agent task gains guardrails, Prometheus metrics and MCP client tasks.
  - AI Copilot (Edit, Plan and Ask modes) is EE and Cloud only.
  
  — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Triggers:**
  - A Pebble `when` expression replaces the `conditions` list.
  - Calendar helpers: `isWeekend()`, `isPublicHoliday()` and `isLastWorkingDay()`.
  - Flow triggers use `dependsOn` with a `window`, replacing `preconditions`.
  
  — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- The trigger types are schedule, flow, webhook, polling and realtime. — [Kestra: Triggers](https://kestra.io/docs/workflow-components/triggers.md) (via search summary)
- **Authoring (OSS):**
  - A `Loop` task replaces ForEach and ForEachItem, running each iteration as an isolated sub-execution.
  - A no-code form editor stays synced with YAML.
  - Input `{label, value}` options, a `subflow()` function and `jsonSchema` validation.
  - Unit-test `expectedState`.
  - `TRACEPARENT` propagation links script spans to OpenTelemetry traces.
  - A VS Code extension.
  - A `-slim` image that auto-installs plugins from Maven Central.
  - `PurgeStorage` for orphaned files, and Quotas.
  
  — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Plugins:** plugins can ship Vue.js UI components loaded at runtime (plugin artifacts, OSS). — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Namespaces and governance (EE and Cloud):**
  - Namespace-scoped Policies replace `pluginDefaults`. Rules cascade to child namespaces, and an EVALUATE mode reports violations before enforcement.
  - Reusable Inputs per namespace.
  - Cases: incident tracking with SLA timers.
  - Promote: moves flows between environments with diffs, drift status and an audit trail.
  - Git-managed blueprints.
  - An RBAC model of 159 per-action permissions.
  
  — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Task runners:** a pluggable system that runs tasks on dynamically provisioned compute such as AWS Batch, Azure Batch, Google Batch and auto-scaled Kubernetes; some are EE-only. — [Kestra: Task runners](https://kestra.io/docs/task-runners.md)
- 2.0 added EE runners for AWS EC2 (via SSM, with Spot), Azure VM, Google Compute Engine and Huawei Cloud CCI. — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Breaking changes in 2.0:**
  - ForEach, ForEachItem, trigger `conditions`, `workerGroup.key` and `pluginDefaults` are removed.
  - `json()` is replaced by `fromJson()`.
  - The `Count`, `Resume`, `Toggle` and `log.Fetch` tasks are removed.
  - `CANCELED` becomes `CANCELLED`.
  - Worker-group `fallback` now defaults to FAIL instead of WAIT.
  - Users must be on 1.3.x before upgrading; the `kestra-migrate` tool automates most rewrites.
  
  — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- Earlier 2026 releases: 1.3.0 (2026-03-02) added AI Copilot for test suites, dashboards and apps. Patch releases continued on the 1.0 and 1.2 lines into April 2026. — [Kestra changelog v1.3.0](https://kestra.io/docs/changelog/v1.3.0); [v1.2.15](https://kestra.io/docs/changelog/v1.2.15); [v1.0.36](https://kestra.io/docs/changelog/v1.0.36)

### Inferences
- Kestra's control-plane/data-plane split (outbound-only gRPC workers, no DB access) maps directly onto Landflow's existing gRPC plugin protocol. Landflow's plugins could evolve into remote "workers" that pull work rather than being called, which enables execution in customer networks.
- "Drafts never run; triggers use the last published revision" is a simple, high-value versioning rule for a visual editor.
- The no-code editor synced with YAML confirms that "visual + as-code round-trip" is viable at scale. Landflow's JSON workflows would need a stable, diff-friendly serialization (stable node IDs, sorted keys) to support it.

### Gaps
- I could not fetch Kestra backfill semantics (date ranges, pause/resume, concurrency): the `.md` docs URL returned 404.
- Namespace files, Kestra apps and the details of the Docker/Process task runners were not verified this session.

---

## 6. Which patterns are adoptable in a visual n8n-like tool, and which features does Landflow lack (what they do, how much they matter, how they fit Landflow's architecture)?

### Takeaway
Landflow's biggest gaps are in the **runtime substrate**, not the editor:
- Runs are not durable.
- There is no queue or workers.
- There is no flow control, idempotency, version pinning, or durable wait/approval.

These are "core" because nearly every other gap depends on them: approvals, long waits, retries across restarts, scale-out, safe deploys. The second tier is developer experience: CLI, git-synced workflow files, environments, tests, sandboxed and Python code. The engines show that a Postgres-backed, step-memoized design (Hatchet, Kestra OSS on JDBC, Inngest-style step IDs) can deliver this without adopting a code-replay model. Landflow is already competitive or ahead on cross-language plugins and OpenTelemetry tracing.

### Cited Findings
- **n8n queue mode, the reference "visual tool at scale" architecture:**
  - The main instance handles timers and webhooks and creates executions without running them. It passes the execution ID via Redis (Bull).
  - Workers load the workflow from the DB, run it, write results back and signal completion via Redis. Per-worker `--concurrency` defaults to 10.
  - Optional dedicated webhook processors sit behind a load balancer.
  - SQLite is not supported, and the filesystem binary-data mode is not supported, so binary data needs S3.
  - Multi-main HA (self-hosted Enterprise) uses leader election for timers and pollers.
  
  — [n8n: Queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/)
- **Postgres-only durable engines are viable:**
  - Hatchet is "built on PostgreSQL" (MIT). — [Hatchet docs home](https://docs.hatchet.run/home)
  - In Kestra 2.0, Postgres can serve as both queue and repository. — [Kestra 2.0 release](https://kestra.io/blogs/release-2-0)
- **Large payloads are stored out of band:**
  - Trigger.dev offloads payloads over 512 KB to object storage. — [Trigger.dev: Triggering](https://trigger.dev/docs/triggering)
  - Temporal added External Storage for large payloads (public preview, 2026-05-14). — [Temporal Changelog](https://temporal.io/changelog)
  - Windmill has native S3, Azure Blob and GCS object storage. — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
- **Secrets:**
  - Windmill encrypts variables and secrets and supports workspace secret re-encryption. — [Windmill: Core concepts](https://www.windmill.dev/docs/core_concepts)
  - Activepieces has a vault for secrets. — [Activepieces docs](https://www.activepieces.com/docs)
  - Trigger.dev env vars synced via `syncEnvVars` can be marked as secrets (v4.5.4). — [releases.sh: trigger.dev v4.5.4](https://releases.sh/release/rel_69xYZmUxD0kYFm4bDCUS1-trigger-dev-v4-5-4) (aggregator)
- **Replay and backfill:**
  - Trigger.dev `runs.replay()` can change payloads and settings (2026-10-14). — [Trigger.dev Changelog](https://trigger.dev/changelog)
  - Kestra documents backfills for schedules. — [Kestra: Triggers](https://kestra.io/docs/workflow-components/triggers.md) (page exists; details not fetched)
- **Code sandboxing:**
  - Windmill provides nsjail and PID isolation (off by default). — [Windmill: Security and process isolation](https://www.windmill.dev/docs/advanced/security_isolation)
  - Node's `node:vm` module is documented by Node.js as not a security mechanism. — [Node.js vm docs](https://nodejs.org/api/vm.html) (well-known statement; not re-fetched this session)

### Inferences

#### What Landflow already has that holds up
- **Plugin protocol:** language-agnostic HTTP/gRPC plugins with autodiscovery. These are comparable to Restate and Inngest "services you host" and are more flexible than Activepieces' TypeScript-only pieces.
- **Debugging:** partial execution and a breakpoint debugger match Windmill's step mocking and instant preview.
- **Observability:** end-to-end OpenTelemetry across host and plugins. Kestra only just added TRACEPARENT propagation in 2.0, and Trigger.dev is OTel-based.

#### Gap matrix (feature → user value → priority → Landflow fit)

| # | Feature Landflow lacks | What it does for users | Reference implementations | Priority | How it could fit Landflow |
|---|---|---|---|---|---|
| 1 | **Durable runs and crash recovery** (per-node checkpoints, resume after crash or deploy) | In-flight runs survive host crashes, restarts and deploys. No lost orders or duplicated half-runs. | Temporal event history; Inngest step memoization; Trigger.dev CRIU; Restate journal; Hatchet event log; Windmill WAC checkpoints (all in §1) | **Core** | Move executions from JSON files to a DB (Postgres; SQLite for single-node). Persist each node-run output keyed by a stable step ID (node name + run index) before scheduling successors. On startup, resume runs left "running" by replaying completed node outputs; partial execution already does this in memory. No determinism constraints are needed because the graph is data. |
| 2 | **Durable sleep, wait-for-event and wait-for-webhook** | Workflows can wait hours to months (reminders, trials, SLAs) or until an external callback, without holding memory or a worker. | Inngest `step.sleep` (≤1 yr) and `waitForEvent` with match expression; Trigger.dev waitpoint tokens with callback URL; Restate durable timers and awakeables; Hatchet durable sleep/events with or-groups; Pipedream `$.flow.suspend` | **Core** | Turn the Wait node into a persisted "waitpoint" row (`resume_at`, or a correlation expression or token). The run ends in memory. The scheduler or webhook router resumes it from item 1's state. Wait time must not count toward concurrency. |
| 3 | **Human approval / suspend-resume with forms** | Approvals, reviews and human-in-the-loop AI steps, via a link, Slack/Teams or a form. | Windmill approval steps (N approvers, forms, timeouts, self-approval block, Slack/Teams); Trigger.dev tokens completable from the browser; Activepieces flow approvals; Pipedream resume/cancel URLs | **Important** (expected in n8n-class tools) | Build on item 2: an "Approval" node creates a waitpoint with secret resume/cancel URLs and an optional form rendered from a JSON schema (reuse the node-descriptor schema renderer). Add timeout and continue-on-reject outputs. |
| 4 | **Queue and workers** (separate API/editor/trigger host from executors; horizontal scale) | Throughput beyond one process, isolation of heavy runs, zero-downtime deploys, HA. | n8n queue mode (Redis/Bull, worker `--concurrency`, webhook processors, multi-main); Kestra 2.0 outbound-gRPC workers; Windmill worker groups and dedicated workers; Hatchet slots | **Core** (for production use) | Use a DB-backed queue (Postgres `SKIP LOCKED`, à la Hatchet/Kestra JDBC) or Redis. Next.js host = API, editor, triggers and scheduler; `landflow worker` processes run executions. Leader election for the scheduler and pollers (n8n multi-main pattern). Workers could later run remotely over Landflow's existing gRPC channel (Kestra 2.0 pattern). |
| 5 | **Concurrency limits** (per workflow and per key) | Protect downstream APIs and DBs; fair share per customer; serialize per-entity work. | Inngest concurrency keys; Trigger.dev `total` and `perKey` plus shared named limits and runtime overrides; Hatchet CEL keys and strategies; Windmill concurrency limits; Pipedream workers; Restate concurrency limits | **Core** | Workflow setting: max concurrent runs plus an optional key expression in Landflow's expression syntax. Shared named limits (e.g. "stripe-api") referenced by nodes. Waiting runs release slots. |
| 6 | **Rate limiting, throttling, debounce, singleton, batching, priority, TTL, delay** | Respect third-party quotas; collapse bursts (e.g. many "record updated" webhooks); bulk processing; urgent-first. | Inngest (all of these); Trigger.dev debounce (leading/trailing, `maxDelay`), TTL, delay, priority; Hatchet `CANCEL_IN_PROGRESS`; Pipedream fixed-window throttle; Kestra Quotas; Temporal Priority & Fairness; Node-RED Delay node burst mode | **Important** (rate limit is core-adjacent; debounce and batching are important; priority and fairness nice-to-have unless multi-tenant SaaS) | Trigger-level settings (debounce key and window, singleton, rate limit) evaluated before enqueue, in Inngest's ordering. A per-node "rate limit" on plugin calls using a token bucket in the DB or Redis. A "Batch" trigger option that groups N events or T seconds into one run's items, which suits Landflow's item model. |
| 7 | **Idempotency keys** | Duplicate webhooks or retries do not double-charge or double-send. | Inngest event `id` (24 h) and function `idempotency` expression; Trigger.dev `idempotencyKey` and TTL (30-day default); Restate idempotency keys; Temporal Standalone Activities dedupe | **Core** (for webhooks and payments use cases) | Webhook and trigger setting: idempotency key expression plus TTL, backed by a dedupe table returning the existing execution. Pass a stable `Idempotency-Key` (execution ID + step ID) header to plugins on each node call, and document that plugin authors should forward it to external APIs. |
| 8 | **Workflow versioning, pinning and draft vs publish** | Editing a workflow never breaks or changes runs already in flight. Safe rollback. Audit of what ran. | Trigger.dev run locking and version skew protection; Temporal Pinned/Auto-Upgrade and patching; Inngest step-ID matching; Windmill WAC pinned version and draft-and-deploy; Kestra drafts that never run; Restate immutable deployments; Activepieces publish and version history | **Core** (once item 1 exists) | Immutable workflow version snapshots on publish. Executions store `versionId` and always resume on it (Pinned). The editor edits a draft, and triggers use the last published version. An optional "upgrade waiting runs" action for compatible changes, matching by node ID as in Inngest. |
| 9 | **Full cron schedules** (Landflow has interval only), timezones, calendars, backfill | Business schedules ("9:00 on weekdays"), holiday-aware runs, catch-up after downtime. | Kestra Schedule plus `isPublicHoliday()` and other helpers, backfills, one active execution per trigger; Windmill schedules | **Core** (cron), **nice-to-have** (calendars and backfill) | Replace the interval scheduler with cron plus timezone, persisted "next fire" in the DB (survives restarts, works with leader election). Backfill = enqueue runs for past fire times with a concurrency cap. |
| 10 | **Timeouts and cancellation** (per node and per run; cancel API) | Runaway runs do not hang forever; users can stop bad runs; newer input can supersede stale runs. | Windmill custom step timeout; Inngest 2 h step timeout and max run length; Trigger.dev `maxDuration` and `ttl`; Temporal activity timeouts and heartbeats; Hatchet `CANCEL_IN_PROGRESS` | **Core** | Node descriptor declares a default timeout; workflow setting for the run timeout. Cancellation propagates to plugins via gRPC cancellation or HTTP abort, with a "cancelled" execution state. |
| 11 | **Sandboxed code and a Python Code node** | Safe execution of user code in shared or multi-tenant setups. Data and ML users get Python. | Windmill nsjail and PID namespaces (off by default), with `no_network` annotation; ~10 languages; Kestra task runners (Docker, K8s, Batch, VMs); Windmill per-script dependencies without package files | **Core** (sandboxing, if any multi-user or hosted deployment), **important** (Python) | Run the Code node out of process as a "code runner" plugin (Landflow already supports Python and Go plugins), wrapped in nsjail, gVisor, Firecracker or a container, with CPU, memory and network limits. Resolve and cache per-node dependencies (requirements/package specs). Retire in-process `node:vm` for untrusted code. |
| 12 | **CLI, workflows as code and git sync** | Code review of workflow changes, CI/CD, backups, reuse across instances. | Windmill CLI, git sync and infrastructure as code; Trigger.dev CLI (`init`/`dev`/`deploy`/`tasks trigger`); Kestra YAML, VS Code extension, Terraform and git-managed blueprints | **Important** | Stable, diff-friendly JSON or YAML export (stable node IDs, sorted keys, credentials referenced by name). `landflow` CLI: `login`, `pull`, `push`, `run`, `test`, `logs`. Git sync job that pushes on publish. Consider a TS or Python SDK that emits the same JSON (code-defined workflows rendered in the editor, Kestra-style round-trip). |
| 13 | **Environments, promotion and previews** | Separate dev/staging/prod credentials and data; promote reviewed changes; per-branch previews. | Trigger.dev envs with separate API keys and preview branches with auto-archive; Windmill dev workspaces, workspace forks, deploy-to-prod and protection rulesets; Kestra Promote with diffs and drift (EE) | **Important** | Projects or workspaces with an environment attribute. Credentials and variables resolved per environment. "Promote" copies a published version to the next environment (via git sync or API) with a diff view. |
| 14 | **Local dev and testing for flows** | Iterate locally, write regression tests with fixtures, run them in CI. | Trigger.dev `dev` (local code, server scheduling, hot reload); Inngest Dev Server; Windmill local dev, VS Code, CI test scripts and step mocking; Kestra unit tests with `expectedState` | **Important** | `landflow dev` runs the host plus local plugins with hot reload (plugins already autodiscover by port scan). Test files hold pinned input fixtures plus assertions on node outputs and final status, run with `landflow test` in CI. Reuse partial-execution and pinned-data machinery. |
| 15 | **Binary and file storage** | Handle PDFs, images and CSVs without bloating execution JSON. Required for scale-out. | n8n requires S3 binary mode in queue mode; Windmill S3/Azure/GCS and volumes; Trigger.dev >512 KB offload; Temporal External Storage; Kestra internal storage and `PurgeStorage` | **Important** (core once queue mode exists) | Binary-data abstraction: items carry `{binaryRef, mime, size}`; bytes go to filesystem (single node) or S3-compatible storage. Plugins fetch them via signed URLs or a gRPC stream. Apply the same mechanism to large JSON outputs. Retention and purge policy. |
| 16 | **Secrets manager integration** | Credentials live in Vault, AWS or GCP secret stores; rotation; no plaintext in exports. | Windmill encrypted secrets with key-rotation re-encryption; Activepieces vault; Trigger.dev secret env vars | **Important** | Credential store backed by an encryption key (KMS-wrappable), plus external-secret providers resolved at runtime. Git sync exports references only. |
| 17 | **Flows as MCP tools / agent tools** | AI agents (Claude, Cursor and others) can call workflows as tools; 2026 table stakes. | Kestra 2.0 MCP Tool Trigger and per-tenant MCP server (OSS); Activepieces MCP piece ("MCP Tool" trigger plus "Reply to MCP Client") and MCP server; Windmill MCP triggers (2026-07-28 spec) | **Important** | MCP server endpoint on the host. Any workflow with an "MCP Tool" trigger is listed, with its input schema from the trigger descriptor, and a "Respond" node returns results. Durable runs (item 1) let tools be long-running. |
| 18 | **Replay, bulk rerun and error workflows** | Fix a bug, then replay failed runs with the new code or modified input; central alerting. | Trigger.dev `runs.replay()` with modified payload; Windmill flow error handler and critical alerts; Inngest Replay (announced in its January 2024 launch week) | **Important** | Executions are already stored: add "replay from node X" and bulk replay filtered by status or time on the latest published version. Add a workflow-level "error workflow" setting. |
| 19 | **Sub-workflows and composition** (call a workflow and await its result) | Reuse and modular flows. | Node-RED subflows and `node.linkcall`; Windmill `taskFlow()`; Kestra `Loop` sub-executions and `subflow()`; Trigger.dev `triggerAndWait` (version-locked child) | **Important** (verify whether Landflow already has an Execute Workflow node) | "Execute Workflow" node that, with durability, becomes a child execution the parent waits on durably, pinned to a version. |
| 20 | **Persistent state, KV and data tables** | Remember cursors, dedupe sets and counters across runs; lightweight tables for agents and flows. | Node-RED node/flow/global context with memory or filesystem stores; Activepieces Tables; Windmill data tables (SQL migrations) and instance DB; Restate K/V state per Virtual Object | **Nice-to-have** (KV is cheap and useful) | Workflow-scoped and global KV in the DB, exposed through expressions and a "Data Store" node. Optional tables later. |
| 21 | **Auto-generated UIs and app builder** | Turn a workflow into an internal tool or form for non-builders. | Windmill auto-generated UIs from JSON Schema, full-code React/Svelte apps (low-code editor now "legacy") and public apps; Kestra apps (1.3 Copilot support) | **Nice-to-have** | Start with a "Form trigger" page generated from the trigger's input schema (descriptor contract), public or authenticated. Defer a full app builder; even Windmill moved from low-code to full-code apps. |
| 22 | **Multi-tenant fairness and priority** | Prevent one tenant's backlog from starving others in hosted or embedded scenarios. | Temporal Priority & Fairness (GA 2026-05-05); Inngest multi-tenancy keys (key-queue scheduling Enterprise); Hatchet `GROUP_ROUND_ROBIN` | **Nice-to-have** (important only if Landflow is offered as SaaS or embedded) | Round-robin dequeue by key in the queue (Hatchet pattern), on top of item 4. |
| 23 | **Governance** (RBAC, audit logs, policies, protection rules) | Enterprise readiness. | Kestra Policies, RBAC (159 permissions) and Cases (EE); Windmill protection rulesets and audit logs; Activepieces SSO/SCIM and SIEM audit logs | **Nice-to-have** (for now) | Later phase; the audit log can piggyback on the execution and version stores. |

#### Adoption patterns for a visual tool (synthesis)
- **Do not adopt code-replay determinism.** Landflow's graph interpreter is the deterministic orchestrator. Adopt *step memoization at node granularity* instead (Inngest, Windmill WAC, Hatchet), plus *version pinning by snapshot* (Trigger.dev, Kestra drafts).
- **Build vs embed:**
  - **Option A, build in (recommended for an n8n-like product):** a Postgres-backed queue, node-run checkpoint table and waitpoint table, as Hatchet, Kestra OSS (JDBC) and n8n (DB plus Redis) do. This keeps single-binary self-hosting simple.
  - **Option B, embed an engine:** run each Landflow execution as one durable workflow whose code is a generic graph interpreter. Each node or plugin call becomes an Activity (Temporal) or a `ctx.run`/service call (Restate), or a Hatchet task. This gives durability, timers and signals for free, but adds an operational dependency and makes payload-size limits a concern (Inngest 4 MiB per step and 32 MiB per run; Trigger.dev 10 MB payloads). Restate's proxy-in-front-of-HTTP-services design is the closest match to Landflow's HTTP/gRPC plugins.
- **Blend code and flows like Windmill:** keep the visual canvas, but let any node be a script in any language running in a sandboxed runner. Let workflows be authored or edited as files with a CLI and git sync. Kestra 2.0's "no-code editor synced with YAML" shows the round-trip can be done.
- **Dependency order for the roadmap:**
  1. DB-backed execution store plus node checkpoints (1).
  2. Queue and workers, timeouts and cancellation (4, 10).
  3. Durable wait, approvals, idempotency, concurrency and rate limits, version pinning (2, 3, 5–8).
  4. Cron (9), binary storage and secrets (15, 16).
  5. CLI, git, environments and tests (12–14).
  6. MCP, replay and sub-workflows (17–19).
  7. Then the nice-to-haves.

### Gaps
- Licences for Temporal, Restate, Trigger.dev and Windmill were not verified this session. This matters if Landflow considers embedding (Option B) or borrowing code.
- I did not benchmark the payload and size limits of Restate, Hatchet or Temporal; only Inngest's and Trigger.dev's are cited.
- The Landflow inventory does not say whether it has sub-workflow, error-workflow or static-data features. Items 18–20 assume they are missing and should be checked against the codebase.
- I found no primary Pipedream announcement page for the Workflows shutdown, only the in-docs banner and third-party posts. The data-deletion date (2027-04-30) and the "Connect unaffected" claim come only from third parties.
