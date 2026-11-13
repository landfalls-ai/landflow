/**
 * The configuration catalog: one entry per environment variable the host reads (and the few its plugins read), with the
 * default and description that the generated docs/reference/configuration.md shows (`pnpm --filter @landflow/web
 * gen:config-docs`), whether the value is a secret (checkConfig redacts it and refuses a development value in the
 * production profile) and what the production profile asks of it. test/config-catalog.test.ts fails when the source
 * reads a name that is not here: add the variable here first, then regenerate the page.
 */

export type ConfigGroup = 'security' | 'data' | 'execution' | 'urls' | 'plugins' | 'binary' | 'ai' | 'observability' | 'auth' | 'mcp' | 'sourcecontrol' | 'plugin';

export interface ConfigVariable {
  /** The variable name; `LANDFLOW_TRANSPORT_<KIND>_URL` stands for a family. */
  name: string;
  /** The default as the page shows it (markdown): the value, or how it is derived. */
  default: string;
  /** What it does, in markdown, as the page shows it. */
  description: string;
  group: ConfigGroup;
  /** A secret: shown as `[set]` in the effective configuration, and a development value is an error in production. */
  secret?: boolean;
  /** A URL that may carry a password in its user info: the password is redacted in the effective configuration. */
  urlCredentials?: boolean;
  /** What the production profile asks: an error when missing, or a warning. */
  profile?: 'required-in-production' | 'recommended-in-production';
  /** Another variable that waives the production requirement when it is a true flag. */
  waivedBy?: string;
  /** Another variable that meets the production requirement instead when it is set (any value). */
  satisfiedBy?: string;
  /** The rest of the message when the production requirement is not met. */
  productionNote?: string;
  /** Who reads it: the host (default), the plugins, or both. */
  readBy?: 'host' | 'plugins' | 'both';
  /** Deprecated names that still work. */
  aliases?: string[];
}

/** The titles of the page's sections, in page order. */
export const CONFIG_GROUPS: Record<ConfigGroup, string> = {
  security: 'Security and profile',
  data: 'Data and database',
  execution: 'Execution, queue and workers',
  urls: 'Addresses and time',
  plugins: 'Plugins, code and marketplace',
  binary: 'Binary data',
  ai: 'AI, agents and usage',
  observability: 'Observability',
  auth: 'Authentication',
  mcp: 'MCP gateway',
  sourcecontrol: 'Environments, secrets and source control',
  plugin: 'Read by plugins',
};

export const CONFIG_CATALOG: readonly ConfigVariable[] = [
  // Security and profile
  { name: 'LANDFLOW_PROFILE', group: 'security', default: '`production` when `NODE_ENV=production`, else `development`', description: '`development` or `production`: whether the host refuses development secrets and a missing `LANDFLOW_PUBLIC_URL` ("Production profile" in [deployment.md](../deployment.md)). The in-repo compose and Kubernetes stacks set `development`' },
  { name: 'LANDFLOW_OUTBOUND_BLOCK_PRIVATE', group: 'security', default: '`true` in the production profile, `false` in development', description: 'whether `safeFetch` refuses loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local, CGNAT (100.64/10), multicast and metadata addresses for the HTTP Request node, alert channels, HTTP SIEM destinations, remote MCP servers, RAG embeddings, OpenAI-compatible model calls and rerank to a credential\'s Base URL, in-process plugins\' load-options and credential tests, and OIDC/SAML metadata, including through redirects and DNS names ([audit-and-governance.md](../features/audit-and-governance.md#outbound-requests))' },
  { name: 'LANDFLOW_OUTBOUND_ALLOW', group: 'security', default: '–', description: 'comma-separated host names (`*.corp.example` works), IP addresses and CIDR ranges that stay reachable with blocking on. The exact endpoints (host and port) of `OLLAMA_URL` (or its default), `LANDFLOW_CODE_RUNNER_URL`, `OPENAI_BASE_URL`, `LANDFLOW_MCP_GATEWAY_PUBLIC_URL`, `LANDFLOW_GITHUB_MCP_URL` (or its in-cluster default) and `LANDFLOW_OIDC_DISCOVERY_URL` are always allowed; an in-cluster identity provider\'s other endpoints (token, JWKS) need an entry here' },
  { name: 'LANDFLOW_CSP', group: 'security', default: '`enforce` in the production profile, else `report`', description: '`enforce`, `report` (Report-Only, visible in the browser console) or `off`: the nonce-based Content Security Policy on pages ([deployment.md](../deployment.md#security-headers-and-content-security-policy))' },
  { name: 'LANDFLOW_HSTS', group: 'security', default: 'on over https', description: '`off` drops the `Strict-Transport-Security` header' },
  { name: 'LANDFLOW_REGISTRY_OPEN', group: 'security', default: '–', description: '`true`: accept plugin registrations without `LANDFLOW_REGISTRY_SECRET` in the production profile (the development profile accepts them anyway; see [plugins.md](../plugins.md#registration-rules))' },
  { name: 'LANDFLOW_REGISTRY_ALLOW_JOIN', group: 'security', default: '–', description: '`true`: without `LANDFLOW_REGISTRY_SECRET`, let an announced endpoint on a new host join a plugin that already exists (loopback addresses count as one host)' },
  { name: 'LANDFLOW_TRUSTED_PROXIES', group: 'security', default: '`0`', description: 'how many reverse proxies sit in front of the host (0 to 16): the client address is the `X-Forwarded-For` entry that many from the end, and `X-Forwarded-Host`/`-Proto` and `X-Real-IP` are read only when it is 1 or more. Unset in the production profile logs a warning ([authentication](../features/authentication.md#client-addresses-and-emailed-links))' },
  { name: 'LANDFLOW_RESUME_SIGNATURES', group: 'security', default: '`required` in production, `optional` in development', description: '`required`: resume URLs carry `?sig=` and a wait saved as signed needs it (403 otherwise); `optional`: URLs are unsigned and unsigned calls work, a wrong `sig` is refused ([engine](../features/engine.md))' },
  { name: 'LANDFLOW_ENCRYPTION_KEY', group: 'security', default: 'generated into `.data/encryption.key` (once, atomically: processes starting together share it)', description: 'the legacy key (kid `k0`) of the credentials vault: 64 hex characters, or a passphrase (stretched with scrypt; data sealed with the old SHA-256 form still opens). It opens old data and seals new data only while `LANDFLOW_ENCRYPTION_KEYS` is unset', secret: true, profile: 'recommended-in-production', satisfiedBy: 'LANDFLOW_ENCRYPTION_KEYS', productionNote: 'the key file under the data directory is used' },
  { name: 'LANDFLOW_ENCRYPTION_KEYS', group: 'security', default: '–', description: 'the key ring, `kid:key,kid:key`: the first key seals everything new, the others (and `LANDFLOW_ENCRYPTION_KEY` as `k0`) only open older data. A key is 64 hex characters or a passphrase (scrypt). Rotate by putting a new key first on every process, then `POST /api/settings/encryption/rotate` (or `pnpm --filter @landflow/web rotate-key`), and drop an old key only after it reports no failures ([secrets](../features/secrets-and-environments.md))', secret: true },
  { name: 'LANDFLOW_REGISTRY_SECRET', group: 'security', default: '–', description: 'shared secret plugins must send to `/api/plugins/announce` and the gRPC registry (set it on the plugins too); with it set, every announced endpoint must also prove it holds it (the SDKs answer by themselves). In the production profile, with neither the secret nor `LANDFLOW_REGISTRY_OPEN`, announces are refused (401)', secret: true, profile: 'required-in-production', waivedBy: 'LANDFLOW_REGISTRY_OPEN', productionNote: 'plugins could register without proof (set it, or LANDFLOW_REGISTRY_OPEN=true to accept that)', readBy: 'both' },
  { name: 'LANDFLOW_TRANSPORT_SECRET', group: 'security', default: 'falls back to `LANDFLOW_REGISTRY_SECRET`', description: 'the key that signs and encrypts broker messages, the same on the host and every brokered plugin; without any secret the host opens no broker connection. `LANDFLOW_TRANSPORT_SECRET_PREVIOUS` (comma-separated) lists old secrets that still verify. See [transports.md](../transports.md#security-over-brokers)', secret: true, readBy: 'both' },
  { name: 'LANDFLOW_METRICS_PUBLIC', group: 'security', default: '`false`', description: '`true` lets Prometheus scrape `/api/metrics` without an API key' },
  { name: 'LANDFLOW_TRANSPORT_SECRET_PREVIOUS', group: 'security', default: '–', description: 'comma-separated old transport secrets that still verify and decrypt, for rotation ([transports.md](../transports.md#security-over-brokers))', secret: true },
  // Data and database
  { name: 'LANDFLOW_DATA_DIR', group: 'data', default: '`apps/web/.data`', description: 'data directory: the SQLite database (`landflow.db`), credentials, binary files, the Claude Code plugin images packed for kagent (`oci/`) and the other host files' },
  { name: 'LANDFLOW_DB_STATEMENT_CACHE', group: 'data', default: '`500`', description: 'most prepared SQL statements one database connection keeps (least recently used go first)' },
  { name: 'LANDFLOW_CLAUDE_PLUGINS_DIR', group: 'data', default: '`<cwd>/claude-plugins` (`apps/web/claude-plugins`)', description: 'where Landflow\'s own Claude Code plugins are (the landflow-harness mod), packed into images for kagent\'s Claude Code agents ([a2a.md](../a2a.md#the-landflow-harness-mod))' },
  { name: 'LANDFLOW_DB', group: 'data', default: '`sqlite`', description: '`postgres` keeps the store in Postgres (`DATABASE_URL`); one host per database' },
  { name: 'DATABASE_URL', group: 'data', default: '–', description: 'Postgres connection string for `LANDFLOW_DB=postgres`, e.g. the infra stack\'s `postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow`', urlCredentials: true },
  { name: 'LANDFLOW_PG_BLOCKED_RETRY_SECONDS', group: 'data', default: '`60`', description: 'Postgres mode: seconds between retries of a write batch Postgres rejects while the store is blocked (minimum 1) ([postgres-write-queue.md](../features/postgres-write-queue.md))' },
  { name: 'LANDFLOW_PG_SKIP_BATCH', group: 'data', default: '–', description: 'Postgres mode: a batch sequence number to set aside at boot (written to `<data dir>/postgres-rejected-<seq>.jsonl`, or `postgres-rejected-<instance>-<seq>.jsonl` in queue mode) instead of replaying it' },
  { name: 'LANDFLOW_PG_SPOOL_FSYNC', group: 'data', default: '`interval`', description: 'Postgres mode, spool durability: `interval` (fdatasync at most every 100 ms), `always` (after each append) or `off`' },
  { name: 'LANDFLOW_CONFIG_STORE', group: 'data', default: '`database` in queue mode, else `files`', description: 'where credentials and the settings files (mcp.json, marketplaces.json, skill-library.json, agent-channels.json) live: the database (imported once from the files) or the data directory' },
  // Execution, queue and workers
  { name: 'LANDFLOW_EXECUTIONS_MODE', group: 'execution', default: '`regular`', description: '`queue`: mains enqueue production runs on Valkey for workers (`pnpm worker`) and elect a leader ("Queue mode, workers and high availability")' },
  { name: 'LANDFLOW_VALKEY_URL', group: 'execution', default: '`redis://127.0.0.1:6379`', description: 'queue mode\'s Valkey (`rediss://` for TLS, `redis://user:password@host:port/db`). `memory` keeps the queue, locks and caches inside this one process: for tests and single-process demos only, never with a second host or worker', urlCredentials: true },
  { name: 'LANDFLOW_VALKEY_SENTINELS', group: 'execution', default: '–', description: 'find the primary through Valkey Sentinel (`host:port,…`) and follow failovers; `LANDFLOW_VALKEY_SENTINEL_USERNAME` / `LANDFLOW_VALKEY_SENTINEL_PASSWORD` when the sentinels require AUTH, `LANDFLOW_VALKEY_SENTINEL_TLS=true` when they speak TLS (all `–` / `false` by default)' },
  { name: 'LANDFLOW_VALKEY_MASTER_NAME', group: 'execution', default: '`mymaster`', description: 'find the primary through Valkey Sentinel (`host:port,…`) and follow failovers; `LANDFLOW_VALKEY_SENTINEL_USERNAME` / `LANDFLOW_VALKEY_SENTINEL_PASSWORD` when the sentinels require AUTH, `LANDFLOW_VALKEY_SENTINEL_TLS=true` when they speak TLS (all `–` / `false` by default)' },
  { name: 'LANDFLOW_VALKEY_CLUSTER', group: 'execution', default: '–', description: 'run on a Valkey (or Redis) Cluster: seed nodes (`host:port,…`; every key carries one hash tag, so this is failover, not scale-out), and `announced:port=reachable:port,…` for clusters that announce addresses you can\'t reach. Not together with Sentinel (refused at start); see [engine.md](../features/engine.md#queue-mode-workers-and-high-availability)' },
  { name: 'LANDFLOW_VALKEY_CLUSTER_NAT', group: 'execution', default: '–', description: 'run on a Valkey (or Redis) Cluster: seed nodes (`host:port,…`; every key carries one hash tag, so this is failover, not scale-out), and `announced:port=reachable:port,…` for clusters that announce addresses you can\'t reach. Not together with Sentinel (refused at start); see [engine.md](../features/engine.md#queue-mode-workers-and-high-availability)' },
  { name: 'LANDFLOW_QUEUE_PREFIX', group: 'execution', default: '`landflow`', description: 'Valkey key prefix, so several installs can share one Valkey' },
  { name: 'LANDFLOW_INSTANCE_ID', group: 'execution', default: '`<role>-<hostname>-<pid>`', description: 'this process\'s name in the cluster (and its Postgres spool file); set a stable, unique one per process' },
  { name: 'LANDFLOW_WORKER_CONCURRENCY', group: 'execution', default: '`10`', description: 'runs a worker takes at once' },
  { name: 'LANDFLOW_MAX_RUNS', group: 'execution', default: '`0` (no cap)', description: 'regular mode: production runs (webhook, trigger, poll) a process runs at once across workflows; the rest wait, ordered by workflow **Priority**' },
  { name: 'LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS', group: 'execution', default: '`false`', description: 'queue mode: editor runs go to the workers too' },
  { name: 'LANDFLOW_QUEUE_ALLOW_SQLITE', group: 'execution', default: '`false`', description: 'allow queue mode on SQLite, every process on one host sharing the file' },
  { name: 'LANDFLOW_LEADER_TTL_SECONDS', group: 'execution', default: '`10`', description: 'leader lease (failover in TTL + TTL/3) / how long a silent worker keeps its jobs' },
  { name: 'LANDFLOW_STALLED_SECONDS', group: 'execution', default: '`30`', description: 'leader lease (failover in TTL + TTL/3) / how long a silent worker keeps its jobs' },
  { name: 'LANDFLOW_SHUTDOWN_SECONDS', group: 'execution', default: '`25`', description: 'a main\'s whole shutdown budget on SIGTERM / SIGINT, shared by its phases ([Stopping the host](../deployment.md#stopping-the-host))' },
  { name: 'LANDFLOW_READY_MAX_WRITE_LAG_SECONDS', group: 'execution', default: '`30`', description: 'how old the oldest queued Postgres write may be before `GET /api/health/ready` answers 503 ([Probes](../deployment.md#probes))' },
  { name: 'NEXT_MANUAL_SIG_HANDLE', group: 'execution', default: 'set by `pnpm start` and the Docker image', description: '`true` leaves SIGTERM / SIGINT to Landflow\'s graceful shutdown instead of Next.js\'s own exit; not available in `next dev`' },
  { name: 'LANDFLOW_WORKER_PORT', group: 'execution', default: '`5690`', description: 'a worker\'s `/healthz` and `/metrics` (`0` = off) / how long SIGTERM lets runs finish before re-queuing them' },
  { name: 'LANDFLOW_WORKER_SHUTDOWN_SECONDS', group: 'execution', default: '`30`', description: 'a worker\'s `/healthz` and `/metrics` (`0` = off) / how long SIGTERM lets runs finish before re-queuing them' },
  { name: 'LANDFLOW_IDEMPOTENCY_TTL_HOURS', group: 'execution', default: '`24`', description: 'how long trigger idempotency keys are remembered' },
  { name: 'LANDFLOW_APP_WEBHOOK_RETRY_MS', group: 'execution', default: '`60000`', description: 'how often app webhook registrations that failed at publish are retried (minimum 1000)' },
  { name: 'LANDFLOW_APP_WEBHOOK_MAX_BYTES', group: 'execution', default: '`26214400` (25 MiB)', description: 'largest body an app webhook trigger accepts (larger ones are refused)' },
  { name: 'LANDFLOW_AGENT_CHANNEL_POLL_SECONDS', group: 'execution', default: '`5`', description: 'how often an agent\'s Telegram channel is polled for new messages (at least `2`)' },
  { name: 'LANDFLOW_EXECUTE_TIMEOUT_MS', group: 'execution', default: '`120000`', description: 'per remote Execute call (and per call to the code runner); minimum 1000 for plugin calls' },
  { name: 'LANDFLOW_RETENTION_EVERY', group: 'execution', default: '50', description: 'finished runs between retention passes (minimum 1: `0` or a fraction counts as 1); the hourly timer and Prune now run regardless, so the count may exceed its cap by up to N-1 between passes ([features/settings-and-data.md](../features/settings-and-data.md))' },
  { name: 'LANDFLOW_APPROVAL_EMAIL_TTL_HOURS', group: 'execution', default: '`24`', description: 'hours an Approve or Reject link in an approval email stays valid (minimum 1)' },
  { name: 'LANDFLOW_ROLE', group: 'execution', default: '`main`', description: '`main` (UI, API, webhooks) or `worker`; `pnpm worker` sets `worker`' },
  { name: 'LANDFLOW_VALKEY_SENTINEL_USERNAME', group: 'execution', default: '–', description: 'user for the sentinels themselves, when they require AUTH' },
  { name: 'LANDFLOW_VALKEY_SENTINEL_PASSWORD', group: 'execution', default: '–', description: 'password for the sentinels themselves, when they require AUTH', secret: true },
  { name: 'LANDFLOW_VALKEY_SENTINEL_TLS', group: 'execution', default: '`false`', description: '`true` when the sentinels speak TLS' },
  // Addresses and time
  { name: 'LANDFLOW_PUBLIC_URL', group: 'urls', default: '`http://localhost:$PORT`', description: 'public base URL in the links the host hands out: resume URLs (`$execution.resumeUrl`, `resumeFormUrl`), error workflow and failure alert execution links, the OAuth2 redirect URL, and the URL app webhook triggers register (`<public URL>/api/webhook/app/…`, so it must be reachable by the service)', profile: 'required-in-production', productionNote: 'links in emails, alerts and OAuth redirects need the address users reach the host at' },
  { name: 'LANDFLOW_OAUTH2_REDIRECT_URL', group: 'urls', default: '`<public URL>/api/oauth2/callback`', description: 'the redirect URL OAuth2 Connect sends to providers (register it there); without either variable, the request\'s origin' },
  { name: 'GENERIC_TIMEZONE', group: 'urls', default: 'the host\'s zone', description: 'the instance\'s default time zone until one is chosen in Settings → General' },
  { name: 'LANDFLOW_INTERNAL_URL', group: 'urls', default: '`http://127.0.0.1:$PORT`', description: 'the host URL plugins use for `/api/binary` (e.g. `http://web:3000` in Docker)' },
  { name: 'LANDFLOW_VERSION', group: 'urls', default: '`dev`', description: 'the version the host reports as `serverInfo.version` on its MCP endpoint' },
  // Plugins, code and marketplace
  { name: 'LANDFLOW_REGISTRY_GRPC_PORT', group: 'plugins', default: '`7070`', description: 'gRPC RegistryService (`off` to disable)' },
  { name: 'LANDFLOW_PLUGINS', group: 'plugins', default: '–', description: 'static plugin endpoints' },
  { name: 'LANDFLOW_SCAN_HOSTS', group: 'plugins', default: '`127.0.0.1`', description: 'pull discovery (the compose file sets the ports to `7101-7107,7111-7114,7116-7118,7201-7207,7211-7214,7216-7218`)' },
  { name: 'LANDFLOW_SCAN_PORTS', group: 'plugins', default: '`7100-7299`', description: 'pull discovery (the compose file sets the ports to `7101-7107,7111-7114,7116-7118,7201-7207,7211-7214,7216-7218`)' },
  { name: 'LANDFLOW_SCAN_ON_START', group: 'plugins', default: '`true`', description: 'scan at boot' },
  { name: 'LANDFLOW_PLUGIN_DISCOVERY', group: 'plugins', default: '–', description: '`kubernetes`: discover plugins from labelled Services; `LANDFLOW_K8S_NAMESPACES` (`*`: every namespace), `LANDFLOW_K8S_SPREAD` (`pods`: calls spread over the ready pods, or `service`), `LANDFLOW_K8S_CONTEXT`, `LANDFLOW_K8S_ADDRESS`, `LANDFLOW_K8S_CLUSTER_DOMAIN`, `LANDFLOW_K8S_LABEL_SELECTOR`, `LANDFLOW_K8S_RESYNC_SECONDS` in [deployment.md, "Kubernetes"](../deployment.md#kubernetes)' },
  { name: 'LANDFLOW_CODE_RUNNER_URL', group: 'plugins', default: '–', description: 'the Code node\'s sandbox, e.g. `http://127.0.0.1:7300` (pnpm) or `http://127.0.0.1:53300` (Docker); set: the sandbox is the default and Python works', profile: 'recommended-in-production', waivedBy: 'LANDFLOW_CODE_IN_PROCESS', productionNote: 'Code nodes fail (they no longer run inside the host in production; set a runner, or LANDFLOW_CODE_IN_PROCESS=true to accept that)' },
  { name: 'LANDFLOW_CODE_RUNNER_SECRET', group: 'plugins', default: '–', description: 'shared secret, the runner\'s `CODE_RUNNER_SECRET`', secret: true, readBy: 'both' },
  { name: 'LANDFLOW_CODE_IN_PROCESS', group: 'plugins', default: '`true` in development, `false` in production', description: '`true` / `false`: in-process (`node:vm`, not isolated) JavaScript for Code nodes. Unset follows the profile (`LANDFLOW_PROFILE`): the production profile runs Code nodes in the code runner and fails without one, unless this is `true`' },
  { name: 'LANDFLOW_CODE_BINARY_MAX_BYTES', group: 'plugins', default: '`6291456`', description: 'files a Code node reads (all together) and creates, in the sandbox and in-process' },
  { name: 'LANDFLOW_MARKETPLACE_PORTS', group: 'plugins', default: '`7250-7299`', description: 'the port range marketplace node plugins get (one range per process when several share a host); a range outside 1024-65535 falls back to the default. See [marketplace.md](../marketplace.md#landflow-node-plugins)' },
  { name: 'LANDFLOW_MARKETPLACE_REGISTRY_URL', group: 'plugins', default: '`<public URL>`, else `http://127.0.0.1:$PORT`', description: 'the host URL marketplace node plugins announce to' },
  { name: 'LANDFLOW_MARKETPLACE_ALLOW_LOCAL', group: 'plugins', default: '–', description: '`1` lets a marketplace be a directory on the host (tests and checkouts; off by default so the API can\'t read the host\'s disk)' },
  { name: 'LANDFLOW_TEMPLATES_URL', group: 'plugins', default: '–', description: 'an n8n-compatible templates API to search in the templates library, e.g. `https://api.n8n.io/api` (answers cached 10 minutes)' },
  { name: 'LANDFLOW_TRANSPORT_<KIND>_URL', group: 'plugins', default: '–', description: 'a read-only broker connection per kind (`LANDFLOW_TRANSPORT_KAFKA_URL`, `LANDFLOW_TRANSPORT_NATS_URL=nats://user:pass@nats:4222`, likewise rabbitmq and the rest; the URL\'s user info becomes the secrets), listed in Settings → Transports. `http` and `grpc` are not brokers and are skipped', urlCredentials: true },
  { name: 'LANDFLOW_CLAIM_STORE', group: 'plugins', default: '–', description: 'where a broker body over the broker\'s limit goes by reference: `s3://<bucket>/<prefix>?endpoint=<url>&region=<region>&forcePathStyle=true` (`memory://` for tests); unset, such a call fails `too_large`. See [deployment.md](../deployment.md) and [transports.md](../transports.md#delivery-rules-all-brokers)', urlCredentials: true },
  { name: 'LANDFLOW_CLAIM_ACCESS_KEY_ID', group: 'plugins', default: 'AWS chain', description: 'the claim store bucket\'s access key (else `AWS_ACCESS_KEY_ID`); without static keys, see the credential chain in [deployment.md](../deployment.md#the-claim-check-oversized-broker-bodies)', readBy: 'both' },
  { name: 'LANDFLOW_CLAIM_SECRET_ACCESS_KEY', group: 'plugins', default: 'AWS chain', description: 'the claim store bucket\'s secret key (else `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`)', secret: true, readBy: 'both' },
  { name: 'LANDFLOW_K8S_NAMESPACES', group: 'plugins', default: 'the host\'s own namespace', description: 'namespaces watched for plugin Services (`*`: every namespace, with one cluster-wide list and watch per kind)' },
  { name: 'LANDFLOW_K8S_SPREAD', group: 'plugins', default: '`pods`', description: '`pods`: calls spread over the ready pods of a Service; `service`: one client on the Service address' },
  { name: 'LANDFLOW_K8S_CONTEXT', group: 'plugins', default: '–', description: 'kubeconfig context to use, even inside a pod (unset: in-cluster inside a pod, else the current context)' },
  { name: 'LANDFLOW_K8S_ADDRESS', group: 'plugins', default: '`dns`', description: '`dns` or `cluster-ip`: how a discovered Service is addressed' },
  { name: 'LANDFLOW_K8S_CLUSTER_DOMAIN', group: 'plugins', default: '–', description: 'the cluster\'s DNS suffix, when it is not `cluster.local`' },
  { name: 'LANDFLOW_K8S_LABEL_SELECTOR', group: 'plugins', default: '–', description: 'extra label selector for discovered Services' },
  { name: 'LANDFLOW_K8S_RESYNC_SECONDS', group: 'plugins', default: '`300`', description: 'seconds between full re-lists of the watched Services (0: never)' },
  { name: 'GITHUB_TOKEN', group: 'plugins', default: '–', description: 'token for reading GitHub marketplace sources, for higher rate limits; sent only to GitHub\'s own hosts', secret: true },
  // Binary data
  { name: 'LANDFLOW_BINARY_STORE', group: 'binary', default: '`filesystem`', description: 'where files live: `filesystem` or `s3`' },
  { name: 'LANDFLOW_BINARY_DIR', group: 'binary', default: '`<data dir>/binary`', description: 'the filesystem store\'s directory' },
  { name: 'LANDFLOW_S3_BUCKET', group: 'binary', default: '–', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)' },
  { name: 'LANDFLOW_S3_ENDPOINT', group: 'binary', default: 'AWS', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)' },
  { name: 'LANDFLOW_S3_REGION', group: 'binary', default: '`us-east-1`', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)' },
  { name: 'LANDFLOW_S3_ACCESS_KEY_ID', group: 'binary', default: 'AWS chain', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)' },
  { name: 'LANDFLOW_S3_SECRET_ACCESS_KEY', group: 'binary', default: 'AWS chain', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)', secret: true },
  { name: 'LANDFLOW_S3_FORCE_PATH_STYLE', group: 'binary', default: '`true`', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)' },
  { name: 'LANDFLOW_S3_PREFIX', group: 'binary', default: '`binary/`', description: 'the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`)' },
  { name: 'LANDFLOW_BINARY_MAX_BYTES', group: 'binary', default: '`268435456` (256 MiB)', description: 'largest stored file or upload (413 above it)' },
  { name: 'LANDFLOW_BINARY_MAX_INLINE_BYTES', group: 'binary', default: '`16777216` (16 MiB)', description: 'largest inline (base64) file a node may return' },
  { name: 'LANDFLOW_BINARY_SECRET', group: 'binary', default: 'random per process', description: 'key that signs plugins\' binary tokens; set it when several host processes serve one store', secret: true, profile: 'recommended-in-production', productionNote: 'binary links are signed with a key derived from the encryption key' },
  { name: 'LANDFLOW_FILES_DIR', group: 'binary', default: '`<data dir>/files`', description: 'the only directory Read/Write Files from Disk may use' },
  // AI, agents and usage
  { name: 'ANTHROPIC_API_KEY', group: 'ai', default: '–', description: 'for the Anthropic Chat Model', secret: true },
  { name: 'OLLAMA_URL', group: 'ai', default: '`http://127.0.0.1:11434`', description: 'the Ollama used by the AI flow builder and the editor assistant, and the default of the Ollama chat and embeddings nodes' },
  { name: 'LANDFLOW_BUILDER_MODEL', group: 'ai', default: '`qwen3-coder:30b`', description: 'model the AI flow builder, the editor assistant and the brain\'s analyst use: an Ollama model name, `anthropic/<model>` (e.g. `anthropic/claude-sonnet-5-5`, with `ANTHROPIC_API_KEY` or `ant auth login`) or `openai/<model>` (with `OPENAI_API_KEY`, `OPENAI_BASE_URL`)' },
  { name: 'LANDFLOW_BUILDER_TIMEOUT_SECONDS', group: 'ai', default: '`600`', description: 'how long the AI flow builder (Describe a workflow, Spotlight\'s first draft) waits for the model; it reads the whole node catalog first, so a slow local model with many plugins online needs minutes' },
  { name: 'LANDFLOW_TOOL_POLICY', group: 'ai', default: '`rules`', description: 'an external policy engine (`opa` or `openfga`) that also decides which tools an agent\'s caller may use; an unreachable engine denies unless `LANDFLOW_TOOL_POLICY_FAIL=open` ([agents.md](../agents.md#tool-access))' },
  { name: 'LANDFLOW_TOOL_POLICY_URL', group: 'ai', default: '–', description: 'an external policy engine (`opa` or `openfga`) that also decides which tools an agent\'s caller may use; an unreachable engine denies unless `LANDFLOW_TOOL_POLICY_FAIL=open` ([agents.md](../agents.md#tool-access))' },
  { name: 'LANDFLOW_TOOL_POLICY_TOKEN', group: 'ai', default: '–', description: 'an external policy engine (`opa` or `openfga`) that also decides which tools an agent\'s caller may use; an unreachable engine denies unless `LANDFLOW_TOOL_POLICY_FAIL=open` ([agents.md](../agents.md#tool-access))', secret: true },
  { name: 'LANDFLOW_TOOL_POLICY_FAIL', group: 'ai', default: '`closed`', description: 'an external policy engine (`opa` or `openfga`) that also decides which tools an agent\'s caller may use; an unreachable engine denies unless `LANDFLOW_TOOL_POLICY_FAIL=open` ([agents.md](../agents.md#tool-access))' },
  { name: 'LANDFLOW_STT_URL', group: 'ai', default: '`http://127.0.0.1:8000/v1`', description: 'the OpenAI-compatible speech-to-text server behind Spotlight\'s microphone ([assistant.md](../assistant.md#spotlight))' },
  { name: 'LANDFLOW_STT_MODEL', group: 'ai', default: '`whisper-1`', description: 'the OpenAI-compatible speech-to-text server behind Spotlight\'s microphone ([assistant.md](../assistant.md#spotlight))' },
  { name: 'LANDFLOW_STT_API_KEY', group: 'ai', default: '–', description: 'the OpenAI-compatible speech-to-text server behind Spotlight\'s microphone ([assistant.md](../assistant.md#spotlight))', secret: true },
  { name: 'LANDFLOW_AI_USAGE_RETENTION_DAYS', group: 'ai', default: '`400`', description: 'how long per-call AI usage rows (tokens, cost) are kept', aliases: ['AI_USAGE_RETENTION_DAYS'] },
  { name: 'LANDFLOW_BRAIN', group: 'ai', default: '`true`', description: '`false` turns the [second brain](../second-brain.md) off: no usage ledger, no detectors, no study' },
  { name: 'LANDFLOW_USAGE_RETENTION_DAYS', group: 'ai', default: '`90`', description: 'how long raw usage events are kept; daily rollups are kept 400 days', aliases: ['USAGE_RETENTION_DAYS'] },
  { name: 'LANDFLOW_BRAIN_MODEL', group: 'ai', default: 'the builder model', description: 'the model the second brain writes fixes, tips, persona rules, drafts and purposes with; `off`: rules only' },
  { name: 'LANDFLOW_BRAIN_EMBEDDINGS', group: 'ai', default: '`nomic-embed-text`', description: 'the Ollama model that embeds its facts into `landflow-brain-<project>`; `off`: keyword search only' },
  { name: 'LANDFLOW_BRAIN_INTERVAL_MINUTES', group: 'ai', default: '`60`', description: 'how often the leader rolls up, checks effects and runs the detectors (it studies once a day)' },
  { name: 'LANDFLOW_BRAIN_WEEKLY_CAP', group: 'ai', default: '`3`', description: 'suggestions per workflow per week' },
  { name: 'LANDFLOW_TEAM_PAUSE_MINUTES', group: 'ai', default: '`30`', description: 'how long a paused team member waits for a person\'s instruction before it carries on without one ([run-trace.md](../run-trace.md#pause-and-take-over))' },
  { name: 'LANDFLOW_NOTEBOOK_EMBEDDINGS', group: 'ai', default: 'on', description: '`off` stops the team notebook from asking Ollama for embeddings; search then matches words ([team-notebook.md](../team-notebook.md#search-by-meaning))' },
  { name: 'LANDFLOW_NOTEBOOK_EMBED_MODEL', group: 'ai', default: '`nomic-embed-text`', description: 'the Ollama model that embeds team notes' },
  { name: 'LANDFLOW_JSON_RENDER', group: 'ai', default: 'off', description: '`1` is the default for the json-render spec cards in Run Trace (`NEXT_PUBLIC_LANDFLOW_JSON_RENDER=1` does the same). The owner\'s switch in Settings → General (`jsonRender`, `PATCH /api/settings`) wins once saved and needs no rebuild; `null` goes back to this default. Dev page: `/runs/json-render-gallery`, shown only while it is on ([json-render verdict](../research/json-render-verdict.md))' },
  { name: 'LANDFLOW_TOOL_IMAGES_KEPT', group: 'ai', default: '2', description: 'newest tool images sent to the model each turn for every agent run other than the AI Agent node\'s own option: chat, schedules, team members (the node option `toolImagesKept`, 0 to 10, on Run an Agent and Run a Team overrides it; an agent\'s own `toolImagesKept` setting, Settings tab, "Tool images", is used by runs that set none: chat, schedules, team members. Order: the node\'s option, else the agent\'s setting, else this variable, else 2) ([features/ai.md](../features/ai.md))' },
  { name: 'OPENAI_API_KEY', group: 'ai', default: '–', description: 'key for the OpenAI-compatible assistant model, server-side only', secret: true },
  { name: 'OPENAI_BASE_URL', group: 'ai', default: '–', description: 'base URL of that OpenAI-compatible API; its endpoint stays reachable with `LANDFLOW_OUTBOUND_BLOCK_PRIVATE` on' },
  { name: 'NEXT_PUBLIC_LANDFLOW_JSON_RENDER', group: 'ai', default: 'off', description: '`1` does what `LANDFLOW_JSON_RENDER` does, and also reaches the browser bundle' },
  // Observability
  { name: 'LANDFLOW_AUDIT_OUTBOX', group: 'observability', default: '`on`', description: '`off` stops this process from delivering the audit outbox to SIEM destinations (events still queue; another host or a restart delivers them)' },
  { name: 'LANDFLOW_AUDIT_FAIL_CLOSED', group: 'observability', default: '`false`', description: '`true` makes high-value changes (role changes, API key create and revoke, credential create, update and delete, audit settings, SCIM provisioning) fail with 503 when their audit event can\'t be stored, and the change does not happen; recommended for regulated deployments. Off, a failed audit write is logged and counted in `landflow.audit.write_failures` and the change goes on ([audit-and-governance.md](../features/audit-and-governance.md#reliability-and-fail-closed-mode))' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', group: 'observability', default: '–', description: 'OTLP/HTTP endpoint for traces and metrics, e.g. `http://localhost:4318`; unset: nothing is exported' },
  { name: 'LANDFLOW_LOG_LEVEL', group: 'observability', default: '`info`', description: 'log level, `json` or `pretty`, one log line per finished span' },
  { name: 'LANDFLOW_LOG_FORMAT', group: 'observability', default: '`json`', description: 'log level, `json` or `pretty`, one log line per finished span' },
  { name: 'LANDFLOW_LOG_SPANS', group: 'observability', default: '`true`', description: 'log level, `json` or `pretty`, one log line per finished span' },
  { name: 'LANDFLOW_LOG_OTLP', group: 'observability', default: '`true`', description: 'with an OTLP endpoint, also export every log line (but `span.end`) as an OTel log record ([observability.md §3](../observability.md#3-logs))' },
  { name: 'LANDFLOW_METRICS_PROMETHEUS', group: 'observability', default: '`true`', description: 'serve `GET /api/metrics`' },
  { name: 'LANDFLOW_DB_SLOW_MS', group: 'observability', default: '`50`', description: 'a database call at least this slow (ms) gets a `db.query` span with the statement name (literals stripped); every call is timed in `landflow.db.query.duration` regardless' },
  { name: 'LANDFLOW_TRACE_SLOW_READ_MS', group: 'observability', default: '`1000`', description: 'read-only API requests (GET) are traced only when they take at least this long (ms) or fail with a 5xx; the rest are dropped with their child spans. `0` keeps every read' },
  { name: 'LANDFLOW_METRICS_WORKFLOW_LABEL', group: 'observability', default: '`false`', description: '`true` puts `landflow.workflow.id` back on the counters `landflow.trigger.fires`, `landflow.webhook.requests` and `landflow.runtime.events` (one series per workflow); histograms never carry it, spans and exemplars always do' },
  { name: 'LANDFLOW_TRACE_CONTENT', group: 'observability', default: '`full`', description: 'how much of a run\'s content the Run Trace journal keeps (docs/run-trace.md): `full` (inputs, outputs and texts, each event cut to 32 KB), `summaries` (every text cut to 400 characters) or `off` (names, statuses and errors only). A workflow\'s setting `traceContent` overrides it' },
  { name: 'LANDFLOW_TRACE_RETENTION_DAYS', group: 'observability', default: '`30`', description: 'days the Run Trace journal is kept; older events are pruned once a day (by the leader in queue mode). `0` keeps them until their execution is deleted. Deleting or pruning an execution deletes its events' },
  { name: 'LANDFLOW_OTLP_TRACES_URL', group: 'observability', default: '–', description: 'an OTLP/HTTP traces endpoint (e.g. `http://landflow-lgtm:4318/v1/traces`). Set, each execution\'s Run Trace journal is sent there as one trace once the run ends (not while it waits for a person or a timer): spans with parent links, times and status, and OpenInference attributes (`openinference.span.kind` AGENT, LLM, TOOL, CHAIN or EVALUATOR, `llm.model_name`, `llm.token_count.prompt` and `.completion`, `input.value`, `output.value`, `landflow.actor`, `landflow.execution_id`). What goes out is what the journal stored (redacted, cut by `LANDFLOW_TRACE_CONTENT`; input and output values cut again to 4,000 characters). JSON over HTTP, headers from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS`; sent in batches of 200 spans, a failed request tried once more, and a failure is logged and never fails or delays the run. The `orbstack-observability` overlay sets it to the bundled collector', urlCredentials: true },
  { name: 'LANDFLOW_TRACE_URL', group: 'observability', default: '–', description: 'trace link template, e.g. `http://localhost:16686/trace/{traceId}`' },
  { name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', group: 'observability', default: '–', description: 'traces endpoint, used as given; wins over `OTEL_EXPORTER_OTLP_ENDPOINT` (which gets `/v1/traces` appended)' },
  { name: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', group: 'observability', default: '–', description: 'metrics endpoint, used as given; wins over `OTEL_EXPORTER_OTLP_ENDPOINT`' },
  { name: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', group: 'observability', default: '–', description: 'logs endpoint (audit events), used as given; wins over `OTEL_EXPORTER_OTLP_ENDPOINT`' },
  { name: 'OTEL_EXPORTER_OTLP_PROTOCOL', group: 'observability', default: '`http/json`', description: 'the host exports OTLP over HTTP with JSON encoding only; any other value logs one warning at start and is otherwise ignored' },
  { name: 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', group: 'observability', default: '–', description: 'per-signal form of `OTEL_EXPORTER_OTLP_PROTOCOL` for traces' },
  { name: 'OTEL_EXPORTER_OTLP_HEADERS', group: 'observability', default: '–', description: '`key=value,key=value` headers sent with every OTLP request (an API token, usually)', secret: true },
  { name: 'OTEL_EXPORTER_OTLP_TRACES_HEADERS', group: 'observability', default: '–', description: 'headers for run traces (`LANDFLOW_OTLP_TRACES_URL`); falls back to `OTEL_EXPORTER_OTLP_HEADERS`', secret: true },
  { name: 'OTEL_EXPORTER_OTLP_LOGS_HEADERS', group: 'observability', default: '–', description: 'headers for logs, merged over `OTEL_EXPORTER_OTLP_HEADERS`', secret: true },
  { name: 'OTEL_TRACES_EXPORTER', group: 'observability', default: '–', description: '`none` turns trace export off even with an endpoint set' },
  { name: 'OTEL_METRICS_EXPORTER', group: 'observability', default: '–', description: '`none` turns OTLP metric export off even with an endpoint set' },
  { name: 'OTEL_LOGS_EXPORTER', group: 'observability', default: '–', description: '`none` turns OTLP log export off even with an endpoint set' },
  { name: 'OTEL_BLRP_SCHEDULE_DELAY', group: 'observability', default: '`1000`', description: 'milliseconds between batches of OTLP log records' },
  { name: 'OTEL_SERVICE_NAME', group: 'observability', default: '`landflow-host`', description: 'the `service.name` of spans, metrics and logs' },
  { name: 'OTEL_RESOURCE_ATTRIBUTES', group: 'observability', default: '–', description: 'extra resource attributes (`key=value,key=value`); they win over the host\'s own' },
  { name: 'OTEL_TRACES_SAMPLER', group: 'observability', default: '`parentbased_always_on`', description: 'the standard sampler name' },
  { name: 'OTEL_TRACES_SAMPLER_ARG', group: 'observability', default: '`1`', description: 'the ratio (0 to 1) for the ratio-based samplers' },
  { name: 'OTEL_METRIC_EXPORT_INTERVAL', group: 'observability', default: '`15000`', description: 'milliseconds between OTLP metric exports (minimum 1000)' },
  { name: 'OTEL_SDK_DISABLED', group: 'observability', default: '`false`', description: '`true` turns the whole telemetry SDK off' },
  // Authentication
  { name: 'LANDFLOW_OWNER_EMAIL', group: 'auth', default: '–', description: 'create the owner at boot when no user exists (Docker, CI); ignored afterwards' },
  { name: 'LANDFLOW_OWNER_PASSWORD', group: 'auth', default: '–', description: 'create the owner at boot when no user exists (Docker, CI); ignored afterwards', secret: true },
  { name: 'LANDFLOW_OWNER_NAME', group: 'auth', default: '`Owner`', description: 'create the owner at boot when no user exists (Docker, CI); ignored afterwards' },
  { name: 'LANDFLOW_SESSION_TTL_HOURS', group: 'auth', default: '`336` (14 days)', description: 'how long a sign-in lasts' },
  { name: 'LANDFLOW_SESSION_IDLE_HOURS', group: 'auth', default: '`72` in production, `0` in development', description: 'a session unused this long is signed out (`0` turns it off); the absolute limit is `LANDFLOW_SESSION_TTL_HOURS`' },
  { name: 'LANDFLOW_LOCAL_SIGN_IN', group: 'auth', default: '`all`', description: 'who may sign in with a password: `all`, `owner` (only the owner, the break-glass account) or `off` (SSO only, OIDC or SAML). The login page hides the password form when `off`' },
  { name: 'LANDFLOW_SECURE_COOKIES', group: 'auth', default: 'auto', description: '`true` / `false` forces the session cookie\'s Secure flag (default: Secure over https or with `X-Forwarded-Proto: https`)' },
  { name: 'LANDFLOW_LOGIN_MAX_ATTEMPTS', group: 'auth', default: '`10`', description: 'failed sign-ins per email in 15 minutes (3× that per IP address)' },
  { name: 'LANDFLOW_MAX_BODY_BYTES', group: 'auth', default: '`16777216` (16 MiB)', description: 'the largest JSON request body `parseBody` reads; a bigger one is refused with 413 (raise it for very large imports)' },
  { name: 'LANDFLOW_RATE_LIMIT_API', group: 'auth', default: '`600` in production, `0` in development', description: 'authenticated API requests a minute per signed-in principal; over it: 429 with `Retry-After`. `0` turns it off. Shared through Valkey in queue mode' },
  { name: 'LANDFLOW_RATE_LIMIT_PUBLIC', group: 'auth', default: '`120` in production, `0` in development', description: 'requests a minute per client address and public trigger group (`/api/webhook`, `/form`, `/chat`, `/mcp`, `/api/waiting`); `0` turns it off. Health checks, `/api/plugins/announce` and `/api/metrics` are never counted' },
  { name: 'LANDFLOW_SMTP_HOST', group: 'auth', default: '–', description: 'email for invites, password resets and failure alerts (unset: Settings shows links to copy; email alert channels fail). `LANDFLOW_SMTP_SECURE=true` for implicit TLS (default on port 465; otherwise STARTTLS when offered), `LANDFLOW_SMTP_IGNORE_TLS=true` to skip STARTTLS. The same SMTP sends approval emails (links valid `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`, default 24)' },
  { name: 'LANDFLOW_SMTP_PORT', group: 'auth', default: '`587`', description: 'email for invites, password resets and failure alerts (unset: Settings shows links to copy; email alert channels fail). `LANDFLOW_SMTP_SECURE=true` for implicit TLS (default on port 465; otherwise STARTTLS when offered), `LANDFLOW_SMTP_IGNORE_TLS=true` to skip STARTTLS. The same SMTP sends approval emails (links valid `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`, default 24)' },
  { name: 'LANDFLOW_SMTP_USER', group: 'auth', default: '–', description: 'email for invites, password resets and failure alerts (unset: Settings shows links to copy; email alert channels fail). `LANDFLOW_SMTP_SECURE=true` for implicit TLS (default on port 465; otherwise STARTTLS when offered), `LANDFLOW_SMTP_IGNORE_TLS=true` to skip STARTTLS. The same SMTP sends approval emails (links valid `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`, default 24)' },
  { name: 'LANDFLOW_SMTP_PASS', group: 'auth', default: '–', description: 'email for invites, password resets and failure alerts (unset: Settings shows links to copy; email alert channels fail). `LANDFLOW_SMTP_SECURE=true` for implicit TLS (default on port 465; otherwise STARTTLS when offered), `LANDFLOW_SMTP_IGNORE_TLS=true` to skip STARTTLS. The same SMTP sends approval emails (links valid `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`, default 24)', secret: true },
  { name: 'LANDFLOW_SMTP_FROM', group: 'auth', default: '`Landflow <landflow@host>`', description: 'email for invites, password resets and failure alerts (unset: Settings shows links to copy; email alert channels fail). `LANDFLOW_SMTP_SECURE=true` for implicit TLS (default on port 465; otherwise STARTTLS when offered), `LANDFLOW_SMTP_IGNORE_TLS=true` to skip STARTTLS. The same SMTP sends approval emails (links valid `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`, default 24)' },
  { name: 'LANDFLOW_OIDC_ISSUER', group: 'auth', default: '–', description: 'single sign-on (OIDC); all three turn on the SSO button' },
  { name: 'LANDFLOW_OIDC_CLIENT_ID', group: 'auth', default: '–', description: 'single sign-on (OIDC); all three turn on the SSO button' },
  { name: 'LANDFLOW_OIDC_CLIENT_SECRET', group: 'auth', default: '–', description: 'single sign-on (OIDC); all three turn on the SSO button', secret: true },
  { name: 'LANDFLOW_OIDC_ROLE_CLAIM', group: 'auth', default: '`roles`', description: 'the claim holding roles, `value=role` pairs (`landflow-admin=admin,landflow-editor=member`), the role of users without a mapped one (`none` refuses them)' },
  { name: 'LANDFLOW_OIDC_ROLE_MAP', group: 'auth', default: '–', description: 'the claim holding roles, `value=role` pairs (`landflow-admin=admin,landflow-editor=member`), the role of users without a mapped one (`none` refuses them)' },
  { name: 'LANDFLOW_OIDC_DEFAULT_ROLE', group: 'auth', default: '`member`', description: 'the claim holding roles, `value=role` pairs (`landflow-admin=admin,landflow-editor=member`), the role of users without a mapped one (`none` refuses them)' },
  { name: 'LANDFLOW_SAML_IDP_METADATA_URL', group: 'auth', default: '–', description: 'SAML sign-in: the IdP\'s metadata (refetched hourly and when a signature fails), or its SSO URL (`LANDFLOW_SAML_IDP_SSO_URL` is an alias of `LANDFLOW_SAML_ENTRY_POINT`), entity id and signing certificate(s) (PEM or base64, several separated by `,` or `\\|`); `LANDFLOW_SAML_LOGOUT_URL` overrides its single logout URL' },
  { name: 'LANDFLOW_SAML_ENTRY_POINT', group: 'auth', default: '–', description: 'SAML sign-in: the IdP\'s metadata (refetched hourly and when a signature fails), or its SSO URL (`LANDFLOW_SAML_IDP_SSO_URL` is an alias of `LANDFLOW_SAML_ENTRY_POINT`), entity id and signing certificate(s) (PEM or base64, several separated by `,` or `\\|`); `LANDFLOW_SAML_LOGOUT_URL` overrides its single logout URL', aliases: ['LANDFLOW_SAML_IDP_SSO_URL'] },
  { name: 'LANDFLOW_SAML_IDP_ISSUER', group: 'auth', default: '–', description: 'SAML sign-in: the IdP\'s metadata (refetched hourly and when a signature fails), or its SSO URL (`LANDFLOW_SAML_IDP_SSO_URL` is an alias of `LANDFLOW_SAML_ENTRY_POINT`), entity id and signing certificate(s) (PEM or base64, several separated by `,` or `\\|`); `LANDFLOW_SAML_LOGOUT_URL` overrides its single logout URL' },
  { name: 'LANDFLOW_SAML_IDP_CERT', group: 'auth', default: '–', description: 'SAML sign-in: the IdP\'s metadata (refetched hourly and when a signature fails), or its SSO URL (`LANDFLOW_SAML_IDP_SSO_URL` is an alias of `LANDFLOW_SAML_ENTRY_POINT`), entity id and signing certificate(s) (PEM or base64, several separated by `,` or `\\|`); `LANDFLOW_SAML_LOGOUT_URL` overrides its single logout URL' },
  { name: 'LANDFLOW_SAML_ISSUER', group: 'auth', default: '`<public URL>/api/auth/saml/metadata`', description: 'our entity id, the ACS URL, the button\'s label' },
  { name: 'LANDFLOW_SAML_CALLBACK_URL', group: 'auth', default: '`<public URL>/api/auth/saml/acs`', description: 'our entity id, the ACS URL, the button\'s label' },
  { name: 'LANDFLOW_SAML_LABEL', group: 'auth', default: '`Sign in with SAML`', description: 'our entity id, the ACS URL, the button\'s label' },
  { name: 'LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED', group: 'auth', default: '`true`', description: 'signature requirements, allowed clock difference, the NameID format to request (unset, the IdP picks; the SP metadata advertises persistent)' },
  { name: 'LANDFLOW_SAML_WANT_RESPONSE_SIGNED', group: 'auth', default: '`false`', description: 'signature requirements, allowed clock difference, the NameID format to request (unset, the IdP picks; the SP metadata advertises persistent)' },
  { name: 'LANDFLOW_SAML_CLOCK_SKEW_SECONDS', group: 'auth', default: '`120`', description: 'signature requirements, allowed clock difference, the NameID format to request (unset, the IdP picks; the SP metadata advertises persistent)' },
  { name: 'LANDFLOW_SAML_NAMEID_FORMAT', group: 'auth', default: '–', description: 'signature requirements, allowed clock difference, the NameID format to request (unset, the IdP picks; the SP metadata advertises persistent)' },
  { name: 'LANDFLOW_SAML_PRIVATE_KEY', group: 'auth', default: '–', description: 'sign AuthnRequests and logout messages (PEM); the certificate is published in the SP metadata', secret: true },
  { name: 'LANDFLOW_SAML_CERT', group: 'auth', default: '–', description: 'sign AuthnRequests and logout messages (PEM); the certificate is published in the SP metadata' },
  { name: 'LANDFLOW_SAML_NEXT_CERT', group: 'auth', default: '–', description: 'key rotation: the certificate of the next signing key, published in the SP metadata beside `LANDFLOW_SAML_CERT` (needs the signing key)' },
  { name: 'LANDFLOW_SAML_DECRYPTION_KEY', group: 'auth', default: '–', description: 'decrypt encrypted assertions (RSA key and its certificate, PEM; `\\n` escapes work); the certificate is published for encryption. Unset, Settings → Security → SAML generates or uploads one', secret: true },
  { name: 'LANDFLOW_SAML_DECRYPTION_CERT', group: 'auth', default: '–', description: 'decrypt encrypted assertions (RSA key and its certificate, PEM; `\\n` escapes work); the certificate is published for encryption. Unset, Settings → Security → SAML generates or uploads one' },
  { name: 'LANDFLOW_SAML_DECRYPTION_NEXT_KEY', group: 'auth', default: '–', description: 'key rotation: a second decryption key and certificate, published beside the current one and tried when decrypting (Settings can\'t change it)', secret: true },
  { name: 'LANDFLOW_SAML_DECRYPTION_NEXT_CERT', group: 'auth', default: '–', description: 'key rotation: a second decryption key and certificate, published beside the current one and tried when decrypting (Settings can\'t change it)' },
  { name: 'LANDFLOW_SAML_EMAIL_ATTRIBUTE', group: 'auth', default: '`email`…', description: 'attribute names (unset, the common Entra ID / ADFS claim URIs are tried too; email falls back to an email NameID)' },
  { name: 'LANDFLOW_SAML_NAME_ATTRIBUTE', group: 'auth', default: '`name`…', description: 'attribute names (unset, the common Entra ID / ADFS claim URIs are tried too; email falls back to an email NameID)' },
  { name: 'LANDFLOW_SAML_ROLE_ATTRIBUTE', group: 'auth', default: '`roles`', description: 'attribute names (unset, the common Entra ID / ADFS claim URIs are tried too; email falls back to an email NameID)' },
  { name: 'LANDFLOW_SAML_PROJECT_ATTRIBUTE', group: 'auth', default: '`groups`', description: 'attribute names (unset, the common Entra ID / ADFS claim URIs are tried too; email falls back to an email NameID)' },
  { name: 'LANDFLOW_SAML_ROLE_MAP', group: 'auth', default: '–', description: '`value=role` pairs, the role of users without a mapped one (`none` refuses them), `group=Project:role` pairs (`data-team=Data:editor`), create missing team projects, create users on first sign-in' },
  { name: 'LANDFLOW_SAML_DEFAULT_ROLE', group: 'auth', default: '`member`', description: '`value=role` pairs, the role of users without a mapped one (`none` refuses them), `group=Project:role` pairs (`data-team=Data:editor`), create missing team projects, create users on first sign-in' },
  { name: 'LANDFLOW_SAML_PROJECT_MAP', group: 'auth', default: '–', description: '`value=role` pairs, the role of users without a mapped one (`none` refuses them), `group=Project:role` pairs (`data-team=Data:editor`), create missing team projects, create users on first sign-in' },
  { name: 'LANDFLOW_SAML_CREATE_PROJECTS', group: 'auth', default: '`false`', description: '`value=role` pairs, the role of users without a mapped one (`none` refuses them), `group=Project:role` pairs (`data-team=Data:editor`), create missing team projects, create users on first sign-in' },
  { name: 'LANDFLOW_SAML_JIT', group: 'auth', default: '`true`', description: '`value=role` pairs, the role of users without a mapped one (`none` refuses them), `group=Project:role` pairs (`data-team=Data:editor`), create missing team projects, create users on first sign-in' },
  { name: 'LANDFLOW_OIDC_SCOPES', group: 'auth', default: '`openid email profile`', description: 'requested scopes, the button\'s label, the redirect URI override, where the host fetches discovery when the issuer URL isn\'t reachable from it (Docker)' },
  { name: 'LANDFLOW_OIDC_LABEL', group: 'auth', default: '`Sign in with SSO`', description: 'requested scopes, the button\'s label, the redirect URI override, where the host fetches discovery when the issuer URL isn\'t reachable from it (Docker)' },
  { name: 'LANDFLOW_OIDC_REDIRECT_URL', group: 'auth', default: '`<public URL>/api/auth/oidc/callback`', description: 'requested scopes, the button\'s label, the redirect URI override, where the host fetches discovery when the issuer URL isn\'t reachable from it (Docker)' },
  { name: 'LANDFLOW_OIDC_DISCOVERY_URL', group: 'auth', default: '`<issuer>/.well-known/openid-configuration`', description: 'requested scopes, the button\'s label, the redirect URI override, where the host fetches discovery when the issuer URL isn\'t reachable from it (Docker)' },
  { name: 'LANDFLOW_SCIM_GROUP_MAP', group: 'auth', default: '–', description: 'SCIM groups to roles and projects, comma-separated: `Landflow Admins=role:admin,Data Team=project:Data:editor` (`role:admin` / `role:member`, or `project:<name or id>:<role>`)' },
  { name: 'LANDFLOW_SAML_LOGOUT_URL', group: 'auth', default: '–', description: 'the IdP\'s single logout URL, when it differs from the one in the metadata' },
  { name: 'LANDFLOW_SMTP_SECURE', group: 'auth', default: '`true` on port 465, else `false`', description: 'implicit TLS for the SMTP connection' },
  { name: 'LANDFLOW_SMTP_IGNORE_TLS', group: 'auth', default: '`false`', description: '`true` skips STARTTLS even when the server offers it (a local mail catcher)' },
  // MCP gateway
  { name: 'LANDFLOW_OPENFGA_STORE_ID', group: 'mcp', default: '–', description: 'an external policy engine (`opa` or `openfga`) that also decides which tools an agent\'s caller may use; an unreachable engine denies unless `LANDFLOW_TOOL_POLICY_FAIL=open` ([agents.md](../agents.md#tool-access))' },
  { name: 'LANDFLOW_MCP_GATEWAY', group: 'mcp', default: '`bundled`', description: 'the MCP gateway: `bundled` (agentgateway next to each main), `file` (a gateway of its own reading the targets file) or `off`' },
  { name: 'LANDFLOW_MCP_GATEWAY_SECRET', group: 'mcp', default: '–', description: 'the secret the gateway sends the host (`x-landflow-gateway`) so the host trusts the caller identity headers it sets; without it gateway calls are refused (at least 16 characters)', secret: true },
  { name: 'LANDFLOW_MCP_GATEWAY_PUBLIC_URL', group: 'mcp', default: '–', description: 'where agents connect (into `server.json` `remotes[]` and the MCP token audiences), and the gateway\'s config API the host writes targets to' },
  { name: 'LANDFLOW_MCP_GATEWAY_ADMIN_URL', group: 'mcp', default: '–', description: 'where agents connect (into `server.json` `remotes[]` and the MCP token audiences), and the gateway\'s config API the host writes targets to' },
  { name: 'LANDFLOW_MCP_NAMESPACE', group: 'mcp', default: '`local.landflow`', description: 'the namespace of the plugins\' registry names (`<namespace>/<pluginId>`)' },
  { name: 'LANDFLOW_MCP_IDP_AUDIENCE', group: 'mcp', default: '–', description: 'extra audiences (comma-separated) the identity provider\'s access tokens may carry when they call the host\'s MCP endpoints directly, and on the gateway when it accepts both issuers; the resource URLs are always accepted' },
  { name: 'LANDFLOW_MCP_GATEWAY_ACCEPT_IDP', group: 'mcp', default: 'auto', description: 'whether the synced gateway routes accept the identity provider\'s tokens next to Landflow\'s (agentgateway `jwtAuth` with two providers); `off` keeps Landflow\'s issuer only' },
  { name: 'LANDFLOW_MCP_GATEWAY_HOST_URL', group: 'mcp', default: '`http://host.docker.internal:$PORT`', description: 'how the gateway reaches this host (a compose or Kubernetes sidecar shares its network: `http://127.0.0.1:3000`)' },
  { name: 'LANDFLOW_MCP_GATEWAY_FILE', group: 'mcp', default: '`<data dir>/mcp-gateway.yaml`', description: 'the config file the sync writes in `file` mode' },
  { name: 'LANDFLOW_MCP_GATEWAY_ROUTES', group: 'mcp', default: '`on`', description: '`off` keeps the sync to the shared `/mcp` endpoint (no per-plugin routes); a JSON object merged into the `policies` of every per-plugin route, e.g. the same `mcpAuthentication` as `/mcp` (ignored with a log line if it isn\'t a JSON object). See [deployment.md](../deployment.md) and [mcp-gateway.md](../mcp-gateway.md)' },
  { name: 'LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES', group: 'mcp', default: '–', description: '`off` keeps the sync to the shared `/mcp` endpoint (no per-plugin routes); a JSON object merged into the `policies` of every per-plugin route, e.g. the same `mcpAuthentication` as `/mcp` (ignored with a log line if it isn\'t a JSON object). See [deployment.md](../deployment.md) and [mcp-gateway.md](../mcp-gateway.md)' },
  { name: 'LANDFLOW_MCP_TOOL_TIMEOUT_SECONDS', group: 'mcp', default: '`120`', description: 'longest an MCP tool call runs (sooner when the request\'s `x-landflow-deadline` is)' },
  { name: 'LANDFLOW_MCP_APPROVAL', group: 'mcp', default: '`destructive`', description: 'the instance default of a grant\'s `approval`: `always`, `destructive` or `never` (which calls wait for a person)' },
  { name: 'LANDFLOW_MCP_APPROVAL_WAIT_SECONDS', group: 'mcp', default: '`20`', description: 'how long a call that needs approval waits before answering where to approve / how long an approval stays valid for the one run that follows' },
  { name: 'LANDFLOW_MCP_APPROVAL_TTL_SECONDS', group: 'mcp', default: '`600`', description: 'how long a call that needs approval waits before answering where to approve / how long an approval stays valid for the one run that follows' },
  { name: 'LANDFLOW_MCP_FILE_URL_TTL_SECONDS', group: 'mcp', default: '`900`', description: 'how long a signed file link in a tool result works / largest image or audio file sent inline (`0`: links only; up to 4 per result)' },
  { name: 'LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES', group: 'mcp', default: '`524288` (512 KiB)', description: 'how long a signed file link in a tool result works / largest image or audio file sent inline (`0`: links only; up to 4 per result)' },
  { name: 'LANDFLOW_MCP_OPTIONS_CACHE_SECONDS', group: 'mcp', default: '`300`', description: 'how long a dynamic-options lookup is remembered per caller credential (`0` turns the cache, and the enums, off)' },
  { name: 'LANDFLOW_MCP_TRIGGER_BUFFER', group: 'mcp', default: '`50`', description: 'events kept per MCP trigger subscription / how long a stopped subscription\'s events stay readable' },
  { name: 'LANDFLOW_MCP_TRIGGER_RETAIN_SECONDS', group: 'mcp', default: '`600`', description: 'events kept per MCP trigger subscription / how long a stopped subscription\'s events stay readable' },
  { name: 'LANDFLOW_MCP_TRIGGER_IDLE_SECONDS', group: 'mcp', default: '`3600`', description: 'a subscription nobody reads for this long stops / how often the sweeper deregisters webhooks and polls that lost their stream' },
  { name: 'LANDFLOW_MCP_TRIGGER_SWEEP_SECONDS', group: 'mcp', default: '`60`', description: 'a subscription nobody reads for this long stops / how often the sweeper deregisters webhooks and polls that lost their stream' },
  { name: 'LANDFLOW_MCP_TRIGGER_MIN_INTERVAL_SECONDS', group: 'mcp', default: '`10`', description: 'shortest poll interval of an MCP trigger subscription / heartbeat on its stream' },
  { name: 'LANDFLOW_MCP_TRIGGER_HEARTBEAT_SECONDS', group: 'mcp', default: '`30`', description: 'shortest poll interval of an MCP trigger subscription / heartbeat on its stream' },
  { name: 'LANDFLOW_MCP_GATEWAY_SYNC_IN_TESTS', group: 'mcp', default: '–', description: '`1` lets the test suite sync the MCP gateway file (otherwise skipped under Vitest)' },
  // Environments, secrets and source control
  { name: 'LANDFLOW_GITHUB_MCP_URL', group: 'sourcecontrol', default: '`http://landflow-github-mcp:8082/`', description: 'the GitHub MCP server an agent\'s GitHub MCP tool uses when it names no URL ([a2a.md](../a2a.md#githubs-mcp-tools-for-agents)); the token is the tool\'s credential, never a variable' },
  { name: 'LANDFLOW_GIT_TOKEN', group: 'sourcecontrol', default: '–', description: 'HTTPS token for Settings → Source control when no credential is picked (sent through `GIT_ASKPASS`, never stored)', secret: true },
  { name: 'LANDFLOW_ENVIRONMENT', group: 'sourcecontrol', default: '–', description: 'this instance\'s environment (`development`, `staging`, `production`, …): the shell badge, protection, promotion, per-environment variable values and `{environment}` in secrets providers\' prefixes. Unset: no environment features' },
  { name: 'LANDFLOW_ENVIRONMENT_PROTECTED', group: 'sourcecontrol', default: '–', description: '`true` makes workflows read-only here (`false` overrides Settings → Environments)' },
  { name: 'LANDFLOW_ENVIRONMENTS', group: 'sourcecontrol', default: '`development,staging,production`', description: 'the environments promotion offers, when Settings → Environments doesn\'t list them' },
  { name: 'LANDFLOW_SECRETS_CACHE_TTL', group: 'sourcecontrol', default: '`60`', description: 'seconds an external secret\'s value is reused (0: read it every time)' },
  { name: 'LANDFLOW_SECRETS_TIMEOUT_MS', group: 'sourcecontrol', default: '`10000`', description: 'timeout of each request to a secrets provider' },
  { name: 'LANDFLOW_GIT_TIMEOUT_MS', group: 'sourcecontrol', default: '`120000`', description: 'per git command of Settings → Source control' },
  { name: 'AWS_ACCESS_KEY_ID', group: 'sourcecontrol', default: '–', description: 'access key of the AWS Secrets Manager provider when its Settings pick "environment" authentication (`~/.aws` and instance metadata are never read)' },
  { name: 'AWS_SECRET_ACCESS_KEY', group: 'sourcecontrol', default: '–', description: 'secret key for the same provider', secret: true },
  { name: 'AWS_SESSION_TOKEN', group: 'sourcecontrol', default: '–', description: 'session token for the same provider, with temporary credentials', secret: true },
  // Read by plugins
  { name: 'LANDFLOW_REGISTRY_URL', group: 'plugin', default: '–', description: 'where the plugin announces itself (the host registry) ([protocol.md](../protocol.md))', readBy: 'plugins' },
  { name: 'LANDFLOW_ADVERTISE_HOST', group: 'plugin', default: 'the plugin\'s host name', description: 'the host name the plugin tells the registry to call it on ([protocol.md](../protocol.md))', readBy: 'plugins' },
  { name: 'LANDFLOW_HTTP_PORT', group: 'plugin', default: '–', description: 'the plugin\'s HTTP port ([protocol.md](../protocol.md))', readBy: 'plugins' },
  { name: 'LANDFLOW_GRPC_PORT', group: 'plugin', default: '–', description: 'the plugin\'s gRPC port ([protocol.md](../protocol.md))', readBy: 'plugins' },
  { name: 'LANDFLOW_SEARCH_SEARXNG_URL', group: 'plugin', default: '–', description: 'read by the Web Search plugin, not the host (also a compose variable for the `web-search` profile): the SearXNG base URL it uses when the SearXNG credential names none ([web-search.md](../web-search.md))', readBy: 'plugins' },
  { name: 'LANDFLOW_SEARCH_DENY_DOMAINS', group: 'plugin', default: '–', description: 'read by the Web Search plugin (also a compose variable): comma-separated domains (subdomains included) the node refuses as `site` and drops from results', readBy: 'plugins' },
];

/**
 * Names the source reads or sets that are not Landflow configuration: the runtime's own, the ones the host sets for a
 * child process, and the ones the platform provides. The catalog test accepts them without an entry.
 */
export const NOT_CONFIGURATION: readonly string[] = [
  'NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'NEXT_OTEL_FETCH_DISABLED', 'VITEST', 'PORT', 'HOSTNAME', 'HOME', 'PATH', 'SYSTEMROOT',
  // set by Kubernetes in every pod
  'KUBERNETES_SERVICE_HOST',
  // set by the host for the git child process (sync/git.ts), never read from the environment
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'LANDFLOW_GIT_USERNAME', 'LANDFLOW_GIT_PASSWORD',
];

const byName = new Map<string, ConfigVariable>();
for (const variable of CONFIG_CATALOG) {
  byName.set(variable.name, variable);
  for (const alias of variable.aliases ?? []) byName.set(alias, variable);
}

/** The entry for a name or a deprecated alias of it. */
export const catalogEntry = (name: string): ConfigVariable | undefined => byName.get(name);

/** Every name that is catalogued: variables and their aliases. */
export const catalogNames = (): string[] => [...byName.keys()];

/** Variables holding secrets (by name or alias): redacted in the effective configuration, refused with a development value in production. */
export const SECRET_VARIABLES: readonly string[] = CONFIG_CATALOG.filter((v) => v.secret).flatMap((v) => [v.name, ...(v.aliases ?? [])]);
