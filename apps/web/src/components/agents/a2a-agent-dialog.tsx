'use client';
/**
 * Build tab → Capabilities → Add A2A agent: a remote agent (kagent, Google ADK, any A2A 1.0 server) the agent asks with an
 * `ask_…` tool. The settings are the A2A Agent node's (agent URL, auth credential, timeout, human in the loop).
 */
import { useState } from 'react';
import { RadioTower, TriangleAlert } from 'lucide-react';
import { defaultParameters, isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import type { A2aAgentToolConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { NodeCredentials } from '../credentials/node-credentials';
import { ParamForm } from '../editor/param-form';
import { Button } from '../ui/button';
import { Input, Textarea } from '../ui/inputs';
import { Dialog, Field, ToggleRow } from './dialog';
import { newId } from './util';

/** The node type whose parameters an A2A agent capability uses. */
export const A2A_AGENT = 'core.a2aAgent';
/** The node's parameters that describe the agent (the rest are the node's operations). */
const SERVER_PROPERTIES = new Set(['agentUrl', 'authentication', 'options']);

export function A2aTile({ size = 32 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair bg-sf" style={{ width: size, height: size, color: '#a855f7' }}>
      <RadioTower className="size-3.5" />
    </span>
  );
}

export function A2aAgentDialog({
  tool,
  info,
  onSave,
  onClose,
}: {
  tool?: A2aAgentToolConfig;
  info?: NodeTypeInfo;
  onSave: (tool: A2aAgentToolConfig) => void;
  onClose: () => void;
}) {
  const properties = (info?.descriptor.properties ?? []).filter((p) => SERVER_PROPERTIES.has(p.name));
  const [value, setValue] = useState<A2aAgentToolConfig>(() => {
    if (tool) return tool;
    const defaults = info ? defaultParameters(info.descriptor) : {};
    return { id: newId('tool'), type: 'a2a', name: 'remote agent', parameters: Object.fromEntries(Object.entries(defaults).filter(([key]) => SERVER_PROPERTIES.has(key))) };
  });
  const set = (patch: Partial<A2aAgentToolConfig>) => setValue((v) => ({ ...v, ...patch }));
  const requirements = (info?.descriptor.credentials ?? []).filter((c) => isPropertyVisible(c, withPropertyDefaults(info?.descriptor.properties ?? [], value.parameters)));
  const valid = Boolean(value.name.trim() && String(value.parameters.agentUrl ?? '').trim());

  return (
    <Dialog
      title={tool ? value.name || 'A2A agent' : 'Add an A2A agent'}
      subtitle="A remote agent the agent can ask: its tool calls show in the timeline, and its approvals wait for a person here"
      icon={<A2aTile />}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => onSave({ ...value, name: value.name.trim(), ...(value.useWhen !== undefined && { useWhen: value.useWhen.trim() }) })}>
            {tool ? 'Save agent' : 'Add agent'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!info && (
          <div className="flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> The A2A Agent node type isn’t loaded yet, so the agent settings can’t be shown.
          </div>
        )}
        <Field id="a2a-agent-name" label="Name" required hint="The tool is ask_<name>; the builder and session notices use it too">
          <Input id="a2a-agent-name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {requirements.length > 0 && <NodeCredentials nodeType={A2A_AGENT} requirements={requirements} value={value.credentials} onChange={(credentials) => set({ credentials })} />}
        {info && <ParamForm nodeType={A2A_AGENT} properties={properties} values={value.parameters} onChange={(parameters) => set({ parameters })} credentials={value.credentials} />}
        <Field id="a2a-agent-use-when" label="Use when" hint="When the model should ask it. Empty: the agent card’s description and skills">
          <Textarea id="a2a-agent-use-when" rows={2} value={value.useWhen ?? ''} onChange={(e) => set({ useWhen: e.target.value })} />
        </Field>
        <ToggleRow
          title="Require approval"
          description="Pause before every message to this agent until someone approves it (its own approvals pause the run either way)."
          checked={Boolean(value.requireApproval)}
          onChange={(requireApproval) => set({ requireApproval })}
        />
      </div>
    </Dialog>
  );
}
