'use client';
/**
 * The node panel's credential pickers: one per credential type the node declares, with create and edit inline. With
 * `workflowId`, only the credentials that workflow's project may use are offered (lib/shared/projects.ts), and new
 * ones are created in that project.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, TriangleAlert } from 'lucide-react';
import type { NodeCredentialRequirement } from '@landflow/protocol';
import type { CredentialRefs } from '../editor/param-form';
import { Button } from '../ui/button';
import { Select } from '../ui/inputs';
import { useCredentialScope } from '../projects/use-projects';
import { CredentialDialog, CredentialTypeIcon } from './credential-dialog';
import { autoPickStep, qualifiedCredentialType, useCredentials } from './use-credentials';

const CREATE = '__create__';

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
  /** The edit is not going to be saved (another tab holds the lock): nothing is picked on its own. */
  readOnly?: boolean;
  /** The workflow is live and has changes that are not published: triggers and the API still use the published credential. */
  publishPending?: boolean;
}) {
  const { credentials: all, types } = useCredentials();
  const { scope, failed, reload } = useCredentialScope(workflowId);
  // With a workflow, the choice waits for its project's credentials: before they are known nothing may be picked on the person's behalf.
  const scoped = Boolean(workflowId);
  const credentials = useMemo(() => (all && scope ? all.filter((c) => scope.ids.has(c.id)) : all), [all, scope]);
  const [dialog, setDialog] = useState<{ requirement: string; type: string; id?: string } | null>(null);

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
    const step = autoPickStep({ nodeType, requirements, candidates: credentials, scoped, scopeKnown: Boolean(scope), readOnly, settled: settled.current, value });
    settled.current = step.settled;
    if (step.next) onChange(step.next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials, scope, scoped, readOnly, nodeType, names, value]);

  return (
    <div className="mb-5 space-y-3">
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
                <Select
                  aria-label={`Credential for ${info?.descriptor.displayName ?? requirement.name}`}
                  value={missing ? '' : (ref?.id ?? '')}
                  onChange={(e) => {
                    if (e.target.value === CREATE) setDialog({ requirement: requirement.name, type });
                    else {
                      const picked = options.find((c) => c.id === e.target.value);
                      set(requirement.name, picked && { id: picked.id, name: picked.name });
                    }
                  }}
                >
                  <option value="">{options.length ? 'Select a credential…' : 'No credential yet'}</option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={CREATE}>+ Create new credential</option>
                </Select>
              </div>
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
                <TriangleAlert className="size-3" /> “{ref.name}” isn’t shared with this workflow’s project — choose another, or ask its owner to share it.
              </p>
            )}
            {ref && !missing && publishPending && (
              <p className="mt-1 text-[12px] text-t3">Triggers and the API keep using the published version until you publish this change.</p>
            )}
            {!ref && requirement.required && credentials && (
              <p className="mt-1 text-[12px] text-t3">Required: the node fails until a credential is selected.</p>
            )}
            {!info && types && <p className="mt-1 text-[12px] text-warn">The plugin that publishes this credential type is offline.</p>}
          </div>
        );
      })}
      {scoped && failed && (
        <p className="flex items-center gap-1 text-[12px] text-warn">
          <TriangleAlert className="size-3" /> Couldn’t check which credentials this workflow’s project may use, so none is picked automatically.
          <button type="button" className="underline" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}
      {dialog && (
        <CredentialDialog
          credentialId={dialog.id}
          allowedTypes={[dialog.type]}
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
