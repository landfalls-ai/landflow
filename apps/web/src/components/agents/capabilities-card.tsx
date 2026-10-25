'use client';
/** Build tab → Capabilities: node tools, workflow tools and sub-agents, plus memory. */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Brain,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Workflow,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { defaultParameters } from '@landflow/protocol';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { languageMeta } from '@/lib/client/format';
import { nodeColor, tint } from '@/lib/client/node-style';
import type { AgentConfig, AgentToolConfig, NodeToolConfig, SubAgentConfig, WorkflowToolConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { NodeCredentials } from '../credentials/node-credentials';
import { ParamForm } from '../editor/param-form';
import { PluginIcon } from '../editor/node-creator';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { AppIcon, NodeIcon } from '../ui/icon';
import { Input, Textarea } from '../ui/inputs';
import { Dialog, Field, ItemRow, Section, ToggleRow } from './dialog';
import { useAgentList, useNodeTypes } from './use-agent-data';
import { newId, type UpdateConfig } from './util';

interface WorkflowOption {
  id: string;
  name: string;
  description?: string;
  eligible: boolean;
  reason?: string;
}

/** Action nodes that can run on their own (no required AI sub-node ports). */
const usable = (t: NodeTypeInfo) => t.descriptor.kind === 'action' && t.descriptor.inputs.every((p) => p.type === 'main' || !p.required);

function NodeTile({ info, size = 32 }: { info?: NodeTypeInfo; size?: number }) {
  const color = nodeColor(info);
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair" style={{ width: size, height: size, background: tint(color, 12) }}>
      <NodeIcon icon={info?.descriptor.icon ?? 'wrench'} size={Math.round(size * 0.45)} style={{ color }} />
    </span>
  );
}

function KindTile({ icon, size = 32 }: { icon: React.ReactNode; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2" style={{ width: size, height: size }}>
      {icon}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Node tools
// ---------------------------------------------------------------------------

function NodePicker({ onPick, onClose }: { onPick: (info: NodeTypeInfo) => void; onClose: () => void }) {
  const nodeTypes = useNodeTypes();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const actions = useMemo(() => Object.values(nodeTypes ?? {}).filter(usable), [nodeTypes]);
  const segments = useMemo(() => {
    const map = new Map<
      string,
      {
        pluginId: string;
        name: string;
        icon?: string;
        color: string;
        count: number;
      }
    >();
    for (const t of actions) {
      const segment = map.get(t.pluginId) ?? {
        pluginId: t.pluginId,
        name: t.pluginId === 'core' ? 'Core' : t.pluginName,
        icon: t.pluginId === 'core' ? 'lucide:box' : t.pluginIcon,
        color: t.pluginColor ?? languageMeta(t.language).color,
        count: 0,
      };
      segment.count++;
      map.set(t.pluginId, segment);
    }
    return [...map.values()].sort((a, b) => (a.pluginId === 'core' ? -1 : b.pluginId === 'core' ? 1 : a.name.localeCompare(b.name)));
  }, [actions]);

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = actions
    .filter((t) => tab === 'all' || t.pluginId === tab)
    .filter((t) => {
      const text = `${t.descriptor.displayName} ${t.pluginName} ${t.descriptor.description} ${(t.descriptor.keywords ?? []).join(' ')} ${t.type}`.toLowerCase();
      return tokens.every((token) => text.includes(token));
    })
    .sort((a, b) => a.descriptor.displayName.localeCompare(b.descriptor.displayName));

  return (
    <Dialog
      title="Add tool"
      subtitle="Any action node, from any plugin, can be a tool the agent calls."
      icon={<KindTile icon={<Wrench className="size-4" />} />}
      onClose={onClose}
      width={680}
      bodyClassName="p-0 flex flex-col"
    >
      <div className="shrink-0 space-y-2.5 border-b border-hair px-5 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
          <Input autoFocus aria-label="Search nodes" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search nodes…" className="pl-8" />
        </div>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5" role="tablist" aria-label="Plugins">
          {[{ pluginId: 'all', name: 'All', count: actions.length } as const, ...segments].map((segment) => (
            <button
              key={segment.pluginId}
              role="tab"
              aria-selected={tab === segment.pluginId}
              onClick={() => setTab(segment.pluginId)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                tab === segment.pluginId ? 'border-ac2 bg-ac2 text-on-ac' : 'border-hair text-t2 hover:border-ac hover:text-ac',
              )}
            >
              {'color' in segment && <PluginIcon segment={segment} size={14} />}
              {segment.name}
              <span className={cn('font-mono text-[10px]', tab === segment.pluginId ? 'text-on-ac' : 'text-t3')}>{segment.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-[260px] flex-1 overflow-y-auto px-3 py-2">
        {!nodeTypes && (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-t3">
            <Loader2 className="size-4 animate-spin" /> Loading nodes…
          </div>
        )}
        {nodeTypes && !shown.length && <EmptyState compact title="No node matches" hint={query ? 'Try another search.' : 'Start a plugin to add its nodes.'} />}
        {shown.map((info) => (
          <button
            key={info.type}
            onClick={() => onPick(info)}
            disabled={!info.available}
            title={info.available ? undefined : 'The plugin is offline'}
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-acdim disabled:opacity-50"
          >
            <NodeTile info={info} size={34} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-t1">{info.descriptor.displayName}</span>
              <span className="block truncate text-[12px] text-t3">{info.descriptor.description}</span>
            </span>
            <span className="hidden shrink-0 text-[11px] text-t3 sm:inline">{info.pluginId === 'core' ? 'Core' : info.pluginName}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function NodeToolDialog({
  tool,
  info,
  onSave,
  onClose,
  onBack,
}: {
  tool: NodeToolConfig;
  info?: NodeTypeInfo;
  onSave: (tool: NodeToolConfig) => void;
  onClose: () => void;
  onBack?: () => void;
}) {
  const [value, setValue] = useState(tool);
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters');
  const set = (patch: Partial<NodeToolConfig>) => setValue((v) => ({ ...v, ...patch }));
  const requirements = info?.descriptor.credentials ?? [];
  const valid = value.name.trim() && value.description.trim();
  const modelFields = Object.values(value.parameters).filter((v) => typeof v === 'string' && v.includes('$fromAI(')).length;

  return (
    <Dialog
      title={value.name || info?.descriptor.displayName || 'Tool'}
      subtitle={info ? `${info.descriptor.displayName} · ${info.pluginId === 'core' ? 'Core' : info.pluginName}` : value.nodeType}
      icon={<NodeTile info={info} />}
      onClose={onClose}
      width={640}
      bodyClassName="p-0 flex flex-col"
      footer={
        <>
          {onBack && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>
              <ArrowLeft className="size-3.5" /> Back
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!valid}
            onClick={() =>
              onSave({
                ...value,
                name: value.name.trim(),
                description: value.description.trim(),
              })
            }
          >
            {onBack ? 'Add tool' : 'Save tool'}
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 gap-4 border-b border-hair px-5" role="tablist">
        {(['parameters', 'settings'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 py-2.5 text-[13px] capitalize transition-colors',
              tab === key ? 'border-ac font-semibold text-t1' : 'border-transparent text-t2 hover:text-t1',
            )}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'parameters' ? (
          <div className="space-y-4">
            {!info && (
              <div className="flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> The plugin that publishes {value.nodeType} is not running, so its parameters can’t be
                shown. The tool keeps its saved settings.
              </div>
            )}
            <Field id="tool-name" label="Tool name" required hint="What the model calls the tool. Letters, digits and underscores work everywhere.">
              <Input id="tool-name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field id="tool-description" label="Description for the model" required hint="When and why to use the tool. The model decides from this text.">
              <Textarea id="tool-description" rows={3} value={value.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            {info && requirements.length > 0 && (
              <NodeCredentials
                nodeType={value.nodeType}
                requirements={requirements}
                value={value.credentials}
                onChange={(credentials) => set({ credentials })}
              />
            )}
            {info && (
              <div>
                <div className="mb-2.5 flex items-start gap-2 rounded-[10px] border border-acbd bg-acdim px-3 py-2 text-[12px] text-t2">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-ac" />
                  <span>
                    Click the sparkle on a field to let the model fill it in. Other fields are fixed.
                    {modelFields > 0 && (
                      <span className="text-ac">
                        {' '}
                        {modelFields} {modelFields === 1 ? 'field is' : 'fields are'} defined by the model.
                      </span>
                    )}
                  </span>
                </div>
                <ParamForm
                  nodeType={value.nodeType}
                  properties={info.descriptor.properties}
                  values={value.parameters}
                  onChange={(parameters) => set({ parameters })}
                  credentials={value.credentials}
                  fromAI
                />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ToggleRow
              title="Require approval"
              description="Pause before every call until someone approves it in the test chat or the session."
              checked={Boolean(value.requireApproval)}
              onChange={(requireApproval) => set({ requireApproval })}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Workflow tools
// ---------------------------------------------------------------------------

async function createAndOpen(kind: 'workflow' | 'agent') {
  try {
    if (kind === 'workflow') {
      const { workflow } = await api<{ workflow: { id: string } }>('/api/workflows', {
        method: 'POST',
        json: { name: 'Untitled workflow', nodes: [], connections: [] },
      });
      window.open(`/workflows/${workflow.id}`, '_blank', 'noopener');
    } else {
      const { agent } = await api<{ agent: { id: string } }>('/api/agents', {
        method: 'POST',
        json: {},
      });
      window.open(`/agents/${agent.id}`, '_blank', 'noopener');
    }
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function WorkflowToolDialog({ tool, onSave, onClose }: { tool?: WorkflowToolConfig; onSave: (tool: WorkflowToolConfig) => void; onClose: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowOption[]>();
  const [error, setError] = useState<string>();
  const [value, setValue] = useState<WorkflowToolConfig | undefined>(tool);
  const load = () => {
    setError(undefined);
    api<{ workflows: WorkflowOption[] }>('/api/agents/workflow-tools')
      .then((r) => setWorkflows(r.workflows))
      .catch((e: Error) => {
        setWorkflows([]);
        setError(e.message);
      });
  };
  useEffect(() => {
    if (!tool) load();
  }, [tool]);
  const set = (patch: Partial<WorkflowToolConfig>) => setValue((v) => (v ? { ...v, ...patch } : v));

  if (value) {
    return (
      <Dialog
        title={value.name || 'Workflow tool'}
        subtitle="A workflow the agent runs like a tool"
        icon={<KindTile icon={<Workflow className="size-4" />} />}
        onClose={onClose}
        footer={
          <>
            {!tool && (
              <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setValue(undefined)}>
                <ArrowLeft className="size-3.5" /> Back
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!value.name.trim() || !value.description.trim()}
              onClick={() =>
                onSave({
                  ...value,
                  name: value.name.trim(),
                  description: value.description.trim(),
                })
              }
            >
              {tool ? 'Save tool' : 'Add workflow'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field id="wf-tool-name" label="Tool name" required>
            <Input id="wf-tool-name" value={value.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field id="wf-tool-description" label="Description for the model" required hint="What the workflow does and what to pass it.">
            <Textarea id="wf-tool-description" rows={3} value={value.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <ToggleRow
            title="Require approval"
            description="Pause before each run until someone approves it."
            checked={Boolean(value.requireApproval)}
            onChange={(requireApproval) => set({ requireApproval })}
          />
          <a
            href={`/workflows/${value.workflowId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] text-ac hover:underline"
          >
            <ExternalLink className="size-3" /> Open the workflow
          </a>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Add workflow"
      subtitle="Workflows that start with “When Called by an Agent” can be tools."
      icon={<KindTile icon={<Workflow className="size-4" />} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" className="mr-auto" onClick={load} aria-label="Reload workflows">
            <RefreshCw className="size-3.5" /> Reload
          </Button>
          <Button variant="outline" size="sm" onClick={() => void createAndOpen('workflow')}>
            <Plus className="size-3.5" /> Create workflow
          </Button>
        </>
      }
    >
      {error && <div className="mb-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">{error}</div>}
      {!workflows && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-t3">
          <Loader2 className="size-4 animate-spin" /> Loading workflows…
        </div>
      )}
      {workflows && !workflows.length && !error && (
        <EmptyState compact title="No workflows yet" hint="Create one that starts with “When Called by an Agent”." />
      )}
      <div className="space-y-1">
        {workflows?.map((wf) => (
          <button
            key={wf.id}
            disabled={!wf.eligible}
            title={wf.eligible ? undefined : wf.reason}
            onClick={() =>
              setValue({
                id: newId('tool'),
                type: 'workflow',
                workflowId: wf.id,
                name: wf.name,
                description: wf.description ?? '',
              })
            }
            className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-acdim disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
          >
            <KindTile icon={<Workflow className="size-3.5" />} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-t1">{wf.name}</span>
              <span className="block truncate text-[12px] text-t3">{wf.eligible ? wf.description || 'No description' : wf.reason}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

function SubAgentDialog({
  tool,
  selfId,
  taken,
  onSave,
  onClose,
}: {
  tool?: SubAgentConfig;
  selfId: string;
  taken: string[];
  onSave: (tool: SubAgentConfig) => void;
  onClose: () => void;
}) {
  const agents = useAgentList();
  const [value, setValue] = useState<SubAgentConfig | undefined>(tool);
  const others = (agents ?? []).filter((a) => a.id !== selfId);
  const picked = agents?.find((a) => a.id === value?.agentId);

  if (value) {
    return (
      <Dialog
        title={picked?.name ?? 'Sub-agent'}
        subtitle="An agent this agent can hand a task to"
        icon={<AppIcon icon={picked?.icon ?? 'bot'} color={picked?.color} size={32} />}
        onClose={onClose}
        footer={
          <>
            {!tool && (
              <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setValue(undefined)}>
                <ArrowLeft className="size-3.5" /> Back
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                onSave({
                  ...value,
                  ...(value.useWhen?.trim() ? { useWhen: value.useWhen.trim() } : { useWhen: undefined }),
                })
              }
            >
              {tool ? 'Save' : 'Add sub-agent'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {picked && !picked.publishedVersion && (
            <div className="flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {picked.name} isn’t published yet. Delegation uses the published version.
            </div>
          )}
          <Field
            id="sub-agent-when"
            label="When to delegate"
            hint={`Leave empty to use ${picked?.name ?? 'the agent'}’s description${picked?.description ? `: “${picked.description}”` : ''}.`}
          >
            <Textarea
              id="sub-agent-when"
              rows={3}
              value={value.useWhen ?? ''}
              onChange={(e) => setValue({ ...value, useWhen: e.target.value })}
              placeholder="Use for questions about invoices and refunds."
            />
          </Field>
          <ToggleRow
            title="Require approval"
            description="Pause before each delegation until someone approves it."
            checked={Boolean(value.requireApproval)}
            onChange={(requireApproval) => setValue({ ...value, requireApproval })}
          />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Add sub-agent"
      subtitle="Let this agent delegate tasks to another agent."
      icon={<KindTile icon={<Bot className="size-4" />} />}
      onClose={onClose}
      footer={
        <Button variant="outline" size="sm" onClick={() => void createAndOpen('agent')}>
          <Plus className="size-3.5" /> Create agent
        </Button>
      }
    >
      {!agents && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-t3">
          <Loader2 className="size-4 animate-spin" /> Loading agents…
        </div>
      )}
      {agents && !others.length && <EmptyState compact title="No other agents yet" hint="Create a specialist agent, then come back to add it here." />}
      <div className="space-y-1">
        {others.map((agent) => {
          const added = taken.includes(agent.id);
          return (
            <button
              key={agent.id}
              disabled={added}
              title={added ? 'Already added' : undefined}
              onClick={() =>
                setValue({
                  id: newId('tool'),
                  type: 'agent',
                  agentId: agent.id,
                })
              }
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-acdim disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
            >
              <AppIcon icon={agent.icon} color={agent.color} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-t1">{agent.name}</span>
                <span className="block truncate text-[12px] text-t3">{agent.description || 'No description'}</span>
              </span>
              {added ? (
                <Badge tone="muted">Added</Badge>
              ) : agent.publishedVersion ? (
                <Badge tone="success">v{agent.publishedVersion}</Badge>
              ) : (
                <Badge tone="muted">Draft</Badge>
              )}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

type DialogState =
  | { kind: 'pick-node' }
  | { kind: 'node'; tool: NodeToolConfig; isNew?: boolean }
  | { kind: 'workflow'; tool?: WorkflowToolConfig }
  | { kind: 'agent'; tool?: SubAgentConfig };

export function CapabilitiesCard({ agentId, config, update }: { agentId: string; config: AgentConfig; update: UpdateConfig }) {
  const nodeTypes = useNodeTypes();
  const agents = useAgentList();
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const save = (tool: AgentToolConfig) => {
    const exists = config.tools.some((t) => t.id === tool.id);
    update((c) => ({
      ...c,
      tools: c.tools.some((t) => t.id === tool.id) ? c.tools.map((t) => (t.id === tool.id ? tool : t)) : [...c.tools, tool],
    }));
    setDialog(null);
    if (!exists) toast.success(`Added ${tool.type === 'agent' ? (agents?.find((a) => a.id === tool.agentId)?.name ?? 'sub-agent') : `“${tool.name}”`}`);
  };

  const edit = (tool: AgentToolConfig) =>
    setDialog(tool.type === 'node' ? { kind: 'node', tool } : tool.type === 'workflow' ? { kind: 'workflow', tool } : { kind: 'agent', tool });

  const pickNode = (info: NodeTypeInfo) =>
    setDialog({
      kind: 'node',
      isNew: true,
      tool: {
        id: newId('tool'),
        type: 'node',
        name: info.descriptor.displayName,
        description: info.descriptor.toolDescription ?? info.descriptor.description,
        nodeType: info.type,
        parameters: defaultParameters(info.descriptor),
      },
    });

  const row = (tool: AgentToolConfig) => {
    let icon: React.ReactNode;
    let title: string;
    let subtitle: string;
    if (tool.type === 'node') {
      const info = nodeTypes?.[tool.nodeType];
      icon = <NodeTile info={info} />;
      title = tool.name;
      subtitle = info ? `${info.descriptor.displayName} · ${info.pluginId === 'core' ? 'Core' : info.pluginName}` : `${tool.nodeType} · plugin offline`;
    } else if (tool.type === 'workflow') {
      icon = <KindTile icon={<Workflow className="size-3.5" />} />;
      title = tool.name;
      subtitle = `Workflow · ${tool.description || 'No description'}`;
    } else {
      const agent = agents?.find((a) => a.id === tool.agentId);
      icon = <AppIcon icon={agent?.icon ?? 'bot'} color={agent?.color} size={32} />;
      title = agent?.name ?? 'Deleted agent';
      subtitle = `Sub-agent · ${tool.useWhen || agent?.description || 'No description'}`;
    }
    return (
      <ItemRow
        key={tool.id}
        icon={icon}
        title={title}
        subtitle={subtitle}
        onClick={() => edit(tool)}
        badges={
          tool.requireApproval ? (
            <Badge tone="warning" title="Pauses for approval before each call">
              <ShieldCheck className="size-3" /> Requires approval
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <Button size="icon-sm" variant="ghost" aria-label={`Edit ${title}`} title="Edit" onClick={() => edit(tool)}>
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${title}`}
              title="Remove"
              className="hover:bg-rddim hover:text-rd"
              onClick={() =>
                update((c) => ({
                  ...c,
                  tools: c.tools.filter((t) => t.id !== tool.id),
                }))
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        }
      />
    );
  };

  return (
    <>
      <Section
        icon={<Wrench className="size-4" />}
        title="Capabilities"
        description="What the agent can do: nodes as tools, workflows and other agents."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'pick-node' })}>
              <Plus className="size-3.5" /> Add tool
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'workflow' })}>
              <Workflow className="size-3.5" /> Add workflow
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'agent' })}>
              <Bot className="size-3.5" /> Add sub-agent
            </Button>
          </>
        }
      >
        {config.tools.length ? (
          <div className="space-y-1.5">{config.tools.map(row)}</div>
        ) : (
          <EmptyState compact title="No tools yet" hint="Without tools the agent can only talk. Add a node, a workflow or another agent." />
        )}
      </Section>

      <Section icon={<Brain className="size-4" />} title="Memory" description="What the agent remembers between messages and sessions.">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
            <div>
              <div className="text-[13px] font-semibold text-t1">Session memory</div>
              <div className="text-[12px] text-t3">The agent sees the whole conversation of a session.</div>
            </div>
            <Badge tone="success">Always on</Badge>
          </div>
          <ToggleRow
            title="Cross-session memory"
            description="Lets the agent save notes about each user and recall them in later sessions."
            checked={config.memory.crossSession}
            onChange={(crossSession) => update((c) => ({ ...c, memory: { ...c.memory, crossSession } }))}
          />
        </div>
      </Section>

      {dialog?.kind === 'pick-node' && <NodePicker onPick={pickNode} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'node' && (
        <NodeToolDialog
          key={dialog.tool.id}
          tool={dialog.tool}
          info={nodeTypes?.[dialog.tool.nodeType]}
          onSave={save}
          onClose={() => setDialog(null)}
          onBack={dialog.isNew ? () => setDialog({ kind: 'pick-node' }) : undefined}
        />
      )}
      {dialog?.kind === 'workflow' && <WorkflowToolDialog tool={dialog.tool} onSave={save} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'agent' && (
        <SubAgentDialog
          tool={dialog.tool}
          selfId={agentId}
          taken={config.tools.flatMap((t) => (t.type === 'agent' && t.id !== dialog.tool?.id ? [t.agentId] : []))}
          onSave={save}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
