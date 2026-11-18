'use client';
/**
 * Live re-check (wave ag4): "Pick it" on Spotlight's agent card lists the credentials that fit the agent's tool right there; one
 * pick writes it into the agent's DRAFT (the agent page's tool dialog is not needed), and every card and canvas redraws through
 * `announceSaved`. "Create one" opens the existing credential dialog. Names and types only: no secret reaches the page.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { changeAgentTool } from '@/lib/client/agent-edit';
import { readDraft } from '@/lib/client/agent-change';
import { CredentialDialog } from '../../credentials/credential-dialog';
import { qualifiedCredentialType, useCredentialStore, useCredentials } from '../../credentials/use-credentials';
import { useEditor } from '../store';
import { CredentialPickerView, type PickerOption } from './credential-picker';

type Tool = Record<string, unknown> & { id: string; name?: string; nodeType?: string; credentials?: Record<string, { id: string; name: string }> };

/** The first node tool of the draft with a required credential slot nothing is picked for, and that slot. */
export function toolNeedingCredential(draft: Record<string, unknown> | undefined, slotsOf: (nodeType: string) => string[]): { tool: Tool; slots: string[] } | undefined {
  for (const tool of (Array.isArray(draft?.tools) ? (draft!.tools as Tool[]) : [])) {
    if (tool.type !== 'node' || !tool.nodeType) continue;
    const slots = slotsOf(tool.nodeType);
    if (slots.length && slots.some((slot) => !tool.credentials?.[slot])) return { tool, slots };
  }
  return undefined;
}

export function AgentCredentialPicker({ agentId, onDone, startCreating = false }: { agentId: string; onDone?: () => void; startCreating?: boolean }) {
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const { credentials: all } = useCredentials();
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
  const need = toolNeedingCredential(draft, (type) => (nodeTypes[type]?.descriptor.credentials ?? []).filter((c) => c.required).map((c) => c.name));
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
      await changeAgentTool(agentId, { ...need.tool, credentials: { ...need.tool.credentials, [slot]: { id: option.id, name: option.name } } });
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
          onClose={() => setCreating(false)}
          onSaved={() => void useCredentialStore.getState().refresh()}
        />
      )}
    </>
  );
}
