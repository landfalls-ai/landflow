'use client';
/**
 * "Use template": name the workflow, pick a folder, and pick (or create) a credential for each slot. Only saved
 * credentials of the slot's type are offered; a slot left on "Choose later" leaves its nodes without one. The new
 * workflow is an inactive draft and opens in the editor.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutTemplate, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { TemplateDetail, UseTemplateResult } from '@/lib/shared/templates';
import type { Folder } from '@/lib/shared/types';
import { Dialog, Field } from '@/components/agents/dialog';
import { CredentialDialog, CredentialTypeIcon } from '@/components/credentials/credential-dialog';
import { useCredentials } from '@/components/credentials/use-credentials';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/inputs';

const NEW = '__new__';

/** "Clients / Acme" labels, parents first. */
function folderOptions(folders: Folder[]): Array<{ id: string; label: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (folder: Folder): string[] => {
    const names = [folder.name];
    for (let parent = folder.parentId && byId.get(folder.parentId), depth = 0; parent && depth < 20; parent = parent.parentId && byId.get(parent.parentId), depth++) names.unshift(parent.name);
    return names;
  };
  return folders.map((f) => ({ id: f.id, label: pathOf(f).join(' / ') })).sort((a, b) => a.label.localeCompare(b.label));
}

export function UseTemplateDialog({ template, folderId, onClose }: { template: TemplateDetail; folderId?: string; onClose: () => void }) {
  const router = useRouter();
  const { credentials, types } = useCredentials();
  const [name, setName] = useState(template.name);
  const [folders, setFolders] = useState<Folder[]>();
  const [folder, setFolder] = useState(folderId ?? '');
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ folders: Folder[] }>('/api/folders')
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]));
  }, []);

  // Start each slot on the first saved credential of its type, once credentials are loaded.
  useEffect(() => {
    if (!credentials) return;
    setPicks((current) => {
      const next = { ...current };
      for (const slot of template.credentials) if (next[slot.id] === undefined) next[slot.id] = credentials.find((c) => c.type === slot.type)?.id ?? '';
      return next;
    });
  }, [credentials, template.credentials]);

  const options = useMemo(() => folderOptions(folders ?? []), [folders]);
  const unpicked = template.credentials.filter((s) => !s.optional && !picks[s.id]).length;

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await api<UseTemplateResult>(`/api/templates/${encodeURIComponent(template.id)}/use`, {
        method: 'POST',
        json: { name: name.trim() || template.name, ...(folder && { folderId: folder }), credentials: Object.fromEntries(Object.entries(picks).filter(([, id]) => id)) },
      });
      const notes = [result.createdTables.length && `Created data table${result.createdTables.length === 1 ? '' : 's'} ${result.createdTables.map((t) => `“${t}”`).join(', ')}.`, ...result.warnings].filter(Boolean);
      toast.success(`Created “${result.workflow.name}”`, notes.length ? { description: notes.join(' ') } : undefined);
      router.push(`/workflows/${result.workflow.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        title="Use template"
        subtitle={template.name}
        icon={<LayoutTemplate className="size-5 text-t2" />}
        onClose={onClose}
        width={560}
        footer={
          <>
            {unpicked > 0 && <span className="mr-auto text-[12px] text-t3">{unpicked} credential{unpicked === 1 ? '' : 's'} to choose later</span>}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving}>
              Create workflow
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field id="template-workflow-name" label="Workflow name">
            <Input id="template-workflow-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
          </Field>
          <Field id="template-folder" label="Folder">
            <Select id="template-folder" value={folder} onChange={(e) => setFolder(e.target.value)} disabled={!folders}>
              <option value="">No folder</option>
              {options.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>

          {template.credentials.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-semibold text-t2">Credentials</div>
              {template.credentials.map((slot) => {
                const info = types?.find((t) => t.type === slot.type);
                const saved = credentials?.filter((c) => c.type === slot.type) ?? [];
                const id = `template-slot-${slot.id}`;
                return (
                  <div key={slot.id} className="flex items-center gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
                    <CredentialTypeIcon info={info} size={30} />
                    <div className="min-w-0 flex-1">
                      <label htmlFor={id} className="block truncate text-[13px] font-semibold text-t1">
                        {slot.name}
                        {slot.optional && <span className="ml-1.5 text-[11px] font-normal text-t3">optional</span>}
                      </label>
                      <div className="truncate text-[11px] text-t3">{slot.description ?? (slot.nodes?.length ? `Used by ${slot.nodes.join(', ')}` : slot.type)}</div>
                      {types && !info && (
                        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-warn">
                          <TriangleAlert className="size-3" /> {slot.type} isn’t available here
                        </div>
                      )}
                    </div>
                    <Select
                      id={id}
                      className="w-[190px] shrink-0"
                      value={picks[slot.id] ?? ''}
                      onChange={(e) => (e.target.value === NEW ? setCreating(slot.id) : setPicks((p) => ({ ...p, [slot.id]: e.target.value })))}
                    >
                      <option value="">Choose later</option>
                      {saved.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      {info && <option value={NEW}>+ New credential…</option>}
                    </Select>
                  </div>
                );
              })}
            </div>
          )}

          {template.dataTables.length > 0 && (
            <p className="text-[12px] leading-snug text-t3">
              Uses the data table{template.dataTables.length === 1 ? '' : 's'} {template.dataTables.map((t) => `“${t.name}”`).join(', ')}: created if missing, otherwise the existing one is used.
            </p>
          )}
          {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        </form>
      </Dialog>
      {creating && (
        <CredentialDialog
          allowedTypes={[template.credentials.find((s) => s.id === creating)!.type]}
          onClose={() => setCreating(undefined)}
          // The store is refreshed before onSaved; OAuth2 "Connect" saves without closing the dialog.
          onSaved={(credential) => setPicks((p) => ({ ...p, [creating]: credential.id }))}
        />
      )}
    </>
  );
}
