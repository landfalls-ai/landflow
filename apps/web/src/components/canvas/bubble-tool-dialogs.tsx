'use client';
/**
 * AG16: a bubble's Change for a tool or knowledge base opens the agent page's own dialog for that kind of tool
 * (components/agents/capabilities-card.tsx, knowledge-dialog.tsx), loaded only when used (the canvas does not carry them). Save puts
 * the tool back into the agent's DRAFT (never the flow; live after Publish), after the used-by confirm when several workflows run it.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { readDraft } from '@/lib/client/agent-change';
import { changeAgentTool } from '@/lib/client/agent-edit';
import type { AgentToolConfig, KnowledgeBaseToolConfig, NodeToolConfig, SubAgentConfig, WorkflowToolConfig } from '@/lib/shared/agents';
import { NodeToolDialog, SubAgentDialog, WorkflowToolDialog } from '../agents/capabilities-card';
import { KnowledgeDialog } from '../agents/knowledge-dialog';
import { useNodeTypes } from '../agents/use-agent-data';
import { ConfirmChange, toastEdit } from './bubble-confirm';

export default function BubbleToolDialogs({ agentId, agentName, toolId, words, onDone }: { agentId: string; agentName: string; toolId?: string; words?: string; onDone: () => void }) {
  const nodeTypes = useNodeTypes();
  const [tools, setTools] = useState<AgentToolConfig[]>();
  const [saving, setSaving] = useState<AgentToolConfig>();
  useEffect(() => {
    let live = true;
    void readDraft(agentId).then((draft) => live && setTools(Array.isArray(draft?.tools) ? (draft.tools as AgentToolConfig[]) : []));
    return () => {
      live = false;
    };
  }, [agentId]);
  const tool = tools?.find((t) => t.id === toolId);
  const apply = async (next: AgentToolConfig) => {
    onDone();
    try {
      const { smoke } = await changeAgentTool(agentId, next as unknown as Record<string, unknown> & { id: string });
      toastEdit(agentName, 'Changed a tool of', smoke);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const save = (next: AgentToolConfig) => (words ? setSaving(next) : void apply(next));
  if (saving && words) return <ConfirmChange words={words} onCancel={onDone} onConfirm={() => void apply(saving)} />;
  if (!tools || !tool) return null;
  if (tool.type === 'node') return <NodeToolDialog agentId={agentId} tool={tool as NodeToolConfig} info={nodeTypes?.[tool.nodeType]} onSave={save} onClose={onDone} />;
  if (tool.type === 'knowledge') return <KnowledgeDialog agentId={agentId} tool={tool as KnowledgeBaseToolConfig} onSave={save} onClose={onDone} />;
  if (tool.type === 'workflow') return <WorkflowToolDialog tool={tool as WorkflowToolConfig} onSave={save} onClose={onDone} />;
  if (tool.type === 'agent') return <SubAgentDialog tool={tool as SubAgentConfig} selfId={agentId} taken={tools.filter((t) => t.id !== tool.id && t.type === 'agent').map((t) => (t as SubAgentConfig).agentId)} onSave={save} onClose={onDone} />;
  // An MCP server or an A2A agent is set on the agent's page.
  return <OnThePage agentId={agentId} toolId={tool.id} onDone={onDone} />;
}

function OnThePage({ agentId, toolId, onDone }: { agentId: string; toolId: string; onDone: () => void }) {
  // A ref, so React StrictMode's second mount does not open a second tab.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    window.open(`/agents/${encodeURIComponent(agentId)}?tab=abilities&open=capabilities&tool=${encodeURIComponent(toolId)}`, '_blank', 'noopener');
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
