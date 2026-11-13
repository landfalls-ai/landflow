/**
 * Re-seal everything the vault encrypted with the primary key of the ring (LANDFLOW_ENCRYPTION_KEYS). Credentials are
 * the vault's own; every other sealed value (`sealSecret` strings: alert channels, SIEM destinations, audit signing
 * and MCP signing keys, external secrets providers, transport connections, agent kagent tokens, SAML keys, audit
 * anchoring) is found by shape in the stores listed here, so a new store that seals with `sealSecret` is covered when
 * its table is added to TABLES below. Each value is written on its own and a value already on the primary key is
 * skipped, so a run that stops can simply be run again; one that can't be opened is reported and left as it is.
 * Never remove an old key from the ring before a run reports no failures.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configStoreKind, writeJsonFile } from '../config-store';
import { database } from '../db';
import { store } from '../store';
import { credentials, parseSealedString } from './vault';

export interface RotationResult {
  /** The key everything is sealed with now. */
  primary: string;
  resealed: number;
  /** Already on the primary key. */
  current: number;
  /** What could not be opened, as `<store>:<id>`; it still needs its old key in the ring. */
  failed: string[];
  /** Per store, how many values were re-sealed. */
  stores: Record<string, number>;
}

/** Tables with sealed values: the key columns (as the database's upsert knows them) and the column to scan (a sealed string or JSON holding some). */
const TABLES: Array<{ table: 'settings' | 'config_files' | 'alert_channels' | 'audit_destinations' | 'audit_signing_keys' | 'external_secret_providers' | 'transport_connections' | 'agent_definitions'; key: string; column: string }> = [
  { table: 'settings', key: 'key', column: 'value' },
  { table: 'config_files', key: 'name', column: 'data' },
  { table: 'alert_channels', key: 'id', column: 'data' },
  { table: 'audit_destinations', key: 'id', column: 'data' },
  { table: 'audit_signing_keys', key: 'key_id', column: 'private_key' },
  { table: 'external_secret_providers', key: 'name', column: 'secrets' },
  { table: 'transport_connections', key: 'id', column: 'secrets' },
  { table: 'agent_definitions', key: 'id', column: 'data' },
];

const SEALED = /^v[12]\.[A-Za-z0-9+/=_.-]+$/;

/** `text` with every sealed string in it re-sealed (text itself, or JSON holding some); undefined when nothing changed. */
function resealText(text: string, tally: { resealed: number; current: number; failed: number }): string | undefined {
  const seal = (value: string): string => {
    if (!SEALED.test(value) || !parseSealedString(value)) return value;
    try {
      const next = credentials.resealSecret(value);
      if (next === undefined) tally.current += 1;
      else tally.resealed += 1;
      return next ?? value;
    } catch {
      tally.failed += 1;
      return value;
    }
  };
  if (SEALED.test(text) && parseSealedString(text)) {
    const next = seal(text);
    return next === text ? undefined : next;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const before = tally.resealed;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return seal(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  const walked = walk(parsed);
  return tally.resealed === before ? undefined : JSON.stringify(walked);
}

/** Re-seal every stored sealed value with the primary key. Idempotent; call it with the new ring on every process. */
export function rotateEncryption(): RotationResult {
  const result: RotationResult = { primary: credentials.primaryKid, resealed: 0, current: 0, failed: [], stores: {} };
  const count = (name: string, tally: { resealed: number; current: number; failed: number }, ids: string[] = []) => {
    result.resealed += tally.resealed;
    result.current += tally.current;
    if (tally.resealed) result.stores[name] = (result.stores[name] ?? 0) + tally.resealed;
    if (tally.failed) result.failed.push(...(ids.length ? ids : [name]).map((id) => `${name}:${id}`));
  };

  const creds = credentials.rotateCredentials();
  result.resealed += creds.resealed;
  result.current += creds.current;
  if (creds.resealed) result.stores.credentials = creds.resealed;
  result.failed.push(...creds.failed.map((id) => `credentials:${id}`));

  const db = database();
  for (const { table, key, column } of TABLES) {
    for (const row of db.all<Record<string, string | null>>(`SELECT * FROM ${table}`)) {
      const text = row[column];
      if (!text) continue;
      const tally = { resealed: 0, current: 0, failed: 0 };
      const next = resealText(text, tally);
      if (next !== undefined) db.upsert(table, { ...row, [column]: next });
      count(table, tally, [String(row[key])]);
    }
  }

  // Files mode keeps agents and the audit anchoring settings in files (the database holds them otherwise).
  if (configStoreKind() === 'files') {
    const files = [join(store.dir, 'audit-anchoring.json'), ...safeList(join(store.dir, 'agents')).map((name) => join(store.dir, 'agents', name))];
    for (const path of files) {
      const value = readJsonFile<unknown>(path);
      if (value === undefined) continue;
      const tally = { resealed: 0, current: 0, failed: 0 };
      const next = resealText(JSON.stringify(value), tally);
      if (next !== undefined) writeJsonFile(path, JSON.parse(next));
      count('files', tally, [path.slice(store.dir.length + 1)]);
    }
  }
  return result;
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}
