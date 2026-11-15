/**
 * The glob table of docs/practices.md#globs and the three check kinds (docs/practices.md#machine-checks). The CLI's and the
 * Check Practices step's tests hold the same cases; apps/web/test/practices-glob.test.ts runs the same table through the
 * web selector's own `matchesPracticeGlob`.
 */
import { describe, expect, it } from 'vitest';
import { matchesPracticeGlob, practiceCheckLabel, runPracticeCheck, runPracticeChecks, type PracticeChange } from '../src/practice-checks';

export const GLOB_TABLE: Array<[glob: string, path: string, matches: boolean]> = [
  ['deploy/helm/*/Chart.yaml', 'deploy/helm/web/Chart.yaml', true],
  ['deploy/helm/*/Chart.yaml', 'deploy/helm/web/charts/Chart.yaml', false],
  ['deploy/helm/**', 'deploy/helm/web/templates/service.yaml', true],
  ['**/Chart.yaml', 'Chart.yaml', true],
  ['**/Chart.yaml', 'a/b/Chart.yaml', true],
  ['**/*.ts', 'src/otel.ts', true],
  ['*.md', 'CLAUDE.md', true],
  ['*.md', 'docs/README.md', false],
  ['docs/*.md', './docs/README.md', true],
  ['src/?.ts', 'src/a.ts', true],
  ['src/?.ts', 'src/ab.ts', false],
  ['a.b', 'aXb', false],
  ['deploy/k8s/**/otelcol-config.yaml', 'deploy/k8s/components/observability/otelcol-config.yaml', true],
  ['deploy/k8s/**/otelcol-config.yaml', 'deploy/k8s/otelcol-config.yaml', true],
  ['charts/[a]', 'charts/[a]', true],
];

describe('matchesPracticeGlob', () => {
  it.each(GLOB_TABLE)('%s against %s: %s', (glob, path, matches) => {
    expect(matchesPracticeGlob(glob, path)).toBe(matches);
  });
});

describe('the three check kinds', () => {
  const c: PracticeChange = {
    files: [
      { path: 'deploy/helm/api/Chart.yaml', status: 'A' },
      { path: 'src/otel.ts', status: 'M' },
      { path: 'old/Chart.yaml', status: 'D' },
    ],
    added: new Map([['src/otel.ts', ['import { trace } from "@opentelemetry/api";', 'export const t = 1;']]]),
  };

  it('pathExists: with `when`, only when something matched it', () => {
    expect(runPracticeCheck({ kind: 'pathExists', glob: 'deploy/helm/*/Chart.yaml' }, c).pass).toBe(true);
    expect(runPracticeCheck({ kind: 'pathExists', glob: 'docs/**' }, c).pass).toBe(false);
    expect(runPracticeCheck({ kind: 'pathExists', glob: 'docs/**', when: 'src/**' }, c).pass).toBe(false);
    expect(runPracticeCheck({ kind: 'pathExists', glob: 'docs/**', when: 'infra/**' }, c).pass).toBe(true);
    // A deleted file is not there.
    expect(runPracticeCheck({ kind: 'pathExists', glob: 'old/**' }, c).pass).toBe(false);
  });

  it('pathAbsent: no match, unless the exception matches; a deleted file is gone', () => {
    expect(runPracticeCheck({ kind: 'pathAbsent', glob: '**/Chart.yaml' }, c)).toMatchObject({ pass: false, files: ['deploy/helm/api/Chart.yaml'] });
    expect(runPracticeCheck({ kind: 'pathAbsent', glob: '**/Chart.yaml', unless: 'deploy/helm/*/Chart.yaml' }, c).pass).toBe(true);
    expect(runPracticeCheck({ kind: 'pathAbsent', glob: 'old/**' }, c).pass).toBe(true);
  });

  it('fileMatches: every matching file has the pattern in its added lines, or never with absent', () => {
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'src/**', pattern: '@opentelemetry/api' }, c).pass).toBe(true);
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'src/**', pattern: '^export const' }, c).pass).toBe(true);
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'src/**', pattern: 'console\\.log' }, c)).toMatchObject({ pass: false, files: ['src/otel.ts'] });
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'src/**', pattern: 'trace', absent: true }, c)).toMatchObject({ pass: false, files: ['src/otel.ts'] });
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'src/**', pattern: 'console\\.log', absent: true }, c).pass).toBe(true);
    // No file matches the glob: nothing to hold to the pattern.
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'lib/**', pattern: 'x' }, c).pass).toBe(true);
    // A pattern that is not a regular expression fails in words instead of throwing.
    expect(runPracticeCheck({ kind: 'fileMatches', glob: 'src/**', pattern: '(' }, c).pass).toBe(false);
  });

  it('runs a list and labels a check', () => {
    expect(runPracticeChecks([{ kind: 'pathExists', glob: 'src/**' }, { kind: 'pathAbsent', glob: 'old/**' }], c).map((r) => r.pass)).toEqual([true, true]);
    expect(practiceCheckLabel({ kind: 'pathAbsent', glob: 'a/**', unless: 'a/b' })).toBe('pathAbsent a/** (unless a/b)');
  });
});
