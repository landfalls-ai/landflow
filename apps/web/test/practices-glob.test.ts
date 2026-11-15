/** The glob rules of docs/practices.md#globs. The CLI's `landflow practices check` test copies this table unchanged. */
import { describe, expect, it } from 'vitest';
import { matchesPracticeGlob } from '@/lib/shared/practices';

const TABLE: Array<[string, string, boolean]> = [
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
  it.each(TABLE)('%s against %s is %s', (glob, path, matches) => {
    expect(matchesPracticeGlob(glob, path)).toBe(matches);
  });
});
