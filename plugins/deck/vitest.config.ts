import { defineConfig } from 'vitest/config';

// The suite runs against a fake `dot-agent-deck` script (test/fake-deck.mjs); no deck, no network beyond localhost.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
