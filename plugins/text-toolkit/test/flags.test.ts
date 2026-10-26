/** The transport flags: pure nodes are idempotent, the MCP face lists the plugin's tools, and the concurrency default is set. */
import { describe, expect, it } from 'vitest';
import { mcpToolsFromManifest } from '@landflow/protocol';
import { createDispatcher } from '@landflow/sdk/dispatcher';
import { createMcpFace } from '@landflow/sdk/mcp';
import { DEFAULT_MAX_CONCURRENCY, plugin } from '../src/main';

describe('transport flags', () => {
  it('marks every node idempotent (all four are pure transforms) and keeps a sane concurrency default', () => {
    const { manifest } = createDispatcher(plugin);
    expect(manifest.nodes.map((n) => [n.name, n.idempotent])).toEqual([
      ['slugify', true],
      ['changeCase', true],
      ['template', true],
      ['regexExtract', true],
    ]);
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThan(0);
  });

  it('maps the idempotent flag to idempotentHint on every MCP tool', () => {
    const tools = mcpToolsFromManifest(createDispatcher(plugin).manifest);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
  });

  it('serves the same tools on the SDK MCP face and calls one', async () => {
    const dispatcher = createDispatcher(plugin);
    const expected = mcpToolsFromManifest(dispatcher.manifest).map((t) => t.name);
    const face = createMcpFace({ dispatcher, manifest: dispatcher.manifest, loopback: true });
    try {
      expect(face.tools.map((t) => t.name)).toEqual(expected);
      expect(expected).toContain('slugify');
      const response = await face.fetch(
        new Request('http://plugin/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'slugify' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'slugify',
              arguments: { field: 'text', outputField: 'slug', separator: '-', text: 'Héllo Wörld!' },
              _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} },
            },
          }),
        }),
      );
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).toContain('hello-world');
    } finally {
      await face.close();
    }
  });
});
