/**
 * Where the CLI connects: `--url`/`--api-key`, else LANDFLOW_URL/LANDFLOW_API_KEY, else the config file that
 * `landflow login` writes, else http://localhost:3000 without a key. The file is
 * `$XDG_CONFIG_HOME/landflow/config.json` (default `~/.config/landflow/config.json`, or LANDFLOW_CONFIG), mode 0600
 * in a 0700 directory.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from './errors';

export const DEFAULT_URL = 'http://localhost:3000';

export interface StoredConfig {
  url?: string;
  apiKey?: string;
}

export type Source = 'flag' | 'env' | 'config' | 'default' | 'none';

export interface Connection {
  url: string;
  apiKey?: string;
  urlSource: Source;
  keySource: Source;
  configPath: string;
}

export function configPath(env: Record<string, string | undefined>, home: string): string {
  if (env.LANDFLOW_CONFIG) return env.LANDFLOW_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'landflow', 'config.json');
}

export function readConfig(path: string): StoredConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as StoredConfig;
    return { ...(typeof parsed.url === 'string' && { url: parsed.url }), ...(typeof parsed.apiKey === 'string' && { apiKey: parsed.apiKey }) };
  } catch {
    throw new CliError('config', `${path} isn't valid JSON: fix it or run \`landflow logout\``);
  }
}

/** Write the config readable by its owner only (0600, in a 0700 directory). */
export function writeConfig(path: string, config: StoredConfig) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function removeConfig(path: string): boolean {
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

/** An http(s) base URL without a trailing slash. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CliError('config', `"${raw}" isn't a URL (expected something like ${DEFAULT_URL})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError('config', `"${raw}" must be an http:// or https:// URL`);
  return trimmed;
}

export function resolveConnection(flags: { url?: string; apiKey?: string }, env: Record<string, string | undefined>, path: string): Connection {
  const stored = readConfig(path);
  const pick = (flag: string | undefined, envValue: string | undefined, config: string | undefined): [string | undefined, Source] =>
    flag ? [flag, 'flag'] : envValue ? [envValue, 'env'] : config ? [config, 'config'] : [undefined, 'none'];
  const [url, urlSource] = pick(flags.url, env.LANDFLOW_URL, stored.url);
  const [apiKey, keySource] = pick(flags.apiKey, env.LANDFLOW_API_KEY, stored.apiKey);
  return {
    url: normalizeUrl(url ?? DEFAULT_URL),
    urlSource: url ? urlSource : 'default',
    ...(apiKey && { apiKey: apiKey.trim() }),
    keySource,
    configPath: path,
  };
}

/** `lf_…abcd`: enough to recognise a key, not to use it. */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length <= 8 ? '…' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}
