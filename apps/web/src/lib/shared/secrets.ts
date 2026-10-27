/**
 * External secrets (Settings → External secrets) and environments (Settings → Environments): types shared by the
 * API routes, the Settings page, the shell and the expression editor. No runtime imports.
 */

export const SECRET_PROVIDER_KINDS = ['vault', 'onePassword', 'awsSecretsManager', 'gcpSecretManager', 'azureKeyVault'] as const;
export type SecretProviderKind = (typeof SECRET_PROVIDER_KINDS)[number];

/** One setting of a provider kind, for the form. Secret fields are stored encrypted and never sent back. */
export interface SecretProviderField {
  name: string;
  label: string;
  type: 'string' | 'password' | 'textarea' | 'options' | 'number';
  options?: Array<{ value: string; label: string }>;
  default?: string | number;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  /** Shown only when another field has one of these values. */
  showWhen?: { field: string; values: string[] };
}

export interface SecretProviderKindInfo {
  kind: SecretProviderKind;
  label: string;
  description: string;
  /** The provider name suggested for a first provider of this kind (`$secrets.<name>`). */
  defaultName: string;
  fields: SecretProviderField[];
}

export interface SecretProviderCheck {
  ok: boolean;
  at: string;
  message: string;
  /** Secret names found (with `ok`). */
  count?: number;
}

/** A configured provider as the API shows it: settings without secret values, and the secret names it lists. */
export interface SecretProviderView {
  /** `$secrets.<name>`: letters, digits and `_`, starting with a letter. */
  name: string;
  kind: SecretProviderKind;
  enabled: boolean;
  /** Non-secret settings. */
  settings: Record<string, string | number>;
  /** Secret settings that hold a value (their values never leave the host). */
  secretsSet: string[];
  /** Secret names from the last connect or refresh (never values). */
  names: string[];
  lastCheck?: SecretProviderCheck;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/external-secrets */
export interface SecretProvidersResponse {
  providers: SecretProviderView[];
  kinds: SecretProviderKindInfo[];
  /** Seconds a fetched value is reused (LANDFLOW_SECRETS_CACHE_TTL). */
  cacheTtlSeconds: number;
  /** The instance's environment, which `{environment}` in a provider's path or prefix stands for. */
  environment?: string;
  /** Node parameter expressions may read `$secrets` at run time (Settings → External secrets; off by default). */
  allowInParameters: boolean;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/** How a pull treats publication: follow each file's `active` (default), publish every changed workflow, or save drafts only. */
export type PullPublishMode = 'file' | 'all' | 'none';

/** An explicit credential mapping for pulls: a file's `{ type, name }` reference uses this instance's credential. */
export interface CredentialMapping {
  type: string;
  /** The credential name the files use (the source environment's). */
  name: string;
  /** This instance's credential. */
  credentialId: string;
}

/**
 * Promotion: what a promoted credential's secret field holds in the target, instead of the value (which never travels):
 * a `$secrets` reference resolved against the target's providers (`{{ $secrets.vault.api.key }}`).
 */
export interface CredentialSecretMapping {
  /** The credential's type and name on this (the source) instance. */
  type: string;
  name: string;
  /** The secret field. */
  field: string;
  /** An expression that reads `$secrets`. */
  value: string;
  /** Only for promotions to this environment (default: every target). */
  environment?: string;
}

/** Settings → Environments, as stored (the environment itself comes from LANDFLOW_ENVIRONMENT). */
export interface EnvironmentSettings {
  /** Protected: workflows are read-only here; changes arrive only by pull or promotion. LANDFLOW_ENVIRONMENT_PROTECTED wins. */
  protected?: boolean;
  /** Git branch per environment (promotion targets); an environment not listed uses its name. */
  branches?: Record<string, string>;
  /** Environments promotion offers, in order (default: LANDFLOW_ENVIRONMENTS, else development, staging, production). */
  environments?: string[];
  publishOnPull?: PullPublishMode;
  credentialMap?: CredentialMapping[];
  /** Data tables (ids) whose rows promotion copies to the target (opt-in per table; schemas travel either way). */
  rowTables?: string[];
  /**
   * Per opted-in table (by id): merge its rows into the target's by key columns (insert new, update changed, optionally
   * delete the ones missing) instead of replacing them. The merge travels in the rows file, so the target applies it.
   */
  rowMerge?: Record<string, RowMerge>;
  /** `$secrets` references for promoted credentials' secret fields (left empty in the target otherwise). */
  secretMappings?: CredentialSecretMapping[];
}

/** How a promoted table's rows meet the target's: matched by `keys`, new ones inserted, changed ones updated, and with `deleteMissing` the rest deleted. */
export interface RowMerge {
  keys: string[];
  deleteMissing?: boolean;
}

/** GET /api/environment */
export interface EnvironmentView {
  /** LANDFLOW_ENVIRONMENT; undefined when the instance has none (then nothing here applies). */
  name?: string;
  protected: boolean;
  /** Where `protected` comes from. */
  protectedSource: 'env' | 'settings' | 'none';
  /** This instance's branch: Settings → Source control's branch. */
  branch?: string;
  environments: Array<{ name: string; branch: string; current: boolean }>;
  publishOnPull: PullPublishMode;
  credentialMap: Array<CredentialMapping & { credentialName?: string }>;
  /** Tables whose rows promotion copies, with their names (a deleted table has none). */
  rowTables: Array<{ id: string; name?: string; merge?: RowMerge }>;
  secretMappings: CredentialSecretMapping[];
  sourceControl: boolean;
}

/** One workflow in a promotion's preview. */
export interface PromotionEntry {
  id: string;
  name: string;
  /** In the source branch (`path`) and in the target branch (`targetPath`). */
  path?: string;
  targetPath?: string;
  status: 'added' | 'modified' | 'unchanged' | 'deleted';
  /** The target branch changed this workflow since the last promotion, and the source did too. */
  conflict?: string;
  /** A unified diff of the target's file against the promoted one. */
  diff?: string;
  /** Top-level fields that differ. */
  fields?: string[];
}

/** A credential definition in a promotion's preview: name, type and non-secret fields (secret fields stay empty or take a `$secrets` reference). */
export interface PromotionCredential {
  name: string;
  type: string;
  status: 'added' | 'modified' | 'unchanged';
  /** Secret fields: left empty in the target unless mapped. */
  secretFields: string[];
  /** Secret fields that carry a `$secrets` reference (a mapping, or the credential's own). */
  mapped: string[];
}

/** A data table whose rows the promotion copies (opted in). */
export interface PromotionTable {
  id: string;
  name: string;
  path: string;
  rows: number;
  status: 'added' | 'modified' | 'unchanged';
}

/** POST /api/environment/promote */
export interface PromotionResult {
  dryRun: boolean;
  from: { environment: string; branch: string; commit: string };
  to: { environment: string; branch: string; commit?: string };
  entries: PromotionEntry[];
  conflicts: number;
  /** Other files the promotion changes (folders, variables.json, credentials.json, data tables), with their diffs. */
  files: Array<{ status: 'A' | 'M' | 'D'; path: string; diff?: string }>;
  /** Credential definitions the promotion writes (those the promoted workflows use; from this instance). */
  credentials?: PromotionCredential[];
  /** Data tables whose rows it copies (opted in; from this instance). */
  tables?: PromotionTable[];
  promoted: boolean;
  /** The commit pushed to the target branch. */
  commit?: string;
  /** sha256 of what the promotion writes: an approval promotes only what was previewed. */
  digest?: string;
  warnings: string[];
}

export type PromotionRequestStatus = 'pending' | 'approved' | 'rejected' | 'canceled' | 'stale' | 'failed';

/** Four-eyes on promotion (Settings → Governance): a promotion waiting for (or decided by) a second person. */
export interface PromotionRequestView {
  id: string;
  status: PromotionRequestStatus;
  source: string;
  target: string;
  /** What was asked for: all workflows or these (ids), prune, force, the commit message, the tables whose rows go. */
  workflows?: string[];
  prune?: boolean;
  force?: boolean;
  message?: string;
  rowTables?: string[];
  credentials?: boolean;
  /** The preview when it was asked for (diffs trimmed when large). */
  preview: PromotionResult;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  comment?: string;
  /** Why it went stale or failed. */
  reason?: string;
  /** The promotion commit, once approved. */
  commit?: string;
  canApprove?: boolean;
  canCancel?: boolean;
}

/** POST /api/environment/promote with four-eyes on: 202, nothing promoted yet. */
export interface PromotionRequestedResponse {
  approvalRequired: true;
  request: PromotionRequestView;
}
