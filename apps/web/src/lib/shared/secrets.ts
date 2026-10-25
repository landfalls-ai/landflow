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

/** POST /api/environment/promote */
export interface PromotionResult {
  dryRun: boolean;
  from: { environment: string; branch: string; commit: string };
  to: { environment: string; branch: string; commit?: string };
  entries: PromotionEntry[];
  conflicts: number;
  /** Other files the promotion changes (folders, variables.json, credentials.json, data tables). */
  files: Array<{ status: 'A' | 'M' | 'D'; path: string }>;
  promoted: boolean;
  /** The commit pushed to the target branch. */
  commit?: string;
  warnings: string[];
}
