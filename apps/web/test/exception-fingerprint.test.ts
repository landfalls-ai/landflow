// The exception fingerprint groups one bug across releases (line numbers move) and keeps different call sites apart;
// the alert rules and the dashboard name only metrics the host defines.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { exceptionFingerprint } from '../src/lib/server/telemetry/fingerprint';

function withStack(name: string, stack: string) {
  const error = new Error('boom');
  error.name = name;
  error.stack = `${name}: boom\n${stack}`;
  return error;
}

describe('exception fingerprint', () => {
  const frames = (a: number, b: number, root = '/srv/app') =>
    [`    at save (${root}/apps/web/src/lib/server/store.ts:${a}:11)`, `    at handle (${root}/apps/web/src/lib/server/runner.ts:${b}:5)`, '    at node:internal/process/task_queues:95:5'].join('\n');

  it('is stable across line numbers, checkout paths and node internals', () => {
    expect(exceptionFingerprint(withStack('TypeError', frames(10, 20)))).toBe(exceptionFingerprint(withStack('TypeError', frames(99, 301, '/Users/me/landflow'))));
  });

  it('differs by call site and by exception type', () => {
    const base = exceptionFingerprint(withStack('TypeError', frames(1, 1)));
    expect(exceptionFingerprint(withStack('TypeError', '    at save (/srv/app/apps/web/src/lib/server/other.ts:1:1)'))).not.toBe(base);
    expect(exceptionFingerprint(withStack('RangeError', frames(1, 1)))).not.toBe(base);
  });

  it('ignores dependency frames and is 12 hex characters', () => {
    const fp = exceptionFingerprint(withStack('Error', `    at x (/srv/node_modules/pg/lib/a.js:1:1)\n${frames(1, 1)}`));
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).toBe(exceptionFingerprint(withStack('Error', frames(5, 6))));
  });

  it('groups a production bundle across rebuilds, by chunk', () => {
    const at = (chunk: string, col: number) => `    at e (/app/apps/web/.next/server/chunks/${chunk}:1:${col})`;
    const a = exceptionFingerprint(withStack('Error', at('apps_web_src_lib_server_0eyl_rv0-2y1j._.js', 100)));
    const b = exceptionFingerprint(withStack('Error', at('apps_web_src_lib_server_9zzz_q8w7e6r5._.js', 4000)));
    const other = exceptionFingerprint(withStack('Error', at('apps_web_src_lib_engine_0eyl_rv0-2y1j._.js', 100)));
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it('anchors on the repo layout, not a parent directory named src', () => {
    const f = (root: string) => exceptionFingerprint(withStack('Error', `    at save (${root}/apps/web/src/lib/a.ts:1:1)`));
    expect(f('/home/me/src/landflow')).toBe(f('/srv/app'));
    expect(exceptionFingerprint(withStack('Error', '    at async save (/srv/app/apps/web/src/lib/a.ts:1:1)'))).toBe(f('/x'));
  });

  it('handles non-errors', () => {
    expect(exceptionFingerprint('x')).toMatch(/^[0-9a-f]{12}$/);
  });
});

const root = resolve(__dirname, '../../..');

/** Every OTel instrument name the host and its services create, as source text. */
function instrumentNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) for (const m of readFileSync(path, 'utf8').matchAll(/create\w+\(\s*'([a-z_.]+)'/g)) names.add(m[1]);
    }
  };
  // The host's own instruments, and the engine's (executions and node runs).
  walk(join(root, 'apps/web/src'));
  walk(join(root, 'packages/engine/src'));
  return names;
}

/** `landflow.x.y` + unit + type -> the name the Prometheus exporter writes; checked by prefix so unit/type suffixes may vary. */
function known(prom: string, names: Set<string>) {
  const base = prom.replace(/_(bucket|sum|count|total)$/, '').replace(/_(seconds|milliseconds|bytes|ratio)$/, '');
  return [...names].some((n) => n.replace(/\./g, '_') === base);
}

describe('shipped alert rules and dashboard', () => {
  const rulesPath = join(root, 'deploy/observability/prometheus-rules.yml');
  const dashPath = join(root, 'deploy/observability/landflow-dashboard.json');
  const names = instrumentNames();

  /** Metric names in rule and panel expressions: label names (after `by (`, in `{k=...}`, in legends) are not metrics. */
  function metricsIn(text: string): string[] {
    const exprs = text
      .replace(/by \([^)]*\)/g, '')
      .replace(/"legendFormat":\s*"[^"]*"/g, '')
      .replace(/\{\{[^}]*\}\}/g, '');
    return [...new Set([...exprs.matchAll(/\b((?:landflow|http_server)_[a-z0-9_]+)\b(?!\s*=)/g)].map((m) => m[1]))].filter((m) => !m.startsWith('landflow_alert'));
  }

  it('the rules file parses, and each alert has a runbook and an expression', () => {
    const doc = parse(readFileSync(rulesPath, 'utf8')) as { groups: { rules: { alert: string; expr: string; annotations: Record<string, string> }[] }[] };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(12);
    for (const rule of rules) {
      expect(rule.expr, rule.alert).toBeTruthy();
      expect(rule.annotations.runbook, rule.alert).toMatch(/observability\.md#/);
    }
  });

  it('name only metrics the code defines', () => {
    const text = readFileSync(rulesPath, 'utf8') + readFileSync(dashPath, 'utf8');
    const metrics = metricsIn(text);
    expect(metrics.length).toBeGreaterThan(10);
    for (const metric of metrics) expect(known(metric, names), metric).toBe(true);
  });

  it('the dashboard is valid JSON with a uid and panels, and the component ships both files', () => {
    const dash = JSON.parse(readFileSync(dashPath, 'utf8'));
    expect(dash.uid).toBe('landflow-overview');
    expect(dash.panels.length).toBeGreaterThan(8);
    const component = join(root, 'deploy/k8s/components/observability');
    // Kustomize can't read outside the component, so it holds copies; they must not drift.
    for (const file of ['landflow-dashboard.json', 'prometheus-rules.yml']) {
      expect(existsSync(join(component, file)), file).toBe(true);
      expect(readFileSync(join(component, file), 'utf8'), file).toBe(readFileSync(join(root, 'deploy/observability', file), 'utf8'));
    }
    expect(readFileSync(join(component, 'kustomization.yaml'), 'utf8')).toMatch(/prometheus-rules\.yml/);
  });
});
