# External secrets and environments

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

**External secrets** (Settings → External secrets, owners and admins) let credentials read values from a secret store at run time instead of holding them. Each provider has a name, and a credential field references a secret as `{{ $secrets.<provider>.<name> }}`, a key of it as `{{ $secrets.<provider>.<name>.<key> }}`, and names that aren't identifiers as `{{ $secrets.aws['prod/db'].password }}`; text around it works (`Bearer {{ $secrets.vault.api.token }}`).

| Provider | Kind | Authentication | Secret names |
|---|---|---|---|
| OpenBao / HashiCorp Vault | `vault` | token, AppRole or Kubernetes (the service account token; more methods plug in through `registerVaultAuthMethod`); a namespace goes in `X-Vault-Namespace` | KV v2 paths under the mount and an optional prefix (`dev/hello`), keys from the entry; paths under a **Dynamic mount** are issued per run ([dynamic secrets](#dynamic-secrets)). A login's token is renewed at two thirds of its lease and the provider logs in again when renewal fails |
| 1Password | `onePassword` | a Connect server's URL and token, optionally limited to some vaults | item titles; keys are field labels (`password`, `username` and `credential` by purpose too) |
| AWS Secrets Manager | `awsSecretsManager` | access keys in the settings, or "environment" (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; never `~/.aws` or instance metadata); SigV4 signing without an SDK; an endpoint setting for LocalStack | secret names (`prod/db`); a JSON secret string reads as its keys |
| GCP Secret Manager | `gcpSecretManager` | a service account key (JSON) | the project's secrets, latest version |
| Azure Key Vault | `azureKeyVault` | an app registration's tenant, client id and client secret (authority host for sovereign clouds) | the vault's secrets |

- **Settings**: add a provider (**Test** checks the settings before you save; saving connects and lists the names), **Test**, **Refresh** (lists the names again and drops cached values), turn it off, delete it. The page shows each provider's secret names, never values. Provider tokens, secret ids and keys are stored encrypted with the credentials vault's key (`external_secret_providers`, migration 1000) and never returned. Prefixes may hold `{environment}` (`landflow/{environment}`), so one store serves every environment.
- **Where**: credential fields, as in n8n. In the credential dialog, **Use secret** and the expression editor's autocomplete offer `$secrets`, the providers and their names. The same references work in an OAuth2 credential's Connect client fields (client id, client secret, authorization, token and user info URLs: resolved when the authorization URL is built, the code exchanged, the token refreshed and a client credentials token asked for), and in the credentials and settings Landflow itself uses outside nodes: agents' models (OpenAI and Anthropic credentials, also for the model picker) and channels (Slack bot token and signing secret, Telegram bot token), alert channels (the Telegram credential, the Slack webhook URL, the webhook URL and signing secret; also for governance notices) and the source control token (Settings → Source control's credential, resolved right before git runs).
- **Node parameters** (Settings → External secrets → **Allow in node parameters**, off by default, owners and admins; `PATCH /api/external-secrets { allowInParameters }`, kept in `settings` as `external_secrets`, audited): off, a parameter that reads `$secrets` fails the node with "…can’t be used in node parameters on this instance: an owner or admin can turn on “Allow in node parameters” in Settings → External secrets, or move the value into a credential field", and the editor doesn't offer `$secrets` outside credentials. On, parameters read `{{ $secrets.<provider>.<name> }}` in the host and in workers (also polls, app webhook registration, agent node tools and the MCP trigger's tools), the editor autocompletes the names, and the expression preview shows `[secret]` instead of the value. The value is used for the call and redacted from everything kept: node outputs (also derived values such as `toUpperCase()`), errors, node input and parameter snapshots, checkpoints, pinned data taken from a run, logs and live events. A secret that reaches item data is therefore `[redacted]` downstream; a Respond to Webhook reply built from it is not (it is sent, not kept).
- **At run time**: a credential is resolved right before a node uses it, in the host or in a worker. Values are cached per provider and name for `LANDFLOW_SECRETS_CACHE_TTL` seconds (60; 0 turns the cache off) and parallel reads share one request. The saved credential keeps the expression. Values are never written to execution data, checkpoints, live events or logs: each resolved value (6 characters or longer) is replaced by `[redacted]` in node outputs and errors, stored execution rows and log lines. A missing provider, secret or key of a JSON secret (“External secret $secrets.vault.db has no key “pasword””) fails with a message that names the reference, not the value.

**Environments.** Run one instance per environment (its own database, credentials, variables and secrets providers) and set `LANDFLOW_ENVIRONMENT` (`development`, `staging`, `production` or any name). Without it nothing below applies.

- **Shell**: a badge under the logo names the environment (and says when it is protected).
- **Branches**: each environment has a Git branch. This instance's is Settings → Source control's branch; Settings → Environments lists the environments (`LANDFLOW_ENVIRONMENTS`, default development, staging, production) and their branches (default: the name).
- **Protected environment** (Settings → Environments, or `LANDFLOW_ENVIRONMENT_PROTECTED=true`, which wins): the editor is read-only with a banner; the workflows list (new, import, folders, rename, move, delete, drag and drop), project pages, templates (**Use template**) and agents (**Create workflow**) disable what would create or change a workflow, with the reason as the tooltip; and the API refuses workflow and folder changes and `POST /api/templates/:id/use` with 403 `{ protected: true }`, as do the instance MCP server's create and update tools. Runs, publish and unpublish (a rollback, an emergency stop), credentials, variables and data table rows stay open. Workflows change only by pull or promotion. The check sits next to the role checks and four-eyes publishing, not inside them.
- **Promote** (Settings → Environments, `landflow env promote staging`, `POST /api/environment/promote`): copies workflows (all, or the ones picked) from this environment's branch, as pushed, to the target's branch in a working copy (`<data>/source-control/promote`). The preview lists each workflow as added, modified or unchanged with a diff, and every file the commit writes with its own diff, plus the credentials and table rows it carries. A workflow that the target branch changed since the last promotion from here is a conflict (the promotion stops unless forced). The commit keeps the target's `active` flags, merges `variables.json` (the target's values stay, new keys come without a value) and `credentials.json`, brings the folders along, and with all workflows the data table schemas and, optionally, prunes.
- **Pull** (on the target: Settings → Environments, `landflow env pull`, or Source control → Pull): applies its branch. **Publish on pull** decides publication: `file` (default: publish what the file marks active, unpublish what it turns off), `all` (publish every created or updated workflow) or `none` (drafts only).
- **Variables per environment** (Settings → Variables → Environment values, `PUT /api/variables/:key/environments`): a value for an environment replaces the variable's value on the instance of that environment (`variable_environment_values`, migration 1001). They travel in `variables.json` when values are exported.
- **Credentials**: workflows reference credentials by name and type, so the target uses its own credential of the same name. **Credential mapping** (Settings → Environments) points a name to a differently named credential. A credential that reads `$secrets` resolves against the target's providers of that name.
- **Credential definitions** (on by default; `credentials: false`, `landflow env promote --no-credentials` leave them out): when an instance promotes its own environment, the credentials the promoted workflows use travel in `credentials.json` as definitions: name, type, non-secret fields and `secretFields`, the names of the secret fields. A secret value never leaves the instance: a secret field is left out, or holds the `$secrets` reference a **secret mapping** (Settings → Environments: credential, field, `{{ $secrets… }}` value, optionally for one target environment) gives it, so the target reads its own secret store. The target's pull creates the credentials it lacks (same name and type, or mapped) with those fields and warns which secret fields to fill in; it leaves credentials it has alone unless the pull asks to **update existing credentials** (Settings → Environments → Pull, `landflow env pull --update-credentials`, `updateCredentials: true` on `/api/environment/pull` and `/api/source-control/pull`): then the non-secret fields of a credential of the same name and type take the file's values (the preview lists the fields), a secret field changes only to a `$secrets` reference, and a secret value is never touched; a literal value in a secret field of a file is dropped with a warning either way. A pull that changes a credential's values records the person who pulled as its last changer (`updatedBy`, "Last changed by" in the dialog, [integrations.md](integrations.md)); one that changes no value keeps the last changer, and fields a type fixes (`hidden` with a default) take the type's value.
- **Data table rows**: tables opted in (Settings → Environments **Promote rows of**, `rowTables`; `landflow env promote --rows <table>` for one promotion, `--no-rows` for none) travel as `data-tables/<slug>.rows.json` next to their schema, for lookup and reference data. The target's pull replaces the table's rows with the file's (in one transaction, when they differ); cells of columns the table lacks are dropped with a warning. Rows come from the promoting instance, never from another environment's branch. **Merging rows**: with *Merge by* key columns set for a table (Settings → Environments, `rowMerge`: `{ "Countries": { "keys": ["code"], "deleteMissing": false } }`, key columns must exist), the file carries `merge` and the target's pull merges instead of replacing: it inserts rows whose key is new, updates rows whose key matches and whose values differ, leaves the target's other rows alone, and with *Delete missing* removes rows the file lacks; a duplicate or empty key in the file or the table refuses the merge with an error, and the preview reads `merge by code · +2 new · ~1 changed`.
- **Approval**: with four-eyes on (Settings → Governance), a promotion is a request (202 `{ approvalRequired, request }`; the CLI exits 8) that another owner or admin approves or rejects in Settings → Environments → Promotion requests, with the rules of publish approvals (not the requester; the approver passes the approver checks of each changed workflow). **Per project**: a project can ask for four-eyes itself (the project page → Governance → *Require four-eyes on publishing*, `fourEyes` in the project's settings), and a promotion that changes a workflow of such a project becomes a request even when the instance's setting is off (the dry-run preview decides; the project's approver rules apply to approving it). Approving promotes exactly what was previewed: if a branch, a promoted credential, table rows or a setting changed since, the request is stale (409) and has to be asked again. A newer request for the same target replaces a pending one; the requester can withdraw it. Approvers are emailed and the governance channels notified; requests are kept in `promotion_requests` (migration 1650) and audited (`promotion_request.*`).

## Dynamic secrets

A credential a database node reads is the same for every run until a person changes it, and a leaked run log exposes it for as
long as it lives. An OpenBao or HashiCorp Vault provider can instead **issue a credential per run**: its database secrets
engine makes a user with a password and a lease for each request and removes it when the lease ends. Landflow asks for one when
a run needs it, hands it to the run's nodes, and revokes it when the run ends.

- **Turn it on**: in the provider's settings (Settings → External secrets → the Vault provider) set **Dynamic mounts**
  (`database/`, comma separated for more) and **Lease TTL** (seconds, 60 to 3600, default 900). A path under a dynamic mount is
  issued, never read as a KV entry: `{{ $secrets.bao['database/creds/report-reader'].username }}` and `….password` in a
  credential's fields (a Postgres credential's user and password, for example). The engines that answer `GET <mount>/creds/<role>`
  work (database, RabbitMQ, Consul); others are not recognised as dynamic.
- **One user per run**: the first node of a run whose credential reads the path asks the store for a credential; every later
  node, and every item, of that run gets the same one (a run that waits and resumes, in the same process or another, keeps
  its user too). Two runs get two users. A run that fails before it reaches the node issues nothing. The lease is asked for
  at the node, not at the start of the run.
- **Where it works**: only in a node's credential during a run. Test connection, agents' models and channels, alert channels,
  OAuth2 Connect, app webhook registration, the editor's option lists and node parameters refuse a dynamic path with "a dynamic
  secret is issued per run: use it in a node credential".
- **The lease** (`secret_leases`, migration 2933): one row per (run, provider, path) with when it was issued and when it ends,
  its state, and the lease id and the issued values **sealed** under purposes that name the row (`secrets.lease.id:<row id>`,
  `secrets.lease:<row id>`: the vault's key ring, re-sealed by key rotation) so a resumed run reuses its user; both are dropped when the lease ends. The values never enter the value
  cache, and are redacted like every `$secrets` value (node outputs, errors, stored run rows, logs, live events).
- **It ends** (any status of the run, cancel and timeout included, in the process that saved the run's end; a run that only waits
  keeps it): the host asks the store to revoke it (`sys/leases/revoke`) at once, and the user is gone in the database. The
  **lease sweeper** (a leader service, every minute) revokes the leases of runs that are over or gone (a host killed mid-run,
  a worker that died between save and revoke), ends leases whose time passed while their run waited (`expired`: the store
  removed them itself, and a node after the wait fails with "the run’s lease … ended" rather than getting a second user), and
  **renews** a running run's lease with under two minutes left by the provider's Lease TTL (`sys/leases/renew`), up to an hour
  after it was issued. A revoke the store refuses (down, sealed) stays `active` and is retried at 30 s, 60 s, 2 min … at most
  every 30 minutes; after 24 hours it becomes `revoke_failed` with an audit event and a red banner on the Leases section until an
  admin revokes it or sets it aside. At most 10,000 leases are open; the next node fails with "too many open leases". Ended rows are
  deleted after 30 days.
- **What "revoked" means**: Vault and OpenBao answer 204 for a lease they don't know, so a lease the store already dropped (a restarted
  dev OpenBao, a lease that ran out) also reads as revoked; it means the store accepted the call, not that a user was found. A store
  that answers 400 "lease not found" is read as gone. A lease id that can't be unsealed (the key changed) is a failed revoke, not a
  revoked one. **Give every role `VALID UNTIL`** (`creation_statements` with `VALID UNTIL '{{expiration}}'`): the database then ends the
  login by itself if Landflow never gets to revoke it, and a dev OpenBao that restarts (it keeps leases in memory) leaves its roles
  behind until that time.
- **Which run**: the engine names the run (`secretRun` in its options, set by the runner for a saved run); a call that only has an
  execution id of its own making (an agent's channel, an MCP tool list, a run's change summary) gets the refusal above, never a lease.
- **Who**: Settings → Leases and both lease routes are for the built-in owner and admin (`instanceAdmin`), also for reading: a lease names
  runs of every project.
- **Leases** (Settings → External secrets, shown once a provider has Dynamic mounts; `GET /api/external-secrets/leases`): one row
  per lease with its run (a link to the Run trace), the secret, when it was issued and ends, and its state (Active, Revoked,
  Expired, Not revoked). **Revoke now** removes one credential at the store; **Revoke run** every open lease of a run
  (`POST /api/external-secrets/leases/revoke`). The list never shows a lease id or a value. Audit events: `secrets.lease.issued`,
  `.revoked`, `.expired`, `.revoke_failed`, `.dismissed`.
- **The local engine**: `deploy/scripts/openbao-db-engine.sh` mounts the `database/` engine in the development OpenBao
  (`landflow-infra`, in memory), configures a connection to the infra Postgres' `landflow_test` database and the role
  `report-reader` (15-minute lease, 1 hour at most; it creates a short-lived login that can read `public`). It is idempotent
  and changes only that OpenBao and adds short-lived roles to `landflow_test`. Tests use the fake Vault of
  `@landflow/test-fakes/vault-leases`; the real engine is `test/secret-leases-openbao.integration.test.ts`
  (`LANDFLOW_INTEGRATION=secrets,postgres`).
- **Not built**: Landflow-native issuers (creating Postgres roles itself, AWS STS, cloud IAM users), other providers' dynamic engines,
  dynamic values outside a node credential, and a new lease for a run that waits past its lease. See [limitations.md](../limitations.md).

## Encryption keys and rotation

Credentials and every other value the host seals (alert channel and SIEM secrets, kagent tokens, signing keys, SAML keys,
external secrets providers, transport connections, the ids and values of leased dynamic secrets) use AES-256-GCM with a key ring (`lib/server/credentials/key-ring.ts`).

- **The ring.** `LANDFLOW_ENCRYPTION_KEYS=kid:key,kid:key`: the first key seals everything new, the others only open older
  data. `LANDFLOW_ENCRYPTION_KEY` (or the generated `encryption.key`) stays and is kid `k0`. A key of 64 hex characters is used as
  is; any other text is a passphrase, stretched with scrypt (N=2^15, r=8, p=1, salt `landflow:kdf:v2:<kid>`). A passphrase in
  `LANDFLOW_ENCRYPTION_KEY` was one unsalted SHA-256 before: that form stays in the ring as `k0-legacy`, so old data opens. With
  no ring set, `k0` seals (and v1 values are upgraded by a rotation).
- **Sealed format.** Version 2 names its key (`{ v: 2, kid, iv, tag, value }`; strings are `v2.<kid>.<iv>.<tag>.<ciphertext>`).
  A credential's blob is bound to its id as associated data (`landflow:credential:<id>`), so a blob copied to another row does
  not open. Version 1 values (no kid, no AAD) open with `k0`, then `k0-legacy`.
- **Derived keys.** `deriveKey(label)` is HKDF-SHA256 from the primary key, one per label (resume URLs, approval email links,
  OAuth2 state and PKCE). A link or state made earlier still verifies: the check tries every ring key and, for one release,
  the old HMAC derivation.
- **Rotating, without downtime.**
  1. Generate a key (`openssl rand -hex 32`) and put it first: `LANDFLOW_ENCRYPTION_KEYS=2026b:<new>,2026a:<old key>` (keep the
     old key, and `LANDFLOW_ENCRYPTION_KEY` as it is).
  2. Queue mode: roll **every** main and worker onto the new ring before the next step, or a process without it can't open values
     the others seal. The route refuses (409) while no ring is configured.
  3. As the owner, `POST /api/settings/encryption/rotate` (session only; audit event `encryption.rotate`), or stop the host and run
     `pnpm --filter @landflow/web rotate-key` with the same environment. It re-seals credentials and the stores listed in
     `credentials/rotate.ts` one value at a time, skips what is on the primary key, and can be run again after an interruption.
     Re-sealing changes no data: each credential keeps who last changed it (`updatedBy`, [integrations.md](integrations.md)).
  4. The answer has `resealed`, `current`, `failed` (what no key opened) and `done`. **Never remove a key before rotate reports
     `done: true`.** Then drop it from the ring and restart.
     A value sealed under a key that is no longer anywhere (a lost key, or data copied from another instance) stays in
     `failed` on every run, so `done` never turns true. Each entry is `<store>:<id>`: put the key back in the ring if you have
     it; otherwise enter the secret again where it is set (the credential, the alert channel, the SIEM destination, the
     agent's kagent connection, the anchoring settings), or delete that credential or row, and run rotate again.
     Dropping an old key also voids what was signed under it: resume URLs and approval email links still in flight (waits can
     live for days with `LANDFLOW_RESUME_SIGNATURES=required`), so wait for those to finish or expire first.
     A key or passphrase can't contain a comma, and a kid is letters, digits, `_` or `-` (up to 32).
     The script works with SQLite and Postgres: it opens the database and waits for the write queue before it ends. Rotation
     rewrites whole rows from the host's copy, so in queue mode a write to the same row from another process during the run
     (an alert channel's last delivery, say) can be overwritten; run it when the cluster is quiet.

### Project keys

Every project has its own data key (DEK) for its credentials, so one project's key opens only that project's
credentials and a project can be crypto-shredded. The layers are: the key ring (above) wraps each project's key, and the
project's key seals its credentials (`lib/server/credentials/project-key-store.ts`, `project-keys.ts`).

- **What is sealed with them.** Credentials only (the personal project of each user included; a credential's project is its
  home project). Alert channels, SIEM destinations, MCP and audit signing keys, TOTP and the other `sealSecret` values stay
  on the ring. On by default: a credential created or changed after the upgrade is sealed with its project's key; the first
  save in a project creates its key (audit event `encryption.project_key.created`).
- **The format.** Version 3: `{ v: 3, dek: "<projectId>.<version>", iv, tag, value }` with the same associated data as
  version 2 (`landflow:credential:<id>`). The key is 256 random bits kept in the `project_keys` table (migration 2932), wrapped
  by the ring's primary key as a version 2 string whose associated data is `landflow:project-key:<projectId>:<version>`: a
  wrapped key copied to another project or version does not open. A key that is unwrapped lives in a process's memory for ten
  minutes and is never written, logged or audited. Credentials sealed before the upgrade (version 1 and 2) still open and
  stay as they are until the owner runs **migrate**.
- **Root rotation** (above) re-wraps the project keys with the new primary and touches no credential row: it takes as long
  as there are projects, not credentials. The answer, the script's output and the audit event carry `projectKeys.rewrapped`.
  A version 1 or 2 credential is re-sealed on the ring as before (never onto a project key); a version 3 one is left alone.
- **Moving and deleting.** Moving a credential to another project re-seals it with the target's key, right after the move
  commits. Deleting a project (with a transfer) or removing a user does the same for what moved and then deletes the project's
  keys, which are **retired**, not deleted: a key is destroyed by a later sweep (run by `migrate`) once it has been retired for
  15 minutes (longer than a process caches it, so none is still sealing with it) and no stored credential names it (Postgres is
  asked, not only this process's copy). A credential whose re-seal failed stays readable on the old key, and the key stays
  until `migrate` has moved it. So crypto-shredding a project is **delayed**: after the project is deleted and its
  credentials are gone, run `migrate` once more than 15 minutes later; from then on a copy of the database and
  `credentials.json` can't open their old ciphertext (a backup taken earlier still holds the wrapped key).
- **Owner routes** (owner only, session only, no API key):

  ```bash
  curl -b "$SESSION" http://localhost:3000/api/settings/encryption/project-keys                       # status
  curl -b "$SESSION" -X POST -H 'content-type: application/json' -d '{"action":"migrate"}' \
       http://localhost:3000/api/settings/encryption/project-keys                                     # old credentials onto project keys
  curl -b "$SESSION" -X POST -H 'content-type: application/json' -d '{"action":"revert"}' \
       http://localhost:3000/api/settings/encryption/project-keys                                     # everything back on the ring
  curl -b "$SESSION" -X POST http://localhost:3000/api/settings/encryption/project-keys/<projectId>/rotate   # one project's key
  ```

  *Status* lists per project its active and retired versions and the credentials sealed with it, the credentials still on the
  ring (`onRing`) and keys this process can't unwrap (`unreadable`: the ring lacks the key that wrapped them). *Migrate* seals
  every credential with its project's active key, one at a time: run it again after an interruption or while `done` is false;
  it also sweeps (above): keys retired for 15 minutes that no credential names are deleted; keys of projects that no longer
  exist are retired first. *Rotate* makes a new version, re-seals that project's credentials only and retires the old
  version (the sweep deletes it later).
- **Audit.** Creating a key and the root re-wrap are fail-open (as root rotation is: a save never waits on them). Rotating a
  project's key, destroying one, migrate and revert are fail-closed: with `LANDFLOW_AUDIT_FAIL_CLOSED=true` and no audit
  storage they answer 503 and change nothing (a destroy keeps the key, retired). Events: `encryption.project_key.created`,
  `.rewrapped`, `.rotated`, `.destroyed`, `.migrated`, `.reverted`; they carry ids, versions and counts, never key material.
- **Before a downgrade** to a build without project keys: set `LANDFLOW_PROJECT_KEYS=off` on every process (new saves then
  seal on the ring), then run **revert** and check that `onProjectKeys` is 0: that build can't open version 3 values. Revert
  puts every credential back on the ring's primary key as version 2 (the keys stay in `project_keys`).
- **Other ways a credential is created.** A credential made by Git sync or a promotion is sealed with the key of its project
  (the default one until it is moved) only if the project's key exists; otherwise it stays on the ring until its next save or
  `migrate`. The same holds in queue mode for the first credential of a project: the key is made in Postgres, and a save that
  gets there first is sealed on the ring and moved by the next save or `migrate`.
- **Outside the shred.** Plaintext copies of a credential that left the vault are not covered by destroying a key: the
  secrets kagent holds for a deployed agent (Kubernetes Secrets) and the keys LiteLLM was given.
- **Back up together.** Credentials (`credentials.json` or the `credentials` table), the `project_keys` table and the ring are
  one unit: a restore of the credentials without their keys loses them (that is also how a project is shredded).
- **Queue mode.** A key exists once Postgres has it: it is created, and a version is added, in Postgres in one transaction under
  a lock per project, so two processes never make different keys. Changes to a key row are conditional updates that name only
  the column they change, and tell the other processes, which drop what they cached for the project (an unwrapped key is also
  zeroed and dropped after ten minutes). A process that has not yet heard of a rotation may seal one more value with the old
  version; that is why a rotation only retires it.
