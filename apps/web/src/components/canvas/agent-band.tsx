'use client';
/**
 * AG12: what the agent a Run an Agent node runs is connected to, read-only, inside the node under its name (docs/features/editor.md,
 * "What an agent is connected to"): its model, memory, tools and knowledge bases, in three columns straight above the node's own
 * Chat Model, Memory and Tool slots, so each reads as what that slot already has. It is not a wired sub-node (no handle, no edge):
 * a wired Chat Model or Memory shows the agent's own struck through and "replaced by" it, wired tools add ("+ 1 wired"). A click on
 * a row opens the agent's page where that ability is set. The data is `GET /api/agents/:id/connections`, read once per agent and
 * project and again when the agent changes (this tab's events, and another tab's through lib/client/agent-change.ts). The cache is
 * here, not in components/agents/faces.ts: only the canvas asks.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { Lock } from 'lucide-react';
import { api, ApiError } from '@/lib/client/api';
import { AGENT_CHANGED, AGENT_SAVED } from '@/lib/client/agent-change';
import type { ActorConnection } from '@/lib/shared/run-trace';
import { cn } from '@/lib/utils';
import { useConnectionIcon } from '../run-trace/connections';
import { NodeIcon } from '../ui/icon';

// The band must stay short: sub-nodes are placed 200 canvas px below a node, so the tile, the slot labels and the '+' buttons have to end above that.
const MAX_TOOL_ROWS = 2;

export interface AgentConnectionsAnswer {
  agent: { id: string; name: string; published: boolean; draftDiffers: boolean; icon?: string; color?: string };
  connections: ActorConnection[];
}

/** What the editor's canvas wires to the node itself (read from the editor's store, so wiring shows before a save). */
export interface WiredSubnodes {
  model?: string;
  memory?: string;
  tools?: number;
}

const cache = new Map<string, Promise<AgentConnectionsAnswer | null>>();
const keyOf = (agentId: string, workflowId?: string, nodeId?: string) => `${agentId}|${workflowId ?? ''}|${nodeId ?? ''}`;

function load(agentId: string, workflowId?: string, nodeId?: string): Promise<AgentConnectionsAnswer | null> {
  const key = keyOf(agentId, workflowId, nodeId);
  if (!cache.has(key)) {
    const url = (query: string) => `/api/agents/${encodeURIComponent(agentId)}/connections${query}`;
    const scoped = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}${nodeId ? `&nodeId=${encodeURIComponent(nodeId)}` : ''}` : '';
    const read = api<AgentConnectionsAnswer>(url(scoped), { background: true }).catch((error) =>
      // A workflow not saved yet is 404: the agent as it is, without the project's settings.
      scoped && error instanceof ApiError && error.status === 404 ? api<AgentConnectionsAnswer>(url(''), { background: true }) : Promise.reject(error),
    );
    // A failed read is not kept: the next mount or change asks again.
    cache.set(
      key,
      read.catch(() => {
        setTimeout(() => cache.delete(key), 0);
        return null;
      }),
    );
  }
  return cache.get(key)!;
}

/** Forget what was read for an agent (it changed), so the next read asks again. */
export const forgetAgentConnections = (agentId?: string) => {
  for (const key of [...cache.keys()]) if (!agentId || key.startsWith(`${agentId}|`)) cache.delete(key);
};

/** The connections of an agent, once per agent and project, and again when the agent changes (undefined until read, or when the caller cannot read it). */
export function useAgentConnections(agentId: string | undefined, workflowId?: string, nodeId?: string): AgentConnectionsAnswer | undefined {
  const [answer, setAnswer] = useState<AgentConnectionsAnswer | null>();
  useEffect(() => {
    if (!agentId) return setAnswer(undefined);
    let live = true;
    const read = () => void load(agentId, workflowId, nodeId).then((a) => live && setAnswer(a));
    read();
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ agentId?: string }>).detail?.agentId !== agentId) return;
      forgetAgentConnections(agentId);
      read();
    };
    window.addEventListener(AGENT_CHANGED, onChange);
    window.addEventListener(AGENT_SAVED, onChange);
    return () => {
      live = false;
      window.removeEventListener(AGENT_CHANGED, onChange);
      window.removeEventListener(AGENT_SAVED, onChange);
    };
  }, [agentId, workflowId, nodeId]);
  return answer ?? undefined;
}

/** The agent's page at an ability, in a new tab (`tab=abilities&open=<row>`, and `tool=<id>` for a tool's own row). */
export const agentLink = (agentId: string, open: 'model' | 'memory' | 'capabilities', toolId?: string) =>
  `/agents/${encodeURIComponent(agentId)}?tab=abilities&open=${open}${toolId ? `&tool=${encodeURIComponent(toolId)}` : ''}`;

/** What the three columns say, apart from how they are drawn. */
export interface BandView {
  model: { name?: string; replacedBy?: string; project?: boolean; title: string; connection?: ActorConnection };
  memory: { text: string; replacedBy?: string };
  tools: ActorConnection[];
  wiredTools: number;
}

export function bandView(connections: ActorConnection[], wired: WiredSubnodes = {}): BandView {
  const model = connections.find((c) => c.kind === 'model');
  const memory = connections.find((c) => c.kind === 'memory');
  return {
    model: {
      ...(model && { name: model.name, connection: model }),
      ...(wired.model && { replacedBy: wired.model }),
      ...(model?.from === 'project' && { project: true }),
      title: [model?.name, model?.detail, model?.from === 'project' ? 'the project’s default model' : undefined, wired.model ? `replaced by ${wired.model} in this flow` : undefined].filter(Boolean).join(' · ') || 'No model',
    },
    memory: { text: memory ? 'Remembers across sessions' : 'This conversation', ...(wired.memory && { replacedBy: wired.memory }) },
    // Wired tools are drawn below as sub-nodes; they add, so the column says how many.
    // The ones that ask first lead: with two rows shown, they are what a person most wants to see on the node.
    tools: connections.filter((c) => (c.kind === 'tool' || c.kind === 'knowledge' || c.kind === 'agent') && c.from !== 'flow').sort((a, b) => Number(Boolean(b.asksFirst)) - Number(Boolean(a.asksFirst))),
    wiredTools: wired.tools ?? 0,
  };
}

const stop = (e: MouseEvent | React.PointerEvent) => e.stopPropagation();

function Row({ label, title, href, children, className }: { label: string; title: string; href: string; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        window.open(href, '_blank', 'noopener');
      }}
      onPointerDown={stop}
      onDoubleClick={stop}
      className={cn('nodrag nopan flex w-full min-w-0 items-start gap-1 rounded px-0.5 py-px text-left leading-[13px] hover:bg-sf2 hover:text-t1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ac', className)}
    >
      {children}
    </button>
  );
}

/** The band, once `useAgentConnections` has the data (the node passes it only then, so an unreadable agent leaves the node as it was). */
export function AgentBand({ agentId, data, wired, lead }: { agentId: string; data: AgentConnectionsAnswer; wired?: WiredSubnodes; lead?: boolean }) {
  const iconOf = useConnectionIcon();
  const { agent } = data;
  const view = bandView(data.connections, wired);
  const who = lead ? `${agent.name} (lead)` : agent.name;
  const shown = view.tools.slice(0, MAX_TOOL_ROWS);
  const more = view.tools.slice(MAX_TOOL_ROWS);
  const mark = !agent.published ? 'Not published' : agent.draftDiffers ? 'Draft has changes' : undefined;
  const markTitle = !agent.published ? `${agent.name} was never published: this is its draft, and the node says “Publish ${agent.name} first” when it runs.` : `The node runs the published version shown here; ${agent.name}’s draft has changes.`;
  const modelIcon = view.model.connection && iconOf(view.model.connection);
  const slot = lead ? (s: string) => `Lead’s ${s}` : (s: string) => s;
  return (
    <div
      data-agent-band={agentId}
      className="nodrag nopan mx-3 mb-3 rounded-lg border border-dashed border-hair bg-wl px-1.5 pb-1.5 pt-1 text-[10.5px] text-t2"
      aria-label={`What ${who} is connected to`}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5 text-[9.5px] uppercase tracking-wide text-t3">
        <span className="truncate">{lead ? `${agent.name} · connected to` : 'Connected to'}</span>
        {mark && (
          <button
            type="button"
            title={markTitle}
            aria-label={`${agent.name}: ${mark}`}
            onClick={(e) => {
              e.stopPropagation();
              window.open(`/agents/${encodeURIComponent(agentId)}`, '_blank', 'noopener');
            }}
            onPointerDown={stop}
            onDoubleClick={stop}
            className="nodrag nopan shrink-0 rounded-full bg-viz-1/20 px-1.5 text-[9.5px] font-semibold normal-case tracking-normal text-t1"
          >
            {mark}
          </button>
        )}
      </div>
      {/* Straight above the handles: the slots sit at 25%, 50% and 75% of the tile, each column holds its own. */}
      <div className="grid" style={{ gridTemplateColumns: '33% 30% 37%' }}>
        <div className="min-w-0 pr-1">
          <Row label={`${who}: ${slot('model')} ${view.model.name ?? 'none'}`} title={view.model.title} href={agentLink(agentId, 'model')}>
            {modelIcon && <NodeIcon icon={modelIcon} size={12} className={cn('mt-px shrink-0', view.model.replacedBy && 'opacity-50')} />}
            <span className="min-w-0">
              {view.model.project ? <span className="block truncate">project default</span> : null}
              <span className={cn('block break-words', view.model.replacedBy ? 'truncate line-through opacity-70' : 'line-clamp-2', view.model.project && 'text-t3', !view.model.name && !view.model.replacedBy && 'text-t3')}>{view.model.name ?? (view.model.replacedBy ? '' : 'no model')}</span>
              {view.model.replacedBy && <span className="block line-clamp-2 break-words text-t3">replaced by {view.model.replacedBy}</span>}
            </span>
          </Row>
        </div>
        <div className="min-w-0 pr-1">
          <Row label={`${who}: ${slot('memory')} ${view.memory.replacedBy ? `replaced by ${view.memory.replacedBy}` : view.memory.text}`} title={view.memory.replacedBy ? `${view.memory.text} (replaced by ${view.memory.replacedBy} in this flow)` : view.memory.text} href={agentLink(agentId, 'memory')}>
            <span className="min-w-0">
              <span className={cn('break-words', view.memory.replacedBy ? 'block truncate line-through opacity-70' : 'line-clamp-2')}>{view.memory.text}</span>
              {view.memory.replacedBy && <span className="block line-clamp-2 break-words text-t3">replaced by {view.memory.replacedBy}</span>}
            </span>
          </Row>
        </div>
        <div className="min-w-0">
          {shown.map((c) => {
            const knowledge = c.kind === 'knowledge';
            const title = [c.name, c.detail, c.asksFirst ? 'asks first' : undefined, c.credential ? `uses ${c.credential}` : undefined, c.documents !== undefined ? `${c.documents} document${c.documents === 1 ? '' : 's'}` : undefined, c.withheld ? `withheld: ${c.withheld}` : undefined].filter(Boolean).join(' · ');
            return (
              <Row key={`${c.kind}:${c.toolId ?? c.name}`} label={`${who}: ${c.kind === 'knowledge' ? 'knowledge base' : 'tool'} ${c.name}${c.asksFirst ? ', asks first' : ''}${c.withheld ? `, withheld: ${c.withheld}` : ''}`} title={title} href={agentLink(agentId, 'capabilities', c.toolId)} className={cn(c.withheld && 'opacity-50')}>
                <NodeIcon icon={iconOf(c)} size={12} className="mt-px shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate">{c.name}</span>
                    {knowledge && c.documents !== undefined && <span className="shrink-0 text-[9.5px] text-t3">{c.documents} {c.documents === 1 ? 'doc' : 'docs'}</span>}
                    {c.asksFirst && <Lock className="size-2.5 shrink-0 text-t3" aria-hidden />}
                  </span>
                </span>
              </Row>
            );
          })}
          {more.length > 0 ? (
            <Row label={`${who}: ${more.length} more`} title={view.tools.map((c) => `${c.name}${c.asksFirst ? ' (asks first)' : ''}`).join(', ')} href={agentLink(agentId, 'capabilities')} className="text-t3">
              +{more.length} more{view.wiredTools > 0 ? ` · + ${view.wiredTools} wired` : ''}
            </Row>
          ) : (
            view.wiredTools > 0 && <div className="px-0.5 text-t3">+ {view.wiredTools} wired</div>
          )}
          {view.tools.length === 0 && view.wiredTools === 0 && (
            <Row label={`${who}: no tools`} title="No tools or knowledge bases" href={agentLink(agentId, 'capabilities')} className="text-t3">
              no tools
            </Row>
          )}
        </div>
      </div>
    </div>
  );
}

/** AG12: a step card's type line on a phone: "Run an Agent · claude-sonnet-5-5 · 4 tools · 1 knowledge base" (the band's data, as one line). */
export function stepLine(typeName: string, connections: ActorConnection[] | undefined, wired: WiredSubnodes = {}): string {
  if (!connections) return typeName;
  const view = bandView(connections, wired);
  const knowledge = view.tools.filter((c) => c.kind === 'knowledge').length;
  const tools = view.tools.length - knowledge + view.wiredTools;
  const model = view.model.replacedBy ?? view.model.name;
  return [typeName, model, tools ? `${tools} tool${tools === 1 ? '' : 's'}` : undefined, knowledge ? `${knowledge} knowledge base${knowledge === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ');
}
