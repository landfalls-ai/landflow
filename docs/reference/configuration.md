# Configuration

The host's environment variables, with their defaults. The compose stacks set them from `deploy/.env`
([deployment.md](../deployment.md)); plugins read their own (`LANDFLOW_REGISTRY_URL`, ports, transports), listed in each
SDK's README. Part of the [Landflow docs](../README.md).

| Variable | Default | |
|---|---|---|
| `LANDFLOW_DATA_DIR` | `apps/web/.data` | data directory: the SQLite database (`landflow.db`), credentials, binary files, the Claude Code plugin images packed for kagent (`oci/`) and the other host files |
| `LANDFLOW_CLAUDE_PLUGINS_DIR` | `<cwd>/claude-plugins` (`apps/web/claude-plugins`) | where Landflow's own Claude Code plugins are (the landflow-harness mod), packed into images for kagent's Claude Code agents ([a2a.md](../a2a.md#the-landflow-harness-mod)) |
| `LANDFLOW_DB` | `sqlite` | `postgres` keeps the store in Postgres (`DATABASE_URL`); one host per database |
| `DATABASE_URL` | – | Postgres connection string for `LANDFLOW_DB=postgres`, e.g. the infra stack's `postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow` |
| `LANDFLOW_EXECUTIONS_MODE` | `regular` | `queue`: mains enqueue production runs on Valkey for workers (`pnpm worker`) and elect a leader ("Queue mode, workers and high availability") |
| `LANDFLOW_VALKEY_URL` | `redis://127.0.0.1:6379` | queue mode's Valkey (`rediss://` for TLS, `redis://user:password@host:port/db`) |
| `LANDFLOW_VALKEY_SENTINELS` / `LANDFLOW_VALKEY_MASTER_NAME` | – / `mymaster` | find the primary through Valkey Sentinel (`host:port,…`) and follow failovers; `LANDFLOW_VALKEY_SENTINEL_USERNAME` / `LANDFLOW_VALKEY_SENTINEL_PASSWORD` when the sentinels require AUTH, `LANDFLOW_VALKEY_SENTINEL_TLS=true` when they speak TLS (all `–` / `false` by default) |
| `LANDFLOW_VALKEY_CLUSTER` / `LANDFLOW_VALKEY_CLUSTER_NAT` | – | run on a Valkey (or Redis) Cluster: seed nodes (`host:port,…`; every key carries one hash tag, so this is failover, not scale-out), and `announced:port=reachable:port,…` for clusters that announce addresses you can't reach. Not together with Sentinel (refused at start); see [engine.md](../features/engine.md#queue-mode-workers-and-high-availability) |
| `LANDFLOW_CONFIG_STORE` | `database` in queue mode, else `files` | where credentials and the settings files (mcp.json, marketplaces.json, skill-library.json, agent-channels.json) live: the database (imported once from the files) or the data directory |
| `LANDFLOW_QUEUE_PREFIX` | `landflow` | Valkey key prefix, so several installs can share one Valkey |
| `LANDFLOW_INSTANCE_ID` | `<role>-<hostname>-<pid>` | this process's name in the cluster (and its Postgres spool file); set a stable, unique one per process |
| `LANDFLOW_WORKER_CONCURRENCY` | `10` | runs a worker takes at once |
| `LANDFLOW_MAX_RUNS` | `0` (no cap) | regular mode: production runs (webhook, trigger, poll) a process runs at once across workflows; the rest wait, ordered by workflow **Priority** |
| `LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS` | `false` | queue mode: editor runs go to the workers too |
| `LANDFLOW_QUEUE_ALLOW_SQLITE` | `false` | allow queue mode on SQLite, every process on one host sharing the file |
| `LANDFLOW_LEADER_TTL_SECONDS` / `LANDFLOW_STALLED_SECONDS` | `10` / `30` | leader lease (failover in TTL + TTL/3) / how long a silent worker keeps its jobs |
| `LANDFLOW_WORKER_PORT` / `LANDFLOW_WORKER_SHUTDOWN_SECONDS` | `5690` / `30` | a worker's `/healthz` and `/metrics` (`0` = off) / how long SIGTERM lets runs finish before re-queuing them |
| `LANDFLOW_IDEMPOTENCY_TTL_HOURS` | `24` | how long trigger idempotency keys are remembered |
| `LANDFLOW_APP_WEBHOOK_RETRY_MS` | `60000` | how often app webhook registrations that failed at publish are retried |
| `LANDFLOW_APP_WEBHOOK_MAX_BYTES` | `26214400` (25 MiB) | largest body an app webhook trigger accepts (larger ones are refused) |
| `LANDFLOW_AGENT_CHANNEL_POLL_SECONDS` | `5` | how often an agent's Telegram channel is polled for new messages (at least `2`) |
| `LANDFLOW_PUBLIC_URL` | `http://localhost:$PORT` | public base URL in the links the host hands out: resume URLs (`$execution.resumeUrl`, `resumeFormUrl`), error workflow and failure alert execution links, the OAuth2 redirect URL, and the URL app webhook triggers register (`<public URL>/api/webhook/app/…`, so it must be reachable by the service) |
| `LANDFLOW_OAUTH2_REDIRECT_URL` | `<public URL>/api/oauth2/callback` | the redirect URL OAuth2 Connect sends to providers (register it there); without either variable, the request's origin |
| `GENERIC_TIMEZONE` | the host's zone | the instance's default time zone until one is chosen in Settings → General |
| `LANDFLOW_ENCRYPTION_KEY` | generated into `.data/encryption.key` | key for the credentials vault: 64 hex characters, or a passphrase (hashed with SHA-256) |
| `LANDFLOW_REGISTRY_GRPC_PORT` | `7070` | gRPC RegistryService (`off` to disable) |
| `LANDFLOW_PLUGINS` | – | static plugin endpoints |
| `LANDFLOW_SCAN_HOSTS` / `LANDFLOW_SCAN_PORTS` | `127.0.0.1` / `7100-7299` | pull discovery |
| `LANDFLOW_SCAN_ON_START` | `true` | scan at boot |
| `LANDFLOW_PLUGIN_DISCOVERY` | – | `kubernetes`: discover plugins from labelled Services; `LANDFLOW_K8S_NAMESPACES` (`*`: every namespace), `LANDFLOW_K8S_SPREAD` (`pods`: calls spread over the ready pods, or `service`), `LANDFLOW_K8S_CONTEXT`, `LANDFLOW_K8S_ADDRESS`, `LANDFLOW_K8S_CLUSTER_DOMAIN`, `LANDFLOW_K8S_LABEL_SELECTOR`, `LANDFLOW_K8S_RESYNC_SECONDS` in [deployment.md, "Kubernetes"](../deployment.md#kubernetes) |
| `LANDFLOW_EXECUTE_TIMEOUT_MS` | `120000` | per remote Execute call (and per call to the code runner) |
| `LANDFLOW_CODE_RUNNER_URL` | – | the Code node's sandbox, e.g. `http://127.0.0.1:7300` (pnpm) or `http://127.0.0.1:53300` (Docker); set: the sandbox is the default and Python works |
| `LANDFLOW_CODE_RUNNER_SECRET` | – | shared secret, the runner's `CODE_RUNNER_SECRET` |
| `LANDFLOW_CODE_IN_PROCESS` | `true` | `false`: no in-process (`node:vm`) JavaScript; every Code node needs the runner |
| `LANDFLOW_CODE_BINARY_MAX_BYTES` | `6291456` | files a Code node reads (all together) and creates, in the sandbox and in-process |
| `ANTHROPIC_API_KEY` | – | for the Anthropic Chat Model |
| `LANDFLOW_GITHUB_MCP_URL` | `http://landflow-github-mcp:8082/` | the GitHub MCP server an agent's GitHub MCP tool uses when it names no URL ([a2a.md](../a2a.md#githubs-mcp-tools-for-agents)); the token is the tool's credential, never a variable |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | the Ollama used by the AI flow builder and the editor assistant, and the default of the Ollama chat and embeddings nodes |
| `LANDFLOW_BUILDER_MODEL` | `qwen3-coder:30b` | model the AI flow builder and the editor assistant use |
| `AI_USAGE_RETENTION_DAYS` | `400` | how long per-call AI usage rows (tokens, cost) are kept |
| `LANDFLOW_BRAIN` | `true` | `false` turns the [second brain](../second-brain.md) off: no usage ledger, no detectors, no study |
| `USAGE_RETENTION_DAYS` | `90` | how long raw usage events are kept; daily rollups are kept 400 days |
| `LANDFLOW_BRAIN_MODEL` | the builder model | the model the second brain writes fixes, tips, persona rules, drafts and purposes with; `off`: rules only |
| `LANDFLOW_BRAIN_EMBEDDINGS` | `nomic-embed-text` | the Ollama model that embeds its facts into `landflow-brain-<project>`; `off`: keyword search only |
| `LANDFLOW_BRAIN_INTERVAL_MINUTES` | `60` | how often the leader rolls up, checks effects and runs the detectors (it studies once a day) |
| `LANDFLOW_BRAIN_WEEKLY_CAP` | `3` | suggestions per workflow per week |
| `LANDFLOW_AUDIT_OUTBOX` | `on` | `off` stops this process from delivering the audit outbox to SIEM destinations (events still queue; another host or a restart delivers them) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | OTLP/HTTP endpoint for traces and metrics, e.g. `http://localhost:4318`; unset: nothing is exported |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER[_ARG]`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_SDK_DISABLED` | standard | see docs/observability.md |
| `LANDFLOW_LOG_LEVEL` / `LANDFLOW_LOG_FORMAT` / `LANDFLOW_LOG_SPANS` | `info` / `json` / `true` | log level, `json` or `pretty`, one log line per finished span |
| `LANDFLOW_LOG_OTLP` | `true` | with an OTLP endpoint, also export every log line (but `span.end`) as an OTel log record ([observability.md §3](../observability.md#3-logs)) |
| `LANDFLOW_METRICS_PROMETHEUS` | `true` | serve `GET /api/metrics` |
| `LANDFLOW_TRACE_CONTENT` | `full` | how much of a run's content the Run Trace journal keeps (docs/run-trace.md): `full` (inputs, outputs and texts, each event cut to 32 KB), `summaries` (every text cut to 400 characters) or `off` (names, statuses and errors only). A workflow's setting `traceContent` overrides it |
| `LANDFLOW_TRACE_RETENTION_DAYS` | `30` | days the Run Trace journal is kept; older events are pruned once a day (by the leader in queue mode). `0` keeps them until their execution is deleted. Deleting or pruning an execution deletes its events |
| `LANDFLOW_OTLP_TRACES_URL` | – | an OTLP/HTTP traces endpoint (e.g. `http://landflow-lgtm:4318/v1/traces`). Set, each execution's Run Trace journal is sent there as one trace once the run ends (not while it waits for a person or a timer): spans with parent links, times and status, and OpenInference attributes (`openinference.span.kind` AGENT, LLM, TOOL, CHAIN or EVALUATOR, `llm.model_name`, `llm.token_count.prompt` and `.completion`, `input.value`, `output.value`, `landflow.actor`, `landflow.execution_id`). What goes out is what the journal stored (redacted, cut by `LANDFLOW_TRACE_CONTENT`; input and output values cut again to 4,000 characters). JSON over HTTP, headers from `OTEL_EXPORTER_OTLP_TRACES_HEADERS` or `OTEL_EXPORTER_OTLP_HEADERS`; sent in batches of 200 spans, a failed request tried once more, and a failure is logged and never fails or delays the run. The `orbstack-observability` overlay sets it to the bundled collector |
| `LANDFLOW_TRACE_URL` | – | trace link template, e.g. `http://localhost:16686/trace/{traceId}` |
| `LANDFLOW_BINARY_STORE` | `filesystem` | where files live: `filesystem` or `s3` |
| `LANDFLOW_BINARY_DIR` | `<data dir>/binary` | the filesystem store's directory |
| `LANDFLOW_S3_BUCKET`, `LANDFLOW_S3_ENDPOINT`, `LANDFLOW_S3_REGION`, `LANDFLOW_S3_ACCESS_KEY_ID`, `LANDFLOW_S3_SECRET_ACCESS_KEY`, `LANDFLOW_S3_FORCE_PATH_STYLE`, `LANDFLOW_S3_PREFIX` | – / AWS / `us-east-1` / AWS chain / AWS chain / `true` / `binary/` | the S3 store (bucket required; set the endpoint for MinIO, e.g. `http://127.0.0.1:59000`) |
| `LANDFLOW_BINARY_MAX_BYTES` | `268435456` (256 MiB) | largest stored file or upload (413 above it) |
| `LANDFLOW_BINARY_MAX_INLINE_BYTES` | `16777216` (16 MiB) | largest inline (base64) file a node may return |
| `LANDFLOW_BINARY_SECRET` | random per process | key that signs plugins' binary tokens; set it when several host processes serve one store |
| `LANDFLOW_INTERNAL_URL` | `http://127.0.0.1:$PORT` | the host URL plugins use for `/api/binary` (e.g. `http://web:3000` in Docker) |
| `LANDFLOW_FILES_DIR` | `<data dir>/files` | the only directory Read/Write Files from Disk may use |
| `LANDFLOW_MARKETPLACE_PORTS` | `7250-7299` | the port range marketplace node plugins get (one range per process when several share a host); a range outside 1024-65535 falls back to the default. See [marketplace.md](../marketplace.md#landflow-node-plugins) |
| `LANDFLOW_MARKETPLACE_REGISTRY_URL` | `<public URL>`, else `http://127.0.0.1:$PORT` | the host URL marketplace node plugins announce to |
| `LANDFLOW_MARKETPLACE_ALLOW_LOCAL` | – | `1` lets a marketplace be a directory on the host (tests and checkouts; off by default so the API can't read the host's disk) |
| `LANDFLOW_TEMPLATES_URL` | – | an n8n-compatible templates API to search in the templates library, e.g. `https://api.n8n.io/api` (answers cached 10 minutes) |
| `LANDFLOW_OWNER_EMAIL` / `LANDFLOW_OWNER_PASSWORD` / `LANDFLOW_OWNER_NAME` | – / – / `Owner` | create the owner at boot when no user exists (Docker, CI); ignored afterwards |
| `LANDFLOW_SESSION_TTL_HOURS` | `336` (14 days) | how long a sign-in lasts |
| `LANDFLOW_SECURE_COOKIES` | auto | `true` / `false` forces the session cookie's Secure flag (default: Secure over https or with `X-Forwarded-Proto: https`) |
| `LANDFLOW_LOGIN_MAX_ATTEMPTS` | `10` | failed sign-ins per email in 15 minutes (3× that per IP address) |
| `LANDFLOW_SMTP_HOST`, `LANDFLOW_SMTP_PORT`, `LANDFLOW_SMTP_USER`, `LANDFLOW_SMTP_PASS`, `LANDFLOW_SMTP_FROM` | – / `587` / – / – / `Landflow <landflow@host>` | email for invites, password resets and failure alerts (unset: Settings shows links to copy; email alert channels fail). `LANDFLOW_SMTP_SECURE=true` for implicit TLS (default on port 465; otherwise STARTTLS when offered), `LANDFLOW_SMTP_IGNORE_TLS=true` to skip STARTTLS. The same SMTP sends approval emails (links valid `LANDFLOW_APPROVAL_EMAIL_TTL_HOURS`, default 24) |
| `LANDFLOW_OIDC_ISSUER`, `LANDFLOW_OIDC_CLIENT_ID`, `LANDFLOW_OIDC_CLIENT_SECRET` | – | single sign-on (OIDC); all three turn on the SSO button |
| `LANDFLOW_MCP_GATEWAY` | `bundled` | the MCP gateway: `bundled` (agentgateway next to each main), `file` (a gateway of its own reading the targets file) or `off` |
| `LANDFLOW_MCP_GATEWAY_SECRET` | – | the secret the gateway sends the host (`x-landflow-gateway`) so the host trusts the caller identity headers it sets; without it gateway calls are refused (at least 16 characters) |
| `LANDFLOW_MCP_GATEWAY_PUBLIC_URL`, `LANDFLOW_MCP_GATEWAY_ADMIN_URL` | – | where agents connect (into `server.json` `remotes[]` and the MCP token audiences), and the gateway's config API the host writes targets to |
| `LANDFLOW_MCP_NAMESPACE` | `local.landflow` | the namespace of the plugins' registry names (`<namespace>/<pluginId>`) |
| `LANDFLOW_VERSION` | `dev` | the version the host reports as `serverInfo.version` on its MCP endpoint |
| `LANDFLOW_MCP_IDP_AUDIENCE` | – | extra audiences (comma-separated) the identity provider's access tokens may carry when they call the host's MCP endpoints directly, and on the gateway when it accepts both issuers; the resource URLs are always accepted |
| `LANDFLOW_MCP_GATEWAY_ACCEPT_IDP` | auto | whether the synced gateway routes accept the identity provider's tokens next to Landflow's (agentgateway `jwtAuth` with two providers); `off` keeps Landflow's issuer only |
| `LANDFLOW_MCP_GATEWAY_HOST_URL` | `http://host.docker.internal:$PORT` | how the gateway reaches this host (a compose or Kubernetes sidecar shares its network: `http://127.0.0.1:3000`) |
| `LANDFLOW_MCP_GATEWAY_FILE` | `<data dir>/mcp-gateway.yaml` | the config file the sync writes in `file` mode |
| `LANDFLOW_MCP_GATEWAY_ROUTES` / `LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES` | `on` / – | `off` keeps the sync to the shared `/mcp` endpoint (no per-plugin routes); a JSON object merged into the `policies` of every per-plugin route, e.g. the same `mcpAuthentication` as `/mcp` (ignored with a log line if it isn't a JSON object). See [deployment.md](../deployment.md) and [mcp-gateway.md](../mcp-gateway.md) |
| `LANDFLOW_MCP_TOOL_TIMEOUT_SECONDS` | `120` | longest an MCP tool call runs (sooner when the request's `x-landflow-deadline` is) |
| `LANDFLOW_MCP_APPROVAL` | `destructive` | the instance default of a grant's `approval`: `always`, `destructive` or `never` (which calls wait for a person) |
| `LANDFLOW_MCP_APPROVAL_WAIT_SECONDS` / `LANDFLOW_MCP_APPROVAL_TTL_SECONDS` | `20` / `600` | how long a call that needs approval waits before answering where to approve / how long an approval stays valid for the one run that follows |
| `LANDFLOW_MCP_FILE_URL_TTL_SECONDS` / `LANDFLOW_MCP_INLINE_MEDIA_MAX_BYTES` | `900` / `524288` (512 KiB) | how long a signed file link in a tool result works / largest image or audio file sent inline (`0`: links only; up to 4 per result) |
| `LANDFLOW_MCP_OPTIONS_CACHE_SECONDS` | `300` | how long a dynamic-options lookup is remembered per caller credential (`0` turns the cache, and the enums, off) |
| `LANDFLOW_MCP_TRIGGER_BUFFER` / `LANDFLOW_MCP_TRIGGER_RETAIN_SECONDS` | `50` / `600` | events kept per MCP trigger subscription / how long a stopped subscription's events stay readable |
| `LANDFLOW_MCP_TRIGGER_IDLE_SECONDS` / `LANDFLOW_MCP_TRIGGER_SWEEP_SECONDS` | `3600` / `60` | a subscription nobody reads for this long stops / how often the sweeper deregisters webhooks and polls that lost their stream |
| `LANDFLOW_MCP_TRIGGER_MIN_INTERVAL_SECONDS` / `LANDFLOW_MCP_TRIGGER_HEARTBEAT_SECONDS` | `10` / `30` | shortest poll interval of an MCP trigger subscription / heartbeat on its stream |
| `LANDFLOW_OIDC_ROLE_CLAIM` / `LANDFLOW_OIDC_ROLE_MAP` / `LANDFLOW_OIDC_DEFAULT_ROLE` | `roles` / – / `member` | the claim holding roles, `value=role` pairs (`landflow-admin=admin,landflow-editor=member`), the role of users without a mapped one (`none` refuses them) |
| `LANDFLOW_SAML_IDP_METADATA_URL` or `LANDFLOW_SAML_ENTRY_POINT` + `LANDFLOW_SAML_IDP_ISSUER` + `LANDFLOW_SAML_IDP_CERT` | – | SAML sign-in: the IdP's metadata (refetched hourly and when a signature fails), or its SSO URL (`LANDFLOW_SAML_IDP_SSO_URL` is an alias of `LANDFLOW_SAML_ENTRY_POINT`), entity id and signing certificate(s) (PEM or base64, several separated by `,` or `\|`); `LANDFLOW_SAML_LOGOUT_URL` overrides its single logout URL |
| `LANDFLOW_SAML_ISSUER` / `LANDFLOW_SAML_CALLBACK_URL` / `LANDFLOW_SAML_LABEL` | `<public URL>/api/auth/saml/metadata` / `<public URL>/api/auth/saml/acs` / `Sign in with SAML` | our entity id, the ACS URL, the button's label |
| `LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED` / `LANDFLOW_SAML_WANT_RESPONSE_SIGNED` / `LANDFLOW_SAML_CLOCK_SKEW_SECONDS` / `LANDFLOW_SAML_NAMEID_FORMAT` | `true` / `false` / `120` / – | signature requirements, allowed clock difference, the NameID format to request (unset, the IdP picks; the SP metadata advertises persistent) |
| `LANDFLOW_SAML_PRIVATE_KEY` / `LANDFLOW_SAML_CERT` | – | sign AuthnRequests and logout messages (PEM); the certificate is published in the SP metadata |
| `LANDFLOW_SAML_NEXT_CERT` | – | key rotation: the certificate of the next signing key, published in the SP metadata beside `LANDFLOW_SAML_CERT` (needs the signing key) |
| `LANDFLOW_SAML_DECRYPTION_KEY` / `LANDFLOW_SAML_DECRYPTION_CERT` | – | decrypt encrypted assertions (RSA key and its certificate, PEM; `\n` escapes work); the certificate is published for encryption. Unset, Settings → Security → SAML generates or uploads one |
| `LANDFLOW_SAML_DECRYPTION_NEXT_KEY` / `LANDFLOW_SAML_DECRYPTION_NEXT_CERT` | – | key rotation: a second decryption key and certificate, published beside the current one and tried when decrypting (Settings can't change it) |
| `LANDFLOW_SAML_EMAIL_ATTRIBUTE` / `LANDFLOW_SAML_NAME_ATTRIBUTE` / `LANDFLOW_SAML_ROLE_ATTRIBUTE` / `LANDFLOW_SAML_PROJECT_ATTRIBUTE` | `email`… / `name`… / `roles` / `groups` | attribute names (unset, the common Entra ID / ADFS claim URIs are tried too; email falls back to an email NameID) |
| `LANDFLOW_SAML_ROLE_MAP` / `LANDFLOW_SAML_DEFAULT_ROLE` / `LANDFLOW_SAML_PROJECT_MAP` / `LANDFLOW_SAML_CREATE_PROJECTS` / `LANDFLOW_SAML_JIT` | – / `member` / – / `false` / `true` | `value=role` pairs, the role of users without a mapped one (`none` refuses them), `group=Project:role` pairs (`data-team=Data:editor`), create missing team projects, create users on first sign-in |
| `LANDFLOW_OIDC_SCOPES` / `LANDFLOW_OIDC_LABEL` / `LANDFLOW_OIDC_REDIRECT_URL` / `LANDFLOW_OIDC_DISCOVERY_URL` | `openid email profile` / `Sign in with SSO` / `<public URL>/api/auth/oidc/callback` / `<issuer>/.well-known/openid-configuration` | requested scopes, the button's label, the redirect URI override, where the host fetches discovery when the issuer URL isn't reachable from it (Docker) |
| `LANDFLOW_SCIM_GROUP_MAP` | – | SCIM groups to roles and projects, comma-separated: `Landflow Admins=role:admin,Data Team=project:Data:editor` (`role:admin` / `role:member`, or `project:<name or id>:<role>`) |
| `LANDFLOW_REGISTRY_SECRET` | – | shared secret plugins must send to `/api/plugins/announce` and the gRPC registry (set it on the plugins too) |
| `LANDFLOW_TRANSPORT_<KIND>_URL` | – | a read-only broker connection per kind (`LANDFLOW_TRANSPORT_KAFKA_URL`, `LANDFLOW_TRANSPORT_NATS_URL=nats://user:pass@nats:4222`, likewise rabbitmq and the rest; the URL's user info becomes the secrets), listed in Settings → Transports. `http` and `grpc` are not brokers and are skipped |
| `LANDFLOW_TRANSPORT_SECRET` | falls back to `LANDFLOW_REGISTRY_SECRET` | the key that signs and encrypts broker messages, the same on the host and every brokered plugin; without any secret the host opens no broker connection. `LANDFLOW_TRANSPORT_SECRET_PREVIOUS` (comma-separated) lists old secrets that still verify. See [transports.md](../transports.md#security-over-brokers) |
| `LANDFLOW_CLAIM_STORE` | – | where a broker body over the broker's limit goes by reference: `s3://<bucket>/<prefix>?endpoint=<url>&region=<region>&forcePathStyle=true` (`memory://` for tests); unset, such a call fails `too_large`. See [deployment.md](../deployment.md) and [transports.md](../transports.md#delivery-rules-all-brokers) |
| `LANDFLOW_GIT_TOKEN` | – | HTTPS token for Settings → Source control when no credential is picked (sent through `GIT_ASKPASS`, never stored) |
| `LANDFLOW_ENVIRONMENT` | – | this instance's environment (`development`, `staging`, `production`, …): the shell badge, protection, promotion, per-environment variable values and `{environment}` in secrets providers' prefixes. Unset: no environment features |
| `LANDFLOW_ENVIRONMENT_PROTECTED` | – | `true` makes workflows read-only here (`false` overrides Settings → Environments) |
| `LANDFLOW_ENVIRONMENTS` | `development,staging,production` | the environments promotion offers, when Settings → Environments doesn't list them |
| `LANDFLOW_SECRETS_CACHE_TTL` | `60` | seconds an external secret's value is reused (0: read it every time) |
| `LANDFLOW_SECRETS_TIMEOUT_MS` | `10000` | timeout of each request to a secrets provider |
| `LANDFLOW_GIT_TIMEOUT_MS` | `120000` | per git command of Settings → Source control |
| `LANDFLOW_METRICS_PUBLIC` | `false` | `true` lets Prometheus scrape `/api/metrics` without an API key |
| plugin side: `LANDFLOW_REGISTRY_URL`, `LANDFLOW_ADVERTISE_HOST`, `LANDFLOW_HTTP_PORT`, `LANDFLOW_GRPC_PORT`, `LANDFLOW_REGISTRY_SECRET` | | see docs/protocol.md |
