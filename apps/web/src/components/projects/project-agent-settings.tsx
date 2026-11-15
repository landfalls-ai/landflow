'use client';
/**
 * A project's Settings tab → "Agents in this project" (docs/projects-and-goals.md#project-settings-for-agents): the model
 * agents use here when nothing names one, a knowledge base they can all search, which agents may run and which kinds of
 * tools they get. Each is off by default and only narrows.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useScrollToHash } from '@/lib/client/project-budget-api';
import {
  fetchAgentSettings,
  parseAgentSettings,
  sameAgentSettings,
  saveAgentSettings,
  type AgentSettingsForm,
  type AgentSettingsState,
} from '@/lib/client/project-agent-settings';
import { isNodeKnowledge, type AgentModel, type KnowledgeBaseToolConfig, type ModelProvider } from '@/lib/shared/agents';
import { PROJECT_KNOWLEDGE_TOOL, PROJECT_TOOL_KINDS, PROJECT_TOOL_KIND_LABELS, type ProjectToolKind } from '@/lib/shared/project-policy';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox, FieldLabel, Select, Switch } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';
import { ModelPicker } from '@/components/agents/model-card';
import { KnowledgeDialog } from '@/components/agents/knowledge-dialog';
import { PROVIDERS } from '@/components/agents/util';
import { useCredentials } from '@/components/credentials/use-credentials';

const knowledgeLabel = (tool: KnowledgeBaseToolConfig): string => (isNodeKnowledge(tool) ? `${tool.name} (${tool.nodeType})` : `${tool.name} (${tool.collection})`);

function ModelChoice({ model, onChange, disabled, error }: { model?: AgentModel; onChange: (m?: AgentModel) => void; disabled: boolean; error?: string }) {
  const { credentials } = useCredentials();
  const provider = PROVIDERS.find((p) => p.value === model?.provider);
  const options = provider?.credentialType ? (credentials ?? []).filter((c) => c.type === provider.credentialType) : [];
  if (disabled) {
    return <p className="text-[13px] text-t1">{model ? `${model.provider} · ${model.model || 'no model chosen'}` : 'None'}</p>;
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select aria-label="Provider" value={model?.provider ?? ''} onChange={(e) => onChange(e.target.value ? { provider: e.target.value as ModelProvider, model: '' } : undefined)}>
          <option value="">None</option>
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
        {model && provider?.credentialType && (
          <Select
            aria-label="Credential"
            value={model.credential?.id ?? ''}
            onChange={(e) => {
              const picked = options.find((c) => c.id === e.target.value);
              const { credential: _drop, ...rest } = model;
              onChange(picked ? { ...rest, credential: { id: picked.id, name: picked.name } } : rest);
            }}
          >
            <option value="">{provider.credentialRequired ? 'Choose a credential…' : 'The server’s key'}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {model && <ModelPicker model={model} onChange={(patch) => onChange({ ...model, ...patch })} />}
      {error && <p className="text-[12px] text-rd">{error}</p>}
    </div>
  );
}

/** The card without its data fetching, for the page and for tests. */
export function ProjectAgentSettingsView({
  state,
  form,
  onForm,
  onSave,
  saving,
  error,
  saved,
}: {
  state: AgentSettingsState;
  form: AgentSettingsForm;
  onForm?: (next: AgentSettingsForm) => void;
  onSave?: () => void;
  saving?: boolean;
  error?: string;
  saved: AgentSettingsForm;
}) {
  const [picking, setPicking] = useState(false);
  const edit = state.canEdit;
  const set = (patch: Partial<AgentSettingsForm>) => onForm?.({ ...form, ...patch });
  const dirty = !sameAgentSettings(form, saved);
  const modelError = Boolean(error && /credential|model|provider/i.test(error));
  const modelEmpty = Boolean(form.defaultModel && !form.defaultModel.model);
  const toggleAgent = (id: string, on: boolean) => set({ agents: { ...form.agents, ids: on ? [...form.agents.ids, id] : form.agents.ids.filter((x) => x !== id) } });
  const toggleKind = (kind: ProjectToolKind, on: boolean) => set({ agentTools: { ...form.agentTools, kinds: on ? [...form.agentTools.kinds, kind] : form.agentTools.kinds.filter((x) => x !== kind) } });
  const knowledge = form.knowledge;
  return (
    <div id="agents" className="scroll-mt-[72px] max-md:scroll-mt-[200px]">
      <Card className="space-y-5">
        <div className="text-[13px] font-semibold text-t1">Agents in this project</div>

        <div>
          <FieldLabel>Default model</FieldLabel>
          <p className="mb-2 text-[12px] text-t3">Used when neither the workflow’s step nor the agent names a model.</p>
          <ModelChoice model={form.defaultModel} onChange={(m) => set({ defaultModel: m })} disabled={!edit} error={modelError ? error : undefined} />
        </div>

        <div>
          <div className="flex items-start gap-2">
            <Switch checked={knowledge?.enabled ?? false} disabled={!edit || !knowledge} onChange={(on) => knowledge && set({ knowledge: { ...knowledge, enabled: on } })} label="Knowledge base" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-t1">Knowledge base</div>
              <p className="text-[12px] text-t3">Every agent that runs in this project can search it, as {PROJECT_KNOWLEDGE_TOOL}.</p>
              <p className="mt-1 text-[12.5px] text-t2">{knowledge ? knowledgeLabel(knowledge.tool) : 'None chosen'}</p>
              {edit && (
                <Button size="sm" variant="outline" className="mt-2 max-md:min-h-[44px]" onClick={() => setPicking(true)}>
                  {knowledge ? 'Change…' : 'Choose…'}
                </Button>
              )}
            </div>
          </div>
          {picking && (
            <KnowledgeDialog
              tool={knowledge?.tool}
              onClose={() => setPicking(false)}
              onSave={(tool) => {
                set({ knowledge: { enabled: true, tool: { ...tool, id: PROJECT_KNOWLEDGE_TOOL } } });
                setPicking(false);
              }}
            />
          )}
        </div>

        <div>
          <FieldLabel>Allowed agents</FieldLabel>
          <Segmented
            label="Allowed agents"
            value={form.agents.mode}
            onChange={(mode) => edit && set({ agents: { ...form.agents, mode } })}
            options={[
              { value: 'off', label: 'Everything available' },
              { value: 'allow', label: 'Only these' },
            ]}
          />
          {form.agents.mode === 'allow' &&
            (state.available.length === 0 ? (
              <p className="mt-2 text-[12px] text-t3">No agents to list</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {state.available.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-2">
                    <Checkbox checked={a.home || form.agents.ids.includes(a.id)} disabled={!edit || a.home} onChange={(on) => toggleAgent(a.id, on)} label={a.name} />
                    {a.home && <span className="text-[12px] text-t3">Always allowed (this project’s own)</span>}
                  </li>
                ))}
              </ul>
            ))}
        </div>

        <div>
          <FieldLabel>Allowed tools</FieldLabel>
          <Segmented
            label="Allowed tools"
            value={form.agentTools.mode}
            onChange={(mode) => edit && set({ agentTools: { ...form.agentTools, mode } })}
            options={[
              { value: 'off', label: 'Every kind' },
              { value: 'allow', label: 'Only these' },
            ]}
          />
          {form.agentTools.mode === 'allow' && (
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {PROJECT_TOOL_KINDS.map((k) => (
                <li key={k}>
                  <Checkbox checked={form.agentTools.kinds.includes(k)} disabled={!edit} onChange={(on) => toggleKind(k, on)} label={PROJECT_TOOL_KIND_LABELS[k]} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12px] text-t3">Skills, memory, a team’s own tools and the tools connected to a workflow’s step are always allowed.</p>
        </div>

        {error && !modelError && <p className="text-[12px] text-rd">{error}</p>}
        {!edit && <p className="text-[12px] text-t3">The project’s admins change these.</p>}
        {edit && dirty && (
          <div className="flex justify-end gap-2 border-t border-hair pt-3">
            <Button size="sm" variant="ghost" onClick={() => onForm?.(saved)}>
              Discard
            </Button>
            <Button size="sm" variant="primary" onClick={onSave} loading={saving} disabled={modelEmpty}>
              Save
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

export function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const [state, setState] = useState<AgentSettingsState>();
  const [form, setForm] = useState<AgentSettingsForm>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [failed, setFailed] = useState(false);
  const show = (view: Parameters<typeof parseAgentSettings>[0]) => {
    const next = parseAgentSettings(view);
    setState(next);
    setForm(next.form);
    setError(undefined);
  };
  useEffect(() => {
    fetchAgentSettings(projectId)
      .then(show)
      .catch(() => setFailed(true));
  }, [projectId]);
  useScrollToHash('agents', Boolean(state) || failed);
  if (failed) return null;
  if (!state || !form) return <div id="agents"><Card className="h-24 animate-pulse-soft">{null}</Card></div>;
  const save = async () => {
    setSaving(true);
    try {
      show(await saveAgentSettings(projectId, form, state.form, state.available));
      toast.success('Agent settings saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return <ProjectAgentSettingsView state={state} saved={state.form} form={form} onForm={setForm} onSave={() => void save()} saving={saving} error={error} />;
}
