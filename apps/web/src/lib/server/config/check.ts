/**
 * The production check: pure, over an environment object, so it is testable and callable at boot (wave 2 wires it into
 * bootstrap). Development profile reports nothing for development values. Messages name variables, never values.
 */
import { flag, SECRET_NAME } from './parse';
import { profile } from './profile';

/** Variables that hold secrets: never shown in `effective`, checked for development defaults in production. */
export const SECRET_VARIABLES = [
  'LANDFLOW_ENCRYPTION_KEY',
  'LANDFLOW_BINARY_SECRET',
  'LANDFLOW_TRANSPORT_SECRET',
  'LANDFLOW_REGISTRY_SECRET',
  'LANDFLOW_CODE_RUNNER_SECRET',
  'LANDFLOW_MCP_GATEWAY_SECRET',
  'LANDFLOW_OWNER_PASSWORD',
  'LANDFLOW_SMTP_PASS',
  'LANDFLOW_S3_SECRET_ACCESS_KEY',
  'LANDFLOW_CLAIM_SECRET_ACCESS_KEY',
  'LANDFLOW_SECRET',
  'LANDFLOW_OIDC_CLIENT_SECRET',
  'LANDFLOW_SAML_DECRYPTION_KEY',
  'LANDFLOW_SAML_DECRYPTION_NEXT_KEY',
  'LANDFLOW_STT_API_KEY',
  'LANDFLOW_GIT_TOKEN',
  'LANDFLOW_GIT_PASSWORD',
  'LANDFLOW_VALKEY_SENTINEL_PASSWORD',
] as const;

/** URLs with credentials in their userinfo: the password is redacted. */
const URL_SECRETS = ['DATABASE_URL', 'LANDFLOW_VALKEY_URL'] as const;

/** The development values in deploy/.env.example and the compose files (besides anything containing `dev-only`). */
const DEVELOPMENT_DEFAULTS = new Set(['change-me', 'changeme', 'landflow-dev-client-secret', 'landflow-dev-only']);

const isDevelopmentValue = (value: string) => /dev-only/i.test(value) || DEVELOPMENT_DEFAULTS.has(value.toLowerCase());

const SECRET_PARAMS = /^(password|sslpassword|passwd|pass|token|api_?key|secret)$/i;

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = 'redacted';
    else if (parsed.username) parsed.username = 'redacted';
    for (const key of [...parsed.searchParams.keys()]) if (SECRET_PARAMS.test(key)) parsed.searchParams.set(key, 'redacted');
    return parsed.toString();
  } catch {
    return '[set]';
  }
}

function urlSecretParam(url: URL): string | undefined {
  for (const [key, val] of url.searchParams) if (SECRET_PARAMS.test(key) && val) return val;
  return undefined;
}

/** Email addresses keep their first character and domain (`o***@example.com`): who the owner is stays out of logs. */
const maskEmails = (value: string) => value.replace(/([^\s,;:<>"'@])[^\s,;:<>"'@]*@([\w.-]+)/g, '$1***@$2');

/** True when a URL carries a credential: userinfo (even a username alone) or a secret query parameter. */
function hasUrlCredential(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.password || url.username || urlSecretParam(url));
  } catch {
    return false;
  }
}

/** The password in a URL's userinfo, if the value is a URL that has one. */
function urlPassword(value: string): string | undefined {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.password) || urlSecretParam(url);
  } catch {
    return undefined;
  }
}

/** Key ids are not secret: they stay readable. */
const KEY_IDS = /(ACCESS_KEY_ID)$/i;

export interface ConfigCheck {
  errors: string[];
  warnings: string[];
  /** Every LANDFLOW_*, OTEL_* and DATABASE_URL variable that is set; secrets as `[set]`, URL passwords redacted, emails masked. */
  effective: Record<string, string>;
}

export function checkConfig(env: NodeJS.ProcessEnv = process.env): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const set = (name: string) => env[name]?.trim() || undefined;

  if (profile(env) === 'production') {
    if (!set('LANDFLOW_PUBLIC_URL')) errors.push('LANDFLOW_PUBLIC_URL is not set: links in emails, alerts and OAuth redirects need the address users reach the host at');
    for (const name of SECRET_VARIABLES) {
      const value = set(name);
      if (value && isDevelopmentValue(value)) errors.push(`${name} is a development value: set a secret of your own`);
    }
    for (const name of URL_SECRETS) {
      const password = set(name) && urlPassword(set(name)!);
      if (password && isDevelopmentValue(password)) errors.push(`${name} has a development password: set one of your own`);
    }
    if (!set('LANDFLOW_REGISTRY_SECRET') && !flag(env.LANDFLOW_REGISTRY_OPEN, false)) {
      errors.push('LANDFLOW_REGISTRY_SECRET is not set: plugins could register without proof (set it, or LANDFLOW_REGISTRY_OPEN=true to accept that)');
    }
    if (!set('LANDFLOW_ENCRYPTION_KEY')) warnings.push('LANDFLOW_ENCRYPTION_KEY is not set: the key file under the data directory is used');
    if (!set('LANDFLOW_CODE_RUNNER_URL') && !set('LANDFLOW_CODE_IN_PROCESS')) {
      warnings.push('LANDFLOW_CODE_RUNNER_URL is not set: Code nodes fail (they no longer run inside the host in production; set a runner, or LANDFLOW_CODE_IN_PROCESS=true to accept that)');
    }
    if (!set('LANDFLOW_BINARY_SECRET')) warnings.push('LANDFLOW_BINARY_SECRET is not set: binary links are signed with a key derived from the encryption key');
  }

  const effective: Record<string, string> = {};
  const secrets = new Set<string>(SECRET_VARIABLES);
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!(name.startsWith('LANDFLOW_') || name.startsWith('OTEL_') || name === 'DATABASE_URL')) continue;
    if (secrets.has(name)) effective[name] = '[set]';
    else if ((URL_SECRETS as readonly string[]).includes(name)) effective[name] = redactUrl(value);
    else if (SECRET_NAME.test(name) && !KEY_IDS.test(name)) effective[name] = '[set]';
    else if (/EMAIL/.test(name)) effective[name] = maskEmails(value);
    // A comma-separated list of URLs (LANDFLOW_PLUGINS) doesn't parse as one URL: check each entry.
    else effective[name] = value.split(',').map((part) => (hasUrlCredential(part.trim()) ? redactUrl(part.trim()) : part)).join(',');
  }
  return { errors, warnings, effective };
}

/** The production check found errors: the message lists every one. The host refuses to boot (lib/server/runtime.ts). */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration refused in the production profile:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}
