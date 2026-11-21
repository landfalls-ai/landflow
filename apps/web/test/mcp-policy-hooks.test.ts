/** C14 (P14): the MCP policy hook. T-1 first: the engine seam (`readOnlyHint` on tools, `report` on the active node). */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'lf-mcp-policy-'));
process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
process.env.LANDFLOW_SCAN_ON_START = 'false';
process.env.LANDFLOW_PLUGINS = '';

const { agentToolsFrom, resourceAndPromptTools } = await import('../src/lib/server/mcp/client');
const { runInNode, activeNode } = await import('../src/lib/server/ai-usage/node-context');

const endpoint = { url: 'http://mcp.local/mcp' } as never;

describe('the engine seam (T-1)', () => {
  it('copies the MCP read-only hint onto the agent tool', () => {
    const tools = agentToolsFrom(endpoint, [
      { name: 'list_x', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
      { name: 'make_x', inputSchema: { type: 'object' } },
      { name: 'zap_x', annotations: { readOnlyHint: false }, inputSchema: { type: 'object' } },
    ] as never);
    expect(tools.map((t) => t.readOnlyHint)).toEqual([true, undefined, undefined]);
  });

  it('marks the resource and prompt tools read-only', () => {
    const tools = resourceAndPromptTools(endpoint, ['resources', 'prompts']);
    expect(tools).toHaveLength(4);
    expect(tools.every((t) => t.readOnlyHint === true)).toBe(true);
  });

  it('keeps the engine report on the active node', async () => {
    const seen: unknown[] = [];
    const report = (record: unknown) => void seen.push(record);
    await runInNode({ id: 'n', name: 'N', type: 't', report: report as never }, async () => {
      activeNode()?.report?.({ type: 'check', name: 'policy', status: 'pass' });
    });
    expect(seen).toEqual([{ type: 'check', name: 'policy', status: 'pass' }]);
  });
});
