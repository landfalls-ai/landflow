import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every case starts real child processes (and a few wait for a limit to trip).
    testTimeout: 30_000,
  },
});
