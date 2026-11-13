/** Writes docs/reference/configuration.md from the configuration catalog: `pnpm --filter @landflow/web gen:config-docs`. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderConfigDocs } from '../src/lib/server/config/render-docs';

const target = fileURLToPath(new URL('../../../docs/reference/configuration.md', import.meta.url));
writeFileSync(target, renderConfigDocs());
console.log(`wrote ${target}`);
