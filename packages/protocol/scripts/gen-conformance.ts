// Regenerates conformance/fixtures/mcp-tools.json from conformance/manifests/*.json with the shared MCP tool mapping.
// Run after changing src/mcp-tools.ts or a manifest: `pnpm --filter @landflow/protocol gen:conformance`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFORMANCE_KIT, conformanceDir, loadConformanceManifests } from '../conformance/index';
import { mcpToolsFromManifest } from '../src/mcp-tools';

const manifests = loadConformanceManifests();
const fixture = {
  kit: CONFORMANCE_KIT,
  suite: 'mcp-tools',
  description: 'For each manifest, exactly the MCP tools mcpToolsFromManifest() must produce (names, schemas, annotations, bindings).',
  cases: Object.entries(manifests).map(([id, manifest]) => ({
    id,
    description: `${manifest.plugin.name} (${manifest.plugin.id}): ${manifest.nodes.length} node(s)`,
    manifest,
    tools: mcpToolsFromManifest(manifest),
  })),
};
const out = join(conformanceDir, 'fixtures', 'mcp-tools.json');
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${out}: ${fixture.cases.map((c) => `${c.id} (${c.tools.length} tools)`).join(', ')}`);
