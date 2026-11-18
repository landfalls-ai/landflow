'use client';
/**
 * Live re-check (wave ag4): "Pick it" on Spotlight's agent card lists the credentials that fit the agent's tool right there; one
 * pick writes it into the agent's DRAFT (the agent page's tool dialog is not needed), and every card and canvas redraws through
 * `announceSaved`. "Create one" opens the existing credential dialog. Names and types only: no secret reaches the page.
 */
import { useCallback, useEffect, useState } from 'react';
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { changeAgentTool } from '@/lib/client/agent-edit';
import { readDraft } from '@/lib/client/agent-change';
import { CredentialDialog } from '../../credentials/credential-dialog';
import { qualifiedCredentialType, useCredentialStore } from '../../credentials/use-credentials';
import { useAssistant } from '../assistant';
import { useEditor } from '../store';
import type { AgentSmoke } from '@/lib/shared/agent-card';
import { CredentialPickerView, type PickerOption } from './credential-picker';

type Tool = Record<string, unknown> & { id: string; name?: string; nodeType?: string; parameters?: Record<string, unknown>; credentials?: Record<string, { id: string; name: string }> };

/** A node type's credential slot, as far as the picker needs it. */
export interface CredentialSlot {
  name: string;
  required?: boolean;
  displayOptions?: unknown;
}

/**
 * The first node tool of the draft with a required credential slot nothing is picked for, and the slots still open. A slot the
 * tool's own settings hide (a different auth method) is not asked for, and a filled slot is not offered again.
 */
export function toolNeedingCredential(draft: Record<string, unknown> | undefined, slotsOf: (tool: Tool) => CredentialSlot[]): { tool: Tool; slots: string[] } | undefined {
  for (const tool of (Array.isArray(draft?.tools) ? (draft!.tools as Tool[]) : [])) {
    if (tool.type !== 'node' || !tool.nodeType) continue;
    const open = slotsOf(tool).filter((c) => c.required && !tool.credentials?.[c.name]).map((c) => c.name);
    if (open.length) return { tool, slots: open };
  }
  return undefined;
}

/** The smoke test's answer after a pick: the agent's rows and the cards that are applied (created) say it, so "needs a credential" goes; a change card still waiting for Apply says nothing of it. */
export function showSmoke(agentId: string, smoke: AgentSmoke) {
  useAssistant.setState((s) => ({ agents: s.agents.map((a) => (a.agentId === agentId ? { ...a, smoke } : a)) }));
  for (const item of useAssistant.getState().items) {
    useAssistant.getState().updateParts(item.id, (parts) => parts.map((p) => (p.kind === 'agentCard' && p.card.state === 'created' && (p.card.agentId === agentId || p.card.base?.agentId === agentId) ? { ...p, card: { ...p.card, smoke } } : p)));
  }
}

export function AgentCredentialPicker({ agentId, onDone, startCreating = false }: { agentId: string; onDone?: () => void; startCreating?: boolean }) {
  const nodeTypes = useEditor((s) => s.nodeTypes);
  // The credentials the agent's own project may use (not every one the person sees), and that project for "Create one".
  const [scope, setScope] = useState<{ credentials: Array<{ id: string; name: string; type: string }>; projectId?: string }>();
  const [failed, setFailed] = useState(false);
  const loadScope = useCallback(() => api<{ credentials: Array<{ id: string; name: string; type: string }>; projectId?: string }>(`/api/credentials?agentId=${encodeURIComponent(agentId)}`).then(
      (r) => {
        setFailed(false);
        setScope(r);
      },
      () => setFailed(true),
    ), [agentId]);
  useEffect(() => {
    void loadScope();
  }, [loadScope]);
  const all = scope?.credentials;
  const [draft, setDraft] = useState<Record<string, unknown>>();
  const [chosen, setChosen] = useState('');
  const [creating, setCreating] = useState(startCreating);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void readDraft(agentId).then((d) => live && setDraft(d));
    return () => {
      live = false;
    };
  }, [agentId]);
  const need = toolNeedingCredential(draft, (tool) => {
    const descriptor = nodeTypes[tool.nodeType ?? '']?.descriptor;
    const parameters = withPropertyDefaults(descriptor?.properties ?? [], (tool.parameters ?? {}) as never);
    return (descriptor?.credentials ?? []).filter((c) => isPropertyVisible(c as never, parameters)) as CredentialSlot[];
  });
  if (failed)
    return (
      <p className="text-[11.5px] text-warn" role="status">
        Couldn’t check which credentials this agent’s project may use, so none is offered.{' '}
        <button type="button" className="underline" onClick={() => void loadScope()}>
          Retry
        </button>
      </p>
    );
  if (!draft) return <p className="text-[11.5px] text-t3">Looking for your credentials…</p>;
  if (!need) return <p className="text-[11.5px] text-t3">Nothing in this agent needs a credential now.</p>;
  const type = need.tool.nodeType!;
  const fitting = new Map(need.slots.map((slot) => [qualifiedCredentialType(type, slot), slot]));
  const options: PickerOption[] = (all ?? []).filter((c) => fitting.has(c.type)).map((c) => ({ id: c.id, name: c.name, type: c.type }));
  const use = async () => {
    const option = options.find((o) => o.id === chosen);
    const slot = option && fitting.get(option.type);
    if (!option || !slot) return;
    setBusy(true);
    try {
      const { smoke } = await changeAgentTool(agentId, { ...need.tool, credentials: { ...need.tool.credentials, [slot]: { id: option.id, name: option.name } } });
      showSmoke(agentId, smoke);
      toast.success(`Using “${option.name}” for ${need.tool.name ?? 'the tool'}`);
      onDone?.();
    } catch (e) {
      toast.error(`Couldn’t save the pick: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <CredentialPickerView options={options} chosen={chosen} onChoose={setChosen} onUse={() => void use()} onCreate={() => setCreating(true)} loading={!all} disabled={busy} />
      {creating && (
        <CredentialDialog
          allowedTypes={[...fitting.keys()]}
          projectId={scope?.projectId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            void useCredentialStore.getState().refresh();
            void loadScope();
          }}
        />
      )}
    </>
  );
}
