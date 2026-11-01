import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Components are rendered to static HTML in a few tests (test/run-artifacts-view.test.ts): tsconfig keeps JSX for Next.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // The whole suite runs ~190 files in parallel: tests that clone git repositories (marketplace), wait on workers
    // (cluster-runtime, up to 15 s) or hash passwords in a hook (mcp-files-approvals) passed alone but timed out under
    // that load at vitest's 5 s / 10 s defaults.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Route handlers are called directly: guarded routes run as a synthetic owner unless a test turns that off.
    setupFiles: ['test/setup.ts'],
    // Importing the core plugin loads the store: keep its files out of the real data directory.
    env: { LANDFLOW_DATA_DIR: join(tmpdir(), `landflow-web-test-${process.pid}`), LANDFLOW_LOG_LEVEL: 'error' },
  },
});
