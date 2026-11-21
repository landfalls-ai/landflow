'use client';
/**
 * A project's Settings tab → "Agents in this project" (docs/projects-and-goals.md#project-settings-for-agents): the model
 * agents use here when nothing names one, a knowledge base they can all search, which agents may run and which kinds of
 * tools they get. Each is off by default and only narrows.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useScrollToHash } from '@/lib/client/project-budget-api';
import { notionLink } from '@/lib/client/notion-brain'; // NB07:
import {
  fetchAgentSettings,
  parseAgentSettings,
  sameAgentSettings,
  errorFieldOf,
  saveAgentSettings,
  savePatch,
  type AgentSettingsErrorField,
  type AgentSettingsForm,
  type AgentSettingsState,
} from '@/lib/client/project-agent-settings';
import { isNodeKnowledge, type AgentModel, type ModelProvider } from '@/lib/shared/agents';
import { isNotionBrainKnowledge, PROJECT_KNOWLEDGE_TOOL, PROJECT_TOOL_KINDS, PROJECT_TOOL_KIND_LABELS, type ProjectSettings, type ProjectToolKind } from '@/lib/shared/project-policy';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox, FieldLabel, Select, Switch } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';
import { ModelPicker } from '@/components/agents/model-card';
import { KnowledgeDialog } from '@/components/agents/knowledge-dialog';
import { PROVIDERS } from '@/components/agents/util';
import { useCredentials } from '@/components/credentials/use-credentials';

const knowledgeLabel = (tool: NonNullable<ProjectSettings['knowledge']>['tool']): string =>
  isNotionBrainKnowledge(tool) ? 'Notion brain (the company’s Notion pages)' : isNodeKnowledge(tool) ? `${tool.name} (${tool.nodeType})` : `${tool.name} (${tool.collection})`;

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

/** An allow-list's mode: the two choices for an admin, plain text for everyone else. */
function ModeChoice({ label, edit, value, onChange, off }: { label: string; edit: boolean; value: 'off' | 'allow'; onChange: (mode: 'off' | 'allow') => void; off: string }) {
  if (!edit) return <p className="text-[13px] text-t1">{value === 'allow' ? 'Only these' : off}</p>;
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: 'off', label: off },
        { value: 'allow', label: 'Only these' },
      ]}
    />
  );
}

/**
 * C07: where this project's memory lives: the built-in stores, or a plugin that provides memory (and the credential it uses).
 * A provider serves the project's own facts only; teams' notebooks and agents' memories stay built in.
 */
function MemoryChoice({ form, state, edit, set, error }: { form: AgentSettingsForm; state: AgentSettingsState; edit: boolean; set: (patch: Partial<AgentSettingsForm>) => void; error?: string }) {
  const { credentials } = useCredentials();
  const memory = form.memory;
  const providers = state.memoryProviders ?? []; // an older caller's state has none
  const provider = memory?.backend === 'provider' ? providers.find((p) => p.type === memory.nodeType) : undefined;
  const label = memory?.backend === 'provider' ? (provider ? `${provider.displayName} (${provider.pluginName})` : `${memory.nodeType} (not installed)`) : 'Built-in';
  // The credentials the provider's node declares: those of its credential types.
  const options = provider ? (credentials ?? []).filter((c) => provider.credentialTypes.includes(c.type)) : [];
  return (
    <div>
      <FieldLabel>Memory</FieldLabel>
      <p className="mb-2 text-[12px] text-t3">Where this project’s remembered facts live. Built-in keeps them in Landflow’s brain; a provider is a plugin that stores them elsewhere. Teams’ notebooks and agents’ memories stay built in.</p>
      {!edit ? (
        <p className="text-[13px] text-t1">{label}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            aria-label="Memory backend"
            value={memory?.backend === 'provider' ? memory.nodeType : ''}
            onChange={(e) => set({ memory: e.target.value ? { backend: 'provider', nodeType: e.target.value } : undefined })}
          >
            <option value="">Built-in</option>
            {providers.map((p) => (
              <option key={p.type} value={p.type}>
                {p.displayName} ({p.pluginName})
              </option>
            ))}
            {memory?.backend === 'provider' && !provider && <option value={memory.nodeType}>{label}</option>}
          </Select>
          {memory?.backend === 'provider' && options.length > 0 && (
            <Select
              aria-label="Memory credential"
              value={memory.credentialId ?? ''}
              onChange={(e) => set({ memory: { backend: 'provider', nodeType: memory.nodeType, ...(e.target.value && { credentialId: e.target.value }) } })}
            >
              <option value="">Choose a credential…</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
      {providers.length === 0 && edit && <p className="mt-2 text-[12px] text-t3">No installed plugin provides memory yet.</p>}
      {error && <p className="mt-2 text-[12px] text-rd">{error}</p>}
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
  errorField,
  saved,
  notionActive = false, // NB07:
}: {
  state: AgentSettingsState;
  form: AgentSettingsForm;
  onForm?: (next: AgentSettingsForm) => void;
  onSave?: () => void;
  saving?: boolean;
  error?: string;
  /** The field the refused PATCH sent (errorFieldOf); without one the error shows at the bottom. */
  errorField?: AgentSettingsErrorField;
  saved: AgentSettingsForm;
  /** NB07: the project has an active Notion link, so its Notion brain is a choice for the knowledge base. */
  notionActive?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const edit = state.canEdit;
  const set = (patch: Partial<AgentSettingsForm>) => onForm?.({ ...form, ...patch });
  const dirty = !sameAgentSettings(form, saved);
  const errorUnder = (field: AgentSettingsErrorField) => (error && errorField === field ? <p className="mt-2 text-[12px] text-rd">{error}</p> : null);
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
          <ModelChoice model={form.defaultModel} onChange={(m) => set({ defaultModel: m })} disabled={!edit} error={errorField === 'defaultModel' ? error : undefined} />
        </div>

        <div>
          <div className="flex items-start gap-2">
            <Switch checked={knowledge?.enabled ?? false} disabled={!edit || !knowledge} onChange={(on) => knowledge && set({ knowledge: { ...knowledge, enabled: on } })} label="Knowledge base" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-t1">Knowledge base</div>
              <p className="text-[12px] text-t3">Every agent that runs in this project can search it, as {PROJECT_KNOWLEDGE_TOOL}.</p>
              <p className="mt-1 text-[12.5px] text-t2">{knowledge ? knowledgeLabel(knowledge.tool) : 'None chosen'}</p>
              {edit && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="max-md:min-h-[44px]" onClick={() => setPicking(true)}>
                    {knowledge ? 'Change…' : 'Choose…'}
                  </Button>
                  {/* NB07: the project's own Notion brain, offered while its link is active. */}
                  {notionActive && !(knowledge && isNotionBrainKnowledge(knowledge.tool)) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="max-md:min-h-[44px]"
                      onClick={() => set({ knowledge: { enabled: true, tool: { id: PROJECT_KNOWLEDGE_TOOL, type: 'knowledge', source: 'notion-brain', name: 'Notion brain', description: 'Search the company’s Notion pages for passages that help answer a question' } } })}
                    >
                      This project’s Notion brain
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
          {picking && (
            <KnowledgeDialog
              tool={knowledge && !isNotionBrainKnowledge(knowledge.tool) ? knowledge.tool : undefined}
              onClose={() => setPicking(false)}
              onSave={(tool) => {
                set({ knowledge: { enabled: true, tool: { ...tool, id: PROJECT_KNOWLEDGE_TOOL } } });
                setPicking(false);
              }}
            />
          )}
          {errorUnder('knowledge')}
        </div>

        <div>
          <FieldLabel>Allowed agents</FieldLabel>
          <ModeChoice label="Allowed agents" edit={edit} value={form.agents.mode} onChange={(mode) => set({ agents: { ...form.agents, mode } })} off="Everything available" />
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
          {errorUnder('agents')}
        </div>

        <div>
          <FieldLabel>Allowed tools</FieldLabel>
          <ModeChoice label="Allowed tools" edit={edit} value={form.agentTools.mode} onChange={(mode) => set({ agentTools: { ...form.agentTools, mode } })} off="Every kind" />
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

        <MemoryChoice form={form} state={state} edit={edit} set={set} error={errorField === 'memory' ? error : undefined} />

        {error && !errorField && <p className="text-[12px] text-rd">{error}</p>}
        {!edit && <p className="text-[12px] text-t3">The project’s admins change these.</p>}
        {edit && dirty && (
          <div className="flex items-center justify-end gap-2 border-t border-hair pt-3">
            {modelEmpty && <span className="mr-auto text-[12px] text-t3">Choose a model</span>}
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
  const [errorField, setErrorField] = useState<AgentSettingsErrorField>();
  const [failed, setFailed] = useState(false);
  const [notionActive, setNotionActive] = useState(false); // NB07:
  const show = (view: Parameters<typeof parseAgentSettings>[0]) => {
    const next = parseAgentSettings(view);
    setState(next);
    setForm(next.form);
    setError(undefined);
    setErrorField(undefined);
  };
  useEffect(() => {
    fetchAgentSettings(projectId)
      .then(show)
      .catch(() => setFailed(true));
  }, [projectId]);
  // NB07: the Notion brain is a knowledge choice only while the project's link is active.
  useEffect(() => {
    notionLink(projectId, true)
      .then((link) => setNotionActive(link.linked && link.status === 'active'))
      .catch(() => setNotionActive(false));
  }, [projectId]);
  useScrollToHash('agents', Boolean(state) || failed);
  if (failed) return null;
  if (!state || !form) return <div id="agents" className="scroll-mt-[72px] max-md:scroll-mt-[200px]"><Card className="h-24 animate-pulse-soft">{null}</Card></div>;
  const save = async () => {
    setSaving(true);
    try {
      show(await saveAgentSettings(projectId, form, state.form, state.available));
      toast.success('Agent settings saved');
    } catch (e) {
      setErrorField(errorFieldOf(savePatch(form, state.form, state.available)));
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return <ProjectAgentSettingsView state={state} saved={state.form} form={form} onForm={setForm} onSave={() => void save()} saving={saving} error={error} errorField={errorField} notionActive={notionActive} />;
}
