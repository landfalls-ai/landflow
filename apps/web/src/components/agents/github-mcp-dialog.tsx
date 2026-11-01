'use client';
/**
 * Build tab → Capabilities → Add GitHub MCP: GitHub's MCP server, with a Bearer Auth credential holding a GitHub token, and
 * the choice of what the agent may do with it (docs/a2a.md, "GitHub's MCP tools for agents"). The tools are cut down on the
 * server to that choice; merging and writing code are never offered, so there is no switch for them.
 */
import { useState } from 'react';
import type { McpServerToolConfig } from '@/lib/shared/agents';
import { NodeCredentials } from '../credentials/node-credentials';
import { Button } from '../ui/button';
import { BrandGlyph } from '../ui/icon';
import { Input } from '../ui/inputs';
import { Dialog, Field } from './dialog';
import { MCP_CLIENT_TOOL } from './mcp-server-dialog';
import { newId } from './util';

const ACCESS = [
  { value: 'read', title: 'Read', text: 'Look at pull requests, diffs, files, issues, commits, searches and Actions runs.' },
  { value: 'review', title: 'Read and review', text: 'Also leave reviews, line comments, replies and comments on pull requests and issues. For a reviewer.' },
] as const;

export function GithubTile({ size = 32 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2" style={{ width: size, height: size }}>
      <BrandGlyph brand="github" size={Math.round(size * 0.55)} />
    </span>
  );
}

export const isGithubTool = (tool: { type: string }): boolean => tool.type === 'mcp' && (tool as McpServerToolConfig).preset === 'github';

export function GithubMcpDialog({ tool, onSave, onClose }: { tool?: McpServerToolConfig; onSave: (tool: McpServerToolConfig) => void; onClose: () => void }) {
  const [value, setValue] = useState<McpServerToolConfig>(
    () => tool ?? { id: newId('tool'), type: 'mcp', name: 'GitHub MCP', preset: 'github', access: 'read', parameters: { authentication: 'bearerAuth', serverTransport: 'httpStreamable' } },
  );
  const set = (patch: Partial<McpServerToolConfig>) => setValue((v) => ({ ...v, ...patch }));
  const valid = Boolean(value.credentials?.httpBearerAuth);

  return (
    <Dialog
      title={tool ? 'GitHub MCP' : 'Add GitHub MCP'}
      subtitle="GitHub’s own MCP server, with a token Landflow holds"
      icon={<GithubTile />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => onSave({ ...value, parameters: { ...value.parameters, authentication: 'bearerAuth' } })}>
            {tool ? 'Save' : 'Add GitHub MCP'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div role="radiogroup" aria-label="What the agent may do" className="space-y-2">
          {ACCESS.map((option) => {
            const on = (value.access ?? 'read') === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set({ access: option.value })}
                className={`block w-full rounded-[10px] border px-3 py-2.5 text-left ${on ? 'border-ac bg-acdim' : 'border-hair bg-wl'}`}
              >
                <div className="text-[13px] font-semibold text-t1">{option.title}</div>
                <div className="text-[12px] text-t3">{option.text}</div>
              </button>
            );
          })}
          <p className="text-[12px] text-t3">Merging, pushing code, creating branches and opening or editing pull requests are never offered to an agent: the flow does them.</p>
        </div>
        <NodeCredentials
          nodeType={MCP_CLIENT_TOOL}
          requirements={[{ name: 'httpBearerAuth', required: true }]}
          value={value.credentials}
          onChange={(credentials) => set({ credentials })}
        />
        <Field id="github-mcp-url" label="Server URL" hint="Leave empty for the bundled GitHub MCP server (landflow-github-mcp in the cluster, or LANDFLOW_GITHUB_MCP_URL)">
          <Input
            id="github-mcp-url"
            value={String(value.parameters.endpointUrl ?? '')}
            placeholder="http://landflow-github-mcp:8082/"
            onChange={(e) => set({ parameters: { ...value.parameters, endpointUrl: e.target.value } })}
          />
        </Field>
      </div>
    </Dialog>
  );
}
