'use client';
/**
 * Settings → AI → Spotlight: the model Spotlight thinks with unless a person picks another in its header (docs/assistant.md).
 * Only models the server offers are listed; a local one is marked. Admins save; everyone else reads.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import type { SpotlightModels } from '@/lib/shared/spotlight-models';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { FieldLabel, Select } from '@/components/ui/inputs';

export function SpotlightSettings() {
  const viewer = useViewer();
  const editable = can(viewer, 'settings:manage');
  const [saved, setSaved] = useState<SpotlightModels>();
  const [model, setModel] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<SpotlightModels>('/api/settings/spotlight')
      .then((r) => {
        setSaved(r);
        setModel(r.default);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const r = await api<SpotlightModels>('/api/settings/spotlight', { method: 'PUT', json: { model } });
      setSaved(r);
      setModel(r.default);
      toast.success('Spotlight model saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const label = (m: SpotlightModels['models'][number]) => `${m.label}${m.local ? ' · on this machine' : m.source === 'gateway' ? ' · via the LLM gateway' : ` · ${m.source}`}`;

  return (
    <Card className="space-y-4">
      <div>
        <FieldLabel>Model Spotlight uses</FieldLabel>
        <Select value={model} onChange={(e) => setModel(e.target.value)} disabled={!editable || !saved} aria-label="Model Spotlight uses" className="max-md:h-11">
          {(saved?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {label(m)}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-[11px] text-t3">
          {editable ? 'Spotlight, its first drafts and suggestions, and the Agent architect use it. On a desktop a person can pick another model for a conversation in Spotlight’s header.' : 'Only owners and admins change this.'} Only models this server is set up for are listed; a local model stays the default.
        </p>
      </div>
      {error && <p role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">{error}</p>}
      {editable && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!saved || model === saved.default} className="max-md:min-h-11">Save</Button>
        </div>
      )}
    </Card>
  );
}
