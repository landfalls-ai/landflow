/** The typed configuration core: parsers, profile, URLs and the production check (lib/server/config). */
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, configIssues, envInt, envNumber, flag, int, number, ollamaUrl, profile, publicUrl, publicUrlConfigured, resetConfigIssues, url, marketplaceRegistryUrl } from '../src/lib/server/config';
import { clusterConfig } from '../src/lib/server/cluster/config';

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetConfigIssues();
});

describe('flag', () => {
  it.each([['1', true], ['true', true], ['YES', true], [' on ', true], ['0', false], ['False', false], ['no', false], ['OFF', false]])('%j is %s', (v, want) => {
    expect(flag(v, !want)).toBe(want);
  });
  it('uses the fallback when empty or invalid, and records the invalid one', () => {
    expect(flag(undefined, true)).toBe(true);
    expect(flag('', false)).toBe(false);
    expect(flag('maybe', true, 'LANDFLOW_X')).toBe(true);
    expect(configIssues()).toEqual([expect.objectContaining({ name: 'LANDFLOW_X', value: 'maybe' })]);
  });
});

describe('number and int', () => {
  it('never returns NaN and clamps', () => {
    expect(number('abc', { fallback: 5 })).toBe(5);
    expect(number('NaN', { fallback: 5 })).toBe(5);
    expect(number('Infinity', { fallback: 5 })).toBe(5);
    expect(number(undefined, { fallback: 7 })).toBe(7);
    expect(number('0', { fallback: 7, min: 2 })).toBe(2);
    expect(number('99', { fallback: 7, max: 10 })).toBe(10);
    expect(number('2.5', { fallback: 1 })).toBe(2.5);
    expect(int('2.9', { fallback: 1 })).toBe(2);
  });
  it('reads the environment at call time', () => {
    process.env.LANDFLOW_T = '12';
    expect(envInt('LANDFLOW_T', { fallback: 1 })).toBe(12);
    process.env.LANDFLOW_T = 'oops';
    expect(envNumber('LANDFLOW_T', { fallback: 3, min: 1 })).toBe(3);
    expect(configIssues().map((i) => i.name)).toContain('LANDFLOW_T');
  });
  it('does not record the value of a secret-named variable', () => {
    number('x', { fallback: 1, name: 'LANDFLOW_SOME_SECRET' });
    expect(configIssues()[0]).not.toHaveProperty('value');
  });
});

describe('urls', () => {
  it('normalises the public URL and defaults to localhost', () => {
    delete process.env.LANDFLOW_PUBLIC_URL;
    process.env.PORT = '4000';
    expect(publicUrl()).toBe('http://localhost:4000');
    expect(publicUrlConfigured()).toBe(false);
    process.env.LANDFLOW_PUBLIC_URL = ' https://flow.example.com// ';
    expect(publicUrl()).toBe('https://flow.example.com');
    expect(publicUrlConfigured()).toBe(true);
  });
  it('normalises the Ollama URL and ignores garbage', () => {
    delete process.env.OLLAMA_URL;
    expect(ollamaUrl()).toBe('http://127.0.0.1:11434');
    process.env.OLLAMA_URL = 'http://host.docker.internal:11434/';
    expect(ollamaUrl()).toBe('http://host.docker.internal:11434');
    process.env.OLLAMA_URL = 'not a url';
    expect(ollamaUrl()).toBe('http://127.0.0.1:11434');
    expect(url('ftp://x')).toBeUndefined();
  });
  it('the marketplace registry falls back to 127.0.0.1', () => {
    delete process.env.LANDFLOW_MARKETPLACE_REGISTRY_URL;
    delete process.env.LANDFLOW_PUBLIC_URL;
    process.env.PORT = '3001';
    expect(marketplaceRegistryUrl()).toBe('http://127.0.0.1:3001');
    process.env.LANDFLOW_PUBLIC_URL = 'https://a.b';
    expect(marketplaceRegistryUrl()).toBe('https://a.b');
    process.env.LANDFLOW_MARKETPLACE_REGISTRY_URL = 'http://reg:1';
    expect(marketplaceRegistryUrl()).toBe('http://reg:1');
  });
});

describe('profile', () => {
  it.each([
    [{}, 'development'],
    [{ NODE_ENV: 'production' }, 'production'],
    [{ NODE_ENV: 'production', LANDFLOW_PROFILE: 'development' }, 'development'],
    [{ NODE_ENV: 'development', LANDFLOW_PROFILE: 'production' }, 'production'],
    [{ NODE_ENV: 'production', LANDFLOW_PROFILE: 'bogus' }, 'production'],
    [{ LANDFLOW_PROFILE: ' Production ' }, 'production'],
  ])('%j is %s', (env, want) => {
    expect(profile(env as NodeJS.ProcessEnv)).toBe(want);
  });
});

describe('checkConfig', () => {
  const good = { LANDFLOW_PROFILE: 'production', LANDFLOW_PUBLIC_URL: 'https://flow.example.com', LANDFLOW_REGISTRY_SECRET: 'x'.repeat(24), LANDFLOW_ENCRYPTION_KEY: 'k'.repeat(32), LANDFLOW_BINARY_SECRET: 'b'.repeat(32) };

  it('passes a clean production environment', () => {
    const r = checkConfig(good);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
  it('names a development secret and never its value', () => {
    const r = checkConfig({ ...good, LANDFLOW_CODE_RUNNER_SECRET: 'landflow-code-runner-dev-only' });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('LANDFLOW_CODE_RUNNER_SECRET');
    expect(JSON.stringify(r)).not.toContain('landflow-code-runner-dev-only');
  });
  it('requires the public URL', () => {
    const { LANDFLOW_PUBLIC_URL: _, ...env } = good;
    expect(checkConfig(env).errors.join()).toContain('LANDFLOW_PUBLIC_URL');
  });
  it('requires the registry secret unless the registry is open', () => {
    const { LANDFLOW_REGISTRY_SECRET: _, ...env } = good;
    expect(checkConfig(env).errors.join()).toContain('LANDFLOW_REGISTRY_SECRET');
    expect(checkConfig({ ...env, LANDFLOW_REGISTRY_OPEN: 'true' }).errors).toEqual([]);
  });
  it('warns for a missing encryption key and binary secret', () => {
    const { LANDFLOW_ENCRYPTION_KEY: _a, LANDFLOW_BINARY_SECRET: _b, ...env } = good;
    const r = checkConfig(env);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain('LANDFLOW_ENCRYPTION_KEY');
    expect(r.warnings.join()).toContain('LANDFLOW_BINARY_SECRET');
  });
  it('says nothing about development values in development', () => {
    const r = checkConfig({ LANDFLOW_PROFILE: 'development', LANDFLOW_BINARY_SECRET: 'landflow-queue-dev-only-binary-secret', LANDFLOW_OWNER_PASSWORD: 'landflow-dev-only' });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
  it('redacts secrets and URL passwords in effective, and lists only Landflow variables', () => {
    const r = checkConfig({ ...good, DATABASE_URL: 'postgres://u:hunter2@db:5432/x', LANDFLOW_VALKEY_URL: 'redis://:pw123@v:6379', OTEL_SERVICE_NAME: 'svc', HOME: '/h', LANDFLOW_LOG_LEVEL: 'debug' });
    expect(r.effective.LANDFLOW_ENCRYPTION_KEY).toBe('[set]');
    expect(r.effective.LANDFLOW_LOG_LEVEL).toBe('debug');
    expect(r.effective.OTEL_SERVICE_NAME).toBe('svc');
    expect(r.effective.HOME).toBeUndefined();
    const text = JSON.stringify(r.effective);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('pw123');
    expect(r.effective.DATABASE_URL).toContain('db:5432');
  });
});

describe('clusterConfig keeps its truth table', () => {
  it('reads flags and numbers as before', () => {
    const c = clusterConfig({ LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS: 'YES', LANDFLOW_QUEUE_ALLOW_SQLITE: 'banana', LANDFLOW_WORKER_CONCURRENCY: 'x', LANDFLOW_LEADER_TTL_SECONDS: '1' });
    expect(c.offloadManual).toBe(true);
    expect(c.allowSqlite).toBe(false);
    expect(c.workerConcurrency).toBe(10);
    expect(c.leaderTtlMs).toBe(3000);
  });
});
