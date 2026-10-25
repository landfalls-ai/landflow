/**
 * Text Toolkit — an example Landflow plugin written with the TypeScript SDK.
 *
 *   pnpm --filter @landflow/plugin-text-toolkit start
 *
 * Serves HTTP on :7101 and gRPC on :7201, then announces both endpoints to the
 * Landflow host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { ChangeCase } from './nodes/change-case';
import { RegexExtract } from './nodes/regex-extract';
import { Slugify } from './nodes/slugify';
import { Template } from './nodes/template';

export const plugin = definePlugin({
  info: {
    id: 'text-toolkit',
    name: 'Text Toolkit',
    version: '0.1.0',
    description: 'Slugs, casing, templates and regex extraction',
    icon: 'file:text-toolkit.svg',
    color: '#2563eb',
    author: 'Landflow examples',
  },
  nodes: [new Slugify(), new ChangeCase(), new Template(), RegexExtract],
  // `file:` icons (plugin and nodes) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, { http: 7101, grpc: 7201 });
}
