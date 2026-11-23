'use client';
/**
 * Settings → Company: the company's name and its mission (docs/projects-and-goals.md). Admins edit; everyone else reads.
 * The mission shows on the Goals page and in what agents read about a project.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import { BRIEF_LIMITS, type CompanyProfile } from '@/lib/shared/goals';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, Textarea } from '@/components/ui/inputs';

export function CompanySettings() {
  const viewer = useViewer();
  const editable = can(viewer, 'settings:manage');
  const [saved, setSaved] = useState<CompanyProfile>();
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ company?: CompanyProfile }>('/api/settings')
      .then((r) => {
        setSaved(r.company ?? {});
        setName(r.company?.name ?? '');
        setMission(r.company?.mission ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const dirty = Boolean(saved) && (name !== (saved?.name ?? '') || mission !== (saved?.mission ?? ''));
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const r = await api<{ company?: CompanyProfile }>('/api/settings', { method: 'PATCH', json: { company: { name: name.trim() || null, mission: mission.trim() || null } } });
      setSaved(r.company ?? {});
      setName(r.company?.name ?? '');
      setMission(r.company?.mission ?? '');
      toast.success('Company saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4">
      <div>
        <FieldLabel>Company name</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={BRIEF_LIMITS.companyName} disabled={!editable || !saved} aria-label="Company name" className="max-md:h-11" />
      </div>
      <div>
        <FieldLabel>Mission</FieldLabel>
        <Textarea value={mission} onChange={(e) => setMission(e.target.value)} maxLength={BRIEF_LIMITS.mission} rows={3} disabled={!editable || !saved} aria-label="Mission" placeholder="Why the company exists, in a sentence or two." className="w-full" />
        <div className="mt-0.5 flex justify-between text-[11px] text-t3">
          <span>{editable ? 'Shown on Goals; agents read it with a project’s goals.' : 'Only owners and admins change this.'}</span>
          <span>{mission.length} / {BRIEF_LIMITS.mission}</span>
        </div>
      </div>
      {error && <p role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">{error}</p>}
      {editable && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty} className="max-md:min-h-11">Save</Button>
        </div>
      )}
    </Card>
  );
}
