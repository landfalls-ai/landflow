'use client';
/**
 * The node panel's credential pickers: one per credential type the node declares (a searchable combobox that can create a
 * credential from the text typed), with create and edit inline. With
 * `workflowId`, only the credentials that workflow's project may use are offered (lib/shared/projects.ts), and new
 * ones are created in that project.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Plus, TriangleAlert } from 'lucide-react';
import type { NodeCredentialRequirement } from '@landflow/protocol';
import type { CredentialRefs } from '../editor/param-form';
import { Button } from '../ui/button';
import { useCredentialScope } from '../projects/use-projects';
import { useAgentScope } from './agent-scope';
import { CredentialCombobox } from './credential-combobox';
import { CredentialDialog, CredentialTypeIcon } from './credential-dialog';
import { autoPickStep, credentialInputs, qualifiedCredentialType, useCredentials } from './use-credentials';

export function NodeCredentials({
  nodeType,
  requirements,
  value,
  onChange,
  workflowId,
  readOnly,
  publishPending,
}: {
  nodeType: string;
  /** The workflow the node is in: limits the choice to what its project may use. */
  workflowId?: string;
  requirements: NodeCredentialRequirement[];
  value?: CredentialRefs;
  onChange: (next: CredentialRefs | undefined) => void;
  /** The edit is not going to be saved (another tab holds the lock, or that is not known yet): nothing is picked on its own. */
  readOnly?: boolean;
  /** The workflow is live and this node's credential differs from the published version's: triggers still use the published one. */
  publishPending?: boolean;
}) {
  const { credentials: all, types } = useCredentials();
  // On an agent's page the agent's project limits the choice, as the workflow's does in the editor.
  const agentId = useAgentScope();
  const { scope, failed, reload } = useCredentialScope(workflowId, agentId);
  // With a workflow, the choice waits for its project's credentials: before they are known nothing may be picked on the person's behalf.
  const { candidates: credentials, scoped, scopeKnown } = useMemo(() => credentialInputs({ all, scope, workflowId: workflowId ?? agentId }), [all, scope, workflowId, agentId]);
  const root = useRef<HTMLDivElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [dialog, setDialog] = useState<{ requirement: string; type: string; id?: string; name?: string } | null>(null);

  const set = (requirement: string, ref?: { id: string; name: string }) => {
    const next = { ...value };
    if (ref) next[requirement] = ref;
    else delete next[requirement];
    onChange(Object.keys(next).length ? next : undefined);
  };

  // Like n8n: when exactly one credential of the type exists (that this workflow's project may use), pick it. All
  // requirements go in one update, a requirement that becomes visible later is picked then, and one the person clears is left alone.
  const settled = useRef<ReadonlySet<string>>(new Set());
  const names = requirements.map((r) => r.name).join('|');
  useEffect(() => {
    const step = autoPickStep({ nodeType, requirements, candidates: credentials, scoped, scopeKnown, readOnly, settled: settled.current, value });
    settled.current = step.settled;
    if (step.next) onChange(step.next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials, scopeKnown, scoped, readOnly, nodeType, names, value]);

  return (
    <div ref={root} className="mb-5 space-y-3">
      {requirements.map((requirement) => {
        const type = qualifiedCredentialType(nodeType, requirement.name);
        const info = types?.find((t) => t.type === type);
        const options = (credentials ?? []).filter((c) => c.type === type);
        const ref = value?.[requirement.name];
        const deleted = ref && all && !all.some((c) => c.id === ref.id);
        const unusable = ref && !deleted && credentials && !options.some((c) => c.id === ref.id);
        const missing = deleted || unusable;
        return (
          <div key={requirement.name}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <CredentialTypeIcon info={info} size={16} />
              <span className="text-[12px] font-semibold text-t2">
                Credential for {info?.descriptor.displayName ?? requirement.name}
                {requirement.required && <span className="text-rd"> *</span>}
              </span>
            </div>
            <div className="flex gap-1.5">
              <div className="flex-1">
                <CredentialCombobox
                  id={`${nodeType}-${requirement.name}-credential`}
                  label={`Credential for ${info?.descriptor.displayName ?? requirement.name}`}
                  credentials={options}
                  value={missing ? undefined : ref?.id}
                  onPick={(picked) => set(requirement.name, { id: picked.id, name: picked.name })}
                  onCreate={(name) => setDialog({ requirement: requirement.name, type, ...(name && { name }) })}
                />
              </div>
              <Button size="icon" variant="ghost" onClick={() => setDialog({ requirement: requirement.name, type })} title="Create a credential" aria-label="Create a credential" className="max-md:size-11">
                <Plus className="size-3.5" />
              </Button>
              {ref && !missing && (
                <Button size="icon" variant="ghost" onClick={() => setDialog({ requirement: requirement.name, type, id: ref.id })} title="Edit this credential" aria-label="Edit credential">
                  <Pencil className="size-3.5" />
                </Button>
              )}
            </div>
            {deleted && (
              <p className="mt-1 flex items-center gap-1 text-[12px] text-warn">
                <TriangleAlert className="size-3" /> “{ref.name}” was deleted — choose or create another.
              </p>
            )}
            {unusable && (
              <p className="mt-1 flex items-center gap-1 text-[12px] text-warn">
                <TriangleAlert className="size-3" /> “{ref.name}” isn’t shared with {workflowId ? 'this workflow’s' : 'this agent’s'} project — choose another, or ask its owner to share it.
              </p>
            )}
            {ref && !missing && publishPending && (
              <p className="mt-1 text-[12px] text-t3">Triggers (webhooks, schedules, forms, chat) keep using the published version until you publish.</p>
            )}
            {!ref && requirement.required && credentials && (
              <p className="mt-1 text-[12px] text-t3">Required: the node fails until a credential is selected.</p>
            )}
            {!info && types && <p className="mt-1 text-[12px] text-warn">The plugin that publishes this credential type is offline.</p>}
          </div>
        );
      })}
      {/* Always rendered so a screen reader hears the warning appear, and the answer to Retry. */}
      <div role="status" aria-live="polite">
        {scoped && failed && (
          <p className="flex flex-wrap items-center gap-1 text-[12px] text-warn">
            <TriangleAlert className="size-3" /> Couldn’t check which credentials {workflowId ? 'this workflow’s' : 'this agent’s'} project may use, so every credential is listed and none is picked automatically.
            <button
              type="button"
              className="underline disabled:opacity-60"
              disabled={retrying}
              aria-busy={retrying}
              onClick={async () => {
                setRetrying(true);
                const ok = await reload();
                setRetrying(false);
                // The warning is gone: put focus on the first picker instead of on a button that vanished.
                if (ok) root.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
              }}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </p>
        )}
      </div>
      {dialog && (
        <CredentialDialog
          credentialId={dialog.id}
          allowedTypes={[dialog.type]}
          {...(dialog.name && { initialName: dialog.name })}
          {...(scope?.projectId && { projectId: scope.projectId })}
          onClose={() => setDialog(null)}
          onSaved={(credential) => {
            set(dialog.requirement, { id: credential.id, name: credential.name });
            void reload();
          }}
        />
      )}
    </div>
  );
}
