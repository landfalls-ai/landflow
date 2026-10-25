import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The tests run the CLI against the web app's real route handlers (test/host.ts), which import through `@/`.
  resolve: { alias: { '@': fileURLToPath(new URL('../../apps/web/src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { LANDFLOW_LOG_LEVEL: 'error', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' },
  },
});
