/**
 * C27: the one canonical form content is hashed in (docs/agents.md#changed-mcp-tools-are-held). Keys are sorted at every depth and
 * nothing is padded, so the same tool listed with its keys in another order, or the server's tools listed in another order, hashes
 * the same; any change of a description, a schema or an annotation does not.
 */
import { createHash } from 'node:crypto';
import type { ToolContent } from '../../shared/trust';

export type { ToolContent } from '../../shared/trust';

/** JSON with sorted keys and no whitespace; `undefined` members are dropped as JSON.stringify drops them. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, member]) => member !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, member]) => [key, sorted(member)]),
      );
    }
    return v;
  };
  return JSON.stringify(sorted(value)) ?? 'null';
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The part of a tool that is fingerprinted (D7): name, description, input schema, annotations, and the title the model falls back to. */
const contentOf = (tool: ToolContent): ToolContent => ({
  name: tool.name,
  ...(tool.title !== undefined && { title: tool.title }),
  ...(tool.description !== undefined && { description: tool.description }),
  ...(tool.inputSchema !== undefined && { inputSchema: tool.inputSchema }),
  ...(tool.annotations !== undefined && { annotations: tool.annotations }),
});

/** SHA-256 of one tool's canonical JSON. */
export function toolFingerprint(tool: ToolContent): string {
  return sha256(canonicalJson(contentOf(tool)));
}

/** SHA-256 of the sorted `name:fingerprint` lines of a tool list: the same set of tools hashes the same in any order. */
export function toolsHash(tools: ToolContent[]): string {
  return sha256(
    tools
      .map((tool) => `${tool.name}:${toolFingerprint(tool)}`)
      .sort()
      .join('\n'),
  );
}

/** What a snapshot keeps of a tool: its content (for the review sheet's old side) and its fingerprint. */
export function snapshotOf(tools: ToolContent[]): { tools: Array<ToolContent & { fp: string }> } {
  return { tools: tools.map((tool) => ({ ...contentOf(tool), fp: toolFingerprint(tool) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}
