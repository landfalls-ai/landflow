/**
 * The configuration catalog (lib/server/config/catalog.ts) against the source: every environment name the host reads is
 * catalogued, the number of files that read process.env themselves can only go down, and the generated reference page
 * is the committed one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_CATALOG, NOT_CONFIGURATION, catalogEntry, catalogNames, checkConfig } from '../src/lib/server/config';
import { renderConfigDocs } from '../src/lib/server/config/render-docs';

const SRC = join(__dirname, '..', 'src');
const CONFIG_DIR = join(SRC, 'lib', 'server', 'config');
const PAGE = join(__dirname, '..', '..', '..', 'docs', 'reference', 'configuration.md');

/** Files that read `process.env` outside lib/server/config today. Lower it when a reader moves into config; never raise it. */
const MAX_FILES_READING_PROCESS_ENV = 88;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ path, rel: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));

/** `process.env.NAME`, `process.env['NAME']`, `env.NAME` (a readers' `env` parameter) and a bare quoted LANDFLOW_/OTEL_ name. */
function namesRead(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]!);
  for (const m of text.matchAll(/process\.env\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g)) names.add(m[1]!);
  for (const m of text.matchAll(/['"`]((?:LANDFLOW|OTEL)_[A-Z0-9_]+)['"`]/g)) names.add(m[1]!);
  return [...names];
}

describe('configuration catalog', () => {
  it('lists every environment name the source reads', () => {
    const known = new Set([...catalogNames(), ...NOT_CONFIGURATION]);
    const missing = new Map<string, string[]>();
    for (const file of files) {
      if (file.path === join(CONFIG_DIR, 'catalog.ts')) continue;
      for (const name of namesRead(file.text)) if (!known.has(name)) missing.set(name, [...(missing.get(name) ?? []), file.rel]);
    }
    const report = [...missing].map(([name, where]) => `${name} (${where.join(', ')})`);
    expect(report, `Add each to CONFIG_CATALOG in lib/server/config/catalog.ts, then run \`pnpm --filter @landflow/web gen:config-docs\``).toEqual([]);
  });

  it('has one entry per name, and aliases that no entry also uses', () => {
    const seen = new Set<string>();
    for (const entry of CONFIG_CATALOG) for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      expect(seen.has(name), `${name} is catalogued twice`).toBe(false);
      seen.add(name);
    }
    expect(catalogEntry('AI_USAGE_RETENTION_DAYS')?.name).toBe('LANDFLOW_AI_USAGE_RETENTION_DAYS');
    expect(catalogEntry('USAGE_RETENTION_DAYS')?.name).toBe('LANDFLOW_USAGE_RETENTION_DAYS');
    expect(catalogEntry('LANDFLOW_VALKEY_URL')?.description).toContain('`memory`');
    for (const name of ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_TRACES_SAMPLER_ARG', 'OTEL_LOGS_EXPORTER', 'OTEL_BLRP_SCHEDULE_DELAY']) {
      expect(catalogEntry(name), name).toBeDefined();
    }
  });

  it('redacts what the catalog marks secret, and asks for what it marks required in production', () => {
    const r = checkConfig({ LANDFLOW_PROFILE: 'production', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x', LANDFLOW_STT_API_KEY: 'k', LANDFLOW_REGISTRY_OPEN: 'true' });
    expect(r.effective.OTEL_EXPORTER_OTLP_HEADERS).toBe('[set]');
    expect(r.effective.LANDFLOW_STT_API_KEY).toBe('[set]');
    expect(r.errors.join()).toContain('LANDFLOW_PUBLIC_URL');
  });

  // The count is a ratchet: new reads go through lib/server/config (envFlag, envNumber, envString, ...), so a variable is
  // parsed one way and its default lives in one place. If this fails after you added a read, use a helper from
  // lib/server/config instead; if it fails because you removed one, lower MAX_FILES_READING_PROCESS_ENV.
  it('does not let more files read process.env outside lib/server/config', () => {
    const readers = files.filter((f) => !f.path.startsWith(CONFIG_DIR + sep) && /\bprocess\.env\b/.test(f.text)).map((f) => f.rel);
    expect(readers.length, `files reading process.env directly:\n${readers.join('\n')}`).toBeLessThanOrEqual(MAX_FILES_READING_PROCESS_ENV);
  });

  it('generates the committed reference page', () => {
    expect(readFileSync(PAGE, 'utf8'), 'run `pnpm --filter @landflow/web gen:config-docs` and commit docs/reference/configuration.md').toBe(renderConfigDocs());
  });
});
