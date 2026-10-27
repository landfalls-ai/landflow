'use client';
/**
 * Build tab → Capabilities → Add MCP server: a server whose tools the agent can call. The settings
 * are the MCP Client Tool node's (endpoint, transport, auth credential, tools to include), so the
 * tool picker loads the server's tools the same way.
 */
import { useState } from 'react';
import { Plug, TriangleAlert } from 'lucide-react';
import { defaultParameters, isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import type { McpServerToolConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { NodeCredentials } from '../credentials/node-credentials';
import { ParamForm } from '../editor/param-form';
import { Button } from '../ui/button';
import { Input } from '../ui/inputs';
import { Dialog, Field, ToggleRow } from './dialog';
import { newId } from './util';

/** The node type whose parameters an MCP server capability uses. */
export const MCP_CLIENT_TOOL = 'core.mcpClientTool';

export function McpTile({ size = 32 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2" style={{ width: size, height: size }}>
      <Plug className="size-3.5" />
    </span>
  );
}

export function McpServerDialog({
  tool,
  info,
  onSave,
  onClose,
}: {
  tool?: McpServerToolConfig;
  info?: NodeTypeInfo;
  onSave: (tool: McpServerToolConfig) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<McpServerToolConfig>(
    () => tool ?? { id: newId('tool'), type: 'mcp', name: 'MCP server', parameters: info ? defaultParameters(info.descriptor) : {} },
  );
  const set = (patch: Partial<McpServerToolConfig>) => setValue((v) => ({ ...v, ...patch }));
  const properties = (info?.descriptor.properties ?? []).filter((p) => p.type !== 'notice');
  const requirements = (info?.descriptor.credentials ?? []).filter((c) => isPropertyVisible(c, withPropertyDefaults(info?.descriptor.properties ?? [], value.parameters)));
  const valid = Boolean(value.name.trim() && String(value.parameters.endpointUrl ?? '').trim());

  return (
    <Dialog
      title={tool ? value.name || 'MCP server' : 'Add an MCP server'}
      subtitle="Each tool the server lists becomes a tool of the agent, with its own schema"
      icon={<McpTile />}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => onSave({ ...value, name: value.name.trim() })}>
            {tool ? 'Save server' : 'Add server'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!info && (
          <div className="flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> The MCP Client Tool node type isn’t loaded yet, so the server settings can’t be shown.
          </div>
        )}
        <Field id="mcp-server-name" label="Name" required hint="How the builder and the session notices refer to this server">
          <Input id="mcp-server-name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {requirements.length > 0 && (
          <NodeCredentials nodeType={MCP_CLIENT_TOOL} requirements={requirements} value={value.credentials} onChange={(credentials) => set({ credentials })} />
        )}
        {info && (
          <ParamForm nodeType={MCP_CLIENT_TOOL} properties={properties} values={value.parameters} onChange={(parameters) => set({ parameters })} credentials={value.credentials} />
        )}
        <ToggleRow
          title="Require approval"
          description="Pause before every call to one of this server’s tools until someone approves it."
          checked={Boolean(value.requireApproval)}
          onChange={(requireApproval) => set({ requireApproval })}
        />
      </div>
    </Dialog>
  );
}
