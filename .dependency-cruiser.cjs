/**
 * Layering rules for the monorepo (`pnpm check:deps`). They state what already holds by convention so that a change that
 * breaks it fails a command instead of waiting for a review:
 *
 *   - lib/server never imports a component, lib/shared never imports lib/server;
 *   - a client component (a file with 'use client') imports nothing from lib/server but types;
 *   - a route file never reaches into lib/server/db (routes go through the store and domain modules);
 *   - packages/ never import apps/;
 *   - no new circular dependency. The cycles that existed when this was added are recorded in
 *     .dependency-cruiser-known-violations.json and tolerated; the cycles inside lib/server/runner/ are structural (a run
 *     finishes into the queue, which starts runs) and allowed. See docs/development.md for refreshing the baseline.
 */
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, relative, sep } = require('node:path');

const WEB = 'apps/web/src';

/** Every source file under apps/web/src that starts with a 'use client' directive, as an anchored path regex. */
function clientFiles() {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*['"]use client['"]/.test(readFileSync(full, 'utf8').slice(0, 600))) {
        found.push('^' + relative(__dirname, full).split(sep).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
      }
    }
  };
  walk(join(__dirname, WEB));
  return found;
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'server-not-components',
      comment: 'lib/server is the backend: it must not depend on UI components.',
      severity: 'error',
      from: { path: `^${WEB}/lib/server/` },
      to: { path: `^${WEB}/components/` },
    },
    {
      name: 'shared-not-server',
      comment: 'lib/shared is imported by both sides (and by the browser): it must not depend on lib/server.',
      severity: 'error',
      from: { path: `^${WEB}/lib/shared/` },
      // A type import is erased at build time (shared/agents.ts names the guardrails' config types).
      to: { path: `^${WEB}/lib/server/`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'client-not-server-values',
      comment: "A 'use client' file ships to the browser: it may import types from lib/server (erased at build time), never values.",
      severity: 'error',
      from: { path: clientFiles() },
      to: { path: `^${WEB}/lib/server/`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'routes-not-db',
      comment: 'Route files go through the store and domain modules, never straight to lib/server/db.',
      severity: 'error',
      from: { path: `^${WEB}/app/.*/route\\.ts$` },
      to: { path: `^${WEB}/lib/server/db/` },
    },
    {
      name: 'packages-not-apps',
      comment: 'packages/ are libraries the apps use: they must not import from apps/.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      comment: 'No new circular dependencies (the known ones are in .dependency-cruiser-known-violations.json).',
      severity: 'error',
      // Type-only imports are erased at build time, so a cycle that needs one is not a load-time cycle and is not counted.
      // The runner's modules call each other at run time only (functions, never at load), so cycles among them are fine.
      from: { pathNot: `^${WEB}/lib/server/runner/` },
      to: { circular: true, pathNot: `^${WEB}/lib/server/runner/`, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['node_modules', '/dist/', '/\\.next/', '/\\.data/', '\\.d\\.ts$', '/generated/'] },
    // Read the TypeScript source, not its emit, so `import type` is told apart from a value import.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'apps/web/tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'], mainFields: ['module', 'main', 'types'] },
    skipAnalysisNotInRules: true,
    reporterOptions: { text: { highlightFocused: true } },
  },
};
