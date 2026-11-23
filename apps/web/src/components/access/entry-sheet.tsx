'use client';
/**
 * The catalog entry sheet: what an entry reaches (system, target, credential: admins), the durations a person may pick, who approves,
 * who owns it, who may ask, and whether it is on. `EntryFields` is the form body; a viewer who can't change a field sees it read-only
 * (owners change durations, approvers, owners, who may ask and the switch; admins everything). A save of a stale entry answers 409.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { accessApi, draftOf, SYSTEM_FORM, type EntryDraft, type Person2 } from '@/lib/client/access';
import { ACCESS_LIMITS, durationText, type AccessEntryView, type AccessSystem } from '@/lib/shared/access';
import { ACCESS_SYSTEMS } from '@/lib/shared/access';
import type { CredentialSummary } from '@/lib/shared/types';
import { usePhone } from '@/lib/client/use-phone';
import { CredentialCombobox } from '../credentials/credential-combobox';
import { Button } from '../ui/button';
import { FieldLabel, Input, Select, Switch, Textarea } from '../ui/inputs';
import { Sheet } from '../ui/sheet';

function Chips({ items, onRemove, disabled }: { items: Array<{ key: string; label: string }>; onRemove: (key: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item.key} className="inline-flex items-center gap-1 rounded-full border border-hair bg-sf2 py-0.5 pl-2.5 pr-1 text-[12.5px] text-t1">
          {item.label}
          {!disabled && (
            <button type="button" aria-label={`Remove ${item.label}`} onClick={() => onRemove(item.key)} className="grid size-5 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-7">
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

function PeoplePicker({ label, people, value, onChange, disabled, hint }: { label: string; people: Person2[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; hint?: string }) {
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Chips items={value.map((id) => ({ key: id, label: name(id) }))} disabled={disabled} onRemove={(id) => onChange(value.filter((v) => v !== id))} />
      {!disabled && (
        <Select aria-label={`Add to ${label}`} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="mt-1.5 max-md:h-11">
          <option value="">Add a person…</option>
          {people.filter((p) => !value.includes(p.id)).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      )}
      {hint && <p className="mt-1 text-[12px] text-t3">{hint}</p>}
    </div>
  );
}

const lengthOf = (m: number | null) => (m === null ? Infinity : m);

export function EntryFields({ draft, people, credentials, isAdmin, canEdit, onChange, onCreateCredential }: { draft: EntryDraft; people: Person2[]; credentials: CredentialSummary[]; isAdmin: boolean; canEdit: boolean; onChange: (draft: EntryDraft) => void; onCreateCredential: () => void }) {
  const form = SYSTEM_FORM[draft.system];
  const set = (patch: Partial<EntryDraft>) => onChange({ ...draft, ...patch });
  const reach = canEdit && isAdmin;
  const [custom, setCustom] = useState('');
  const usable = credentials.filter((c) => form.credentialTypes.includes(c.type));
  const addDuration = (minutes: number | null) => {
    if (draft.durations.includes(minutes) || draft.durations.length >= ACCESS_LIMITS.durationsPerEntry) return;
    set({ durations: [...draft.durations, minutes].sort((a, b) => lengthOf(a) - lengthOf(b)) });
  };
  const customMinutes = Number(custom);
  const customOk = Number.isInteger(customMinutes) && customMinutes >= 1 && customMinutes <= ACCESS_LIMITS.maxMinutes;
  const suggestions = ACCESS_LIMITS.suggestedDurations.filter((m) => !draft.durations.includes(m));
  return (
    <div className="flex flex-col gap-4">
      <div>
        <FieldLabel>Name</FieldLabel>
        <Input aria-label="Name" value={draft.name} disabled={!canEdit} onChange={(e) => set({ name: e.target.value })} placeholder="Platform team" className="max-md:h-11" />
      </div>
      <div>
        <FieldLabel>Description</FieldLabel>
        <Textarea aria-label="Description" rows={2} value={draft.description} disabled={!canEdit} onChange={(e) => set({ description: e.target.value })} placeholder="What it gives, shown to people who ask" />
      </div>
      <div>
        <FieldLabel>System</FieldLabel>
        <Select aria-label="System" value={draft.system} disabled={!reach} onChange={(e) => set({ system: e.target.value as AccessSystem, target: {}, credentialId: '' })} className="max-md:h-11">
          {ACCESS_SYSTEMS.map((system) => (
            <option key={system} value={system}>{SYSTEM_FORM[system].label}</option>
          ))}
        </Select>
      </div>
      {form.fields.map((field) => (
        <div key={field.name}>
          <FieldLabel>{field.label}</FieldLabel>
          {field.options ? (
            <Select aria-label={field.label} value={draft.target[field.name] ?? ''} disabled={!reach} onChange={(e) => set({ target: { ...draft.target, [field.name]: e.target.value } })} className="max-md:h-11">
              <option value="">Default</option>
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          ) : field.name === 'instructions' ? (
            <Textarea aria-label={field.label} rows={3} value={draft.target[field.name] ?? ''} disabled={!reach} placeholder={field.placeholder} onChange={(e) => set({ target: { ...draft.target, [field.name]: e.target.value } })} />
          ) : (
            <Input aria-label={field.label} value={draft.target[field.name] ?? ''} disabled={!reach} placeholder={field.placeholder} onChange={(e) => set({ target: { ...draft.target, [field.name]: e.target.value } })} className="max-md:h-11" />
          )}
        </div>
      ))}
      {form.credentialTypes.length > 0 && (
        <div>
          <FieldLabel>Credential</FieldLabel>
          {reach ? (
            <CredentialCombobox id="access-entry-credential" label="Credential" credentials={usable} value={draft.credentialId || undefined} onPick={(c) => set({ credentialId: c.id })} onCreate={onCreateCredential} />
          ) : (
            <p className="text-[13px] text-t2">{draft.credentialId ? (credentials.find((c) => c.id === draft.credentialId)?.name ?? 'Set') : 'None'} (admins change it)</p>
          )}
          <p className="mt-1 text-[12px] text-t3">Landflow reaches {form.label.toLowerCase()} with this key. It must be usable by the project the access flows live in.</p>
        </div>
      )}
      <div>
        <FieldLabel>Durations people may ask for</FieldLabel>
        <Chips items={draft.durations.map((m) => ({ key: String(m), label: durationText(m) }))} disabled={!canEdit} onRemove={(key) => set({ durations: draft.durations.filter((m) => String(m) !== key) })} />
        {canEdit && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Select aria-label="Add duration" value="" onChange={(e) => e.target.value && addDuration(e.target.value === 'unlimited' ? null : Number(e.target.value))} className="max-md:h-11">
              <option value="">Add duration…</option>
              {suggestions.map((m) => (
                <option key={String(m)} value={m === null ? 'unlimited' : m}>{durationText(m)}</option>
              ))}
            </Select>
            <Input aria-label="Custom minutes" inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} placeholder="Minutes" className="w-24 max-md:h-11" />
            <Button size="sm" variant="outline" disabled={!customOk} onClick={() => { addDuration(customMinutes); setCustom(''); }} className="max-md:h-11">Add</Button>
          </div>
        )}
        <p className="mt-1 text-[12px] text-t3">Up to {ACCESS_LIMITS.durationsPerEntry}, from 1 minute to 90 days, or unlimited.</p>
      </div>
      <PeoplePicker label="Approvers" people={people} value={draft.approverIds} disabled={!canEdit} onChange={(approverIds) => set({ approverIds })} hint="Nobody approves their own request." />
      <PeoplePicker label="Owners" people={people} value={draft.owners} disabled={!canEdit} onChange={(owners) => set({ owners })} hint="Owners change this entry. At least one stays." />
      <PeoplePicker label="Who may ask" people={people} value={draft.eligibleUserIds} disabled={!canEdit} onChange={(eligibleUserIds) => set({ eligibleUserIds })} hint="Empty: everyone signed in." />
      <div className="flex items-center gap-3">
        <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} disabled={!canEdit} label="On" />
        <span className="text-[13px] text-t2">{draft.enabled ? 'On: people can ask for it' : 'Off: hidden from the form'}</span>
      </div>
    </div>
  );
}

export function EntrySheet({ entry, open, isAdmin, people, projectId, onClose, onSaved }: { entry?: AccessEntryView; open: boolean; isAdmin: boolean; people: Person2[]; projectId?: string; onClose: () => void; onSaved: () => void }) {
  const phone = usePhone();
  const [draft, setDraft] = useState<EntryDraft>(() => draftOf(entry));
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(entry));
    setError(undefined);
    if (isAdmin) api<{ credentials: CredentialSummary[] }>(`/api/credentials${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) => setCredentials(r.credentials)).catch(() => setCredentials([]));
  }, [open, entry, isAdmin, projectId]);

  const canEdit = entry ? entry.canEdit : isAdmin;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (entry) await accessApi.saveEntry(entry.id, entry.version, draft, isAdmin);
      else await accessApi.createEntry(draft);
      toast.success(entry ? 'Saved' : 'Entry added');
      onSaved();
      onClose();
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 409 ? 'Someone else changed this entry. Close the sheet and open it again to see their changes.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!entry || !window.confirm(`Delete ${entry.name}? An entry with access in place can only be switched off.`)) return;
    setBusy(true);
    try {
      await accessApi.deleteEntry(entry.id);
      toast.success('Deleted');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={entry ? entry.name : 'New entry'}
      className={phone ? 'h-dvh max-h-none rounded-none' : 'md:max-w-[560px]'}
      footer={
        <div className="flex flex-col gap-2">
          {error && <p role="alert" className="text-[13px] text-rd">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={save} data-testid="access-entry-save" className="max-md:h-11 max-md:flex-1">{entry ? 'Save' : 'Add entry'}</Button>}
            {entry && isAdmin && <Button variant="danger" disabled={busy} onClick={remove} className="max-md:h-11">Delete</Button>}
            <Button variant="ghost" onClick={onClose} className="max-md:h-11">{canEdit ? 'Cancel' : 'Close'}</Button>
          </div>
        </div>
      }
    >
      <EntryFields draft={draft} people={people} credentials={credentials} isAdmin={isAdmin} canEdit={canEdit} onChange={setDraft} onCreateCredential={() => toast.message('Add the key on the Credentials page, then pick it here')} />
    </Sheet>
  );
}
