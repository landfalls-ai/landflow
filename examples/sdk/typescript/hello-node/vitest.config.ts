// Only needed while this example lives outside the pnpm workspace (see README): it points the package names at the
// workspace sources (the same mapping as the `paths` in tsconfig.json) and finds `vitest` in packages/sdk. A plugin
// under plugins/ resolves all of them through its own node_modules and needs no config at all.
import { fileURLToPath } from 'node:url';

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const vitest = repo('packages/sdk/node_modules/vitest/dist/index.js');

export default {
  resolve: {
    alias: [
      { find: /^vitest$/, replacement: vitest },
      { find: /^@landflow\/sdk\/(.*)$/, replacement: repo('packages/sdk/src/$1.ts') },
      { find: '@landflow/sdk', replacement: repo('packages/sdk/src/index.ts') },
      { find: '@landflow/protocol', replacement: repo('packages/protocol/src/index.ts') },
    ],
  },
};
