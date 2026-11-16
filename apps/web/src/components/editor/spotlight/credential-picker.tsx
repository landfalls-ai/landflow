'use client';
/**
 * SB12 (decision D2): the credentials a step could use, offered on Spotlight's reply for the person to pick. It lists the
 * caller's own credentials of the types the step accepts (names and types only: no data ever reaches the page), with
 * "Create one". Nothing is picked until the person picks, never on its own when exactly one fits (the node panel does
 * that; this does not). The pick is one undoable change of the step's `credentials`.
 */
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { isPhone } from '@/lib/client/use-phone';
import { Button } from '../../ui/button';
import { CredentialDialog } from '../../credentials/credential-dialog';
import { qualifiedCredentialType, useCredentialStore, useCredentials } from '../../credentials/use-credentials';
import { useCredentialScope } from '../../projects/use-projects';
import { useEditor } from '../store';

export interface PickerOption {
  id: string;
  name: string;
  /** The credential type, fully qualified. */
  type: string;
}

/** Set the step's credential in one undo step of the editor's store; the toast carries the Undo. */
export function setStepCredential(nodeId: string | undefined, name: string, slot: string, picked: { id: string; name: string }) {
  const state = useEditor.getState();
  const workflow = state.toWorkflow();
  const step = workflow.nodes.find((n) => n.id === nodeId) ?? workflow.nodes.find((n) => n.name === name);
  if (!step) return false;
  const undo = state.replaceGraph({ ...workflow, nodes: workflow.nodes.map((n) => (n.id === step.id ? { ...n, credentials: { ...n.credentials, [slot]: { id: picked.id, name: picked.name } } } : n)) });
  toast.success(`Using “${picked.name}” on “${step.name}”`, { action: { label: 'Undo', onClick: undo }, duration: isPhone() ? 5_000 : 15_000 });
  return true;
}

/** The list and its buttons: nothing is chosen until `chosen` says so. */
export function CredentialPickerView({
  options,
  chosen,
  onChoose,
  onUse,
  onCreate,
  hint,
  disabled,
  loading,
}: {
  options: PickerOption[];
  chosen: string;
  onChoose: (id: string) => void;
  onUse: () => void;
  onCreate: () => void;
  hint?: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  // A group of its own: rows of older replies keep their radios apart.
  const group = useId();
  return (
    <div className="space-y-1.5 pl-5" data-testid="credential-picker">
      {loading ? (
        <p className="text-[11.5px] text-t3">Looking for your credentials…</p>
      ) : options.length ? (
        <div role="radiogroup" aria-label="Credentials that fit" className="space-y-1">
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-hair bg-bg px-2 py-1.5 text-[12.5px] text-t1 max-md:min-h-11 has-[:checked]:border-ac has-[:checked]:bg-acbg">
              <input type="radio" name={group} value={o.id} checked={chosen === o.id} onChange={() => onChoose(o.id)} disabled={disabled} className="size-3.5 shrink-0 accent-[var(--ac)]" />
              <span className="min-w-0 truncate">{o.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-[11.5px] text-t3">None of your credentials fits this step yet.</p>
      )}
      {hint && <p className="text-[11.5px] text-t3">{hint}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" disabled={disabled || !chosen} onClick={onUse}>
          Use it
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onCreate}>
          Create one
        </Button>
      </div>
    </div>
  );
}

/**
 * The picker of a "Needs you" credential row. `credentialTypes` are the step's credential slots (the node type's
 * `credentials` names); a credential of the step's type qualified with each is offered.
 */
export function CredentialPicker({
  workflowId,
  nodeId,
  node,
  nodeType,
  credentialTypes,
  onPicked,
}: {
  workflowId: string;
  nodeId?: string;
  /** The step's name. */
  node: string;
  /** The step's node type, when the caller knows it; else read from the canvas. */
  nodeType?: string;
  credentialTypes: string[];
  onPicked: (picked: { id: string; name: string }) => void;
}) {
  const { credentials: all } = useCredentials();
  const { scope, reload } = useCredentialScope(workflowId);
  const [chosen, setChosen] = useState('');
  const [creating, setCreating] = useState(false);
  // Re-read when the canvas changes: the step may be added by the card applied after this row appeared.
  const onCanvas = useEditor((s) => s.nodes.map((n) => n.data.wf).find((n) => n.id === nodeId) ?? s.nodes.map((n) => n.data.wf).find((n) => n.name === node));
  const type = nodeType ?? onCanvas?.type;
  const slotOf = (credentialType: string) => (type ? credentialTypes.find((slot) => qualifiedCredentialType(type, slot) === credentialType) : undefined);
  const fitting = type ? new Set(credentialTypes.map((slot) => qualifiedCredentialType(type, slot))) : new Set<string>();
  const visible = all && scope ? all.filter((c) => scope.ids.has(c.id)) : all;
  const options: PickerOption[] = (visible ?? []).filter((c) => fitting.has(c.type)).map((c) => ({ id: c.id, name: c.name, type: c.type }));
  const first = type && credentialTypes[0] ? qualifiedCredentialType(type, credentialTypes[0]) : undefined;
  const missingStep = !onCanvas && !nodeType;

  const use = () => {
    const option = options.find((o) => o.id === chosen);
    const slot = option && slotOf(option.type);
    if (!option || !slot) return;
    if (setStepCredential(nodeId, node, slot, { id: option.id, name: option.name })) onPicked({ id: option.id, name: option.name });
  };

  return (
    <>
      <CredentialPickerView
        options={options}
        chosen={chosen}
        onChoose={setChosen}
        onUse={use}
        onCreate={() => setCreating(true)}
        loading={!all}
        disabled={missingStep}
        hint={missingStep ? `“${node}” is not on the canvas yet: apply the change, then pick.` : undefined}
      />
      {creating && first && (
        <CredentialDialog
          allowedTypes={[first]}
          {...(scope?.projectId && { projectId: scope.projectId })}
          onClose={() => setCreating(false)}
          onSaved={() => {
            // The new credential is listed, not picked: the person still chooses.
            void useCredentialStore.getState().refresh();
            void reload();
          }}
        />
      )}
    </>
  );
}
