'use client';
/** Edit a project's brief (docs/projects-and-goals.md): what it is for, limits, done when, its words, status, target, lead, decision owner. */
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { usePhone } from '@/lib/client/use-phone';
import { BRIEF_LIMITS, PROJECT_STATUS_LABELS, PROJECT_STATUSES, type ProjectBriefView, type ProjectStatus } from '@/lib/shared/goals';
import { usePeople } from '@/components/goals/use-goals';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FieldLabel, Input, Select, Textarea } from '@/components/ui/inputs';
import { Sheet } from '@/components/ui/sheet';

export function BriefDialog({ projectId, brief, onClose, onSaved }: { projectId: string; brief?: ProjectBriefView; onClose: () => void; onSaved: () => void }) {
  const phone = usePhone();
  const people = usePeople(projectId);
  const [text, setText] = useState({ brief: brief?.brief ?? '', constraints: brief?.constraints ?? '', doneWhen: brief?.doneWhen ?? '', glossary: brief?.glossary ?? '' });
  const [status, setStatus] = useState<ProjectStatus | ''>(brief?.status ?? '');
  const [targetDate, setTargetDate] = useState(brief?.targetDate ?? '');
  const [leadId, setLeadId] = useState(brief?.leadId ?? '');
  const [decisionOwnerId, setDecisionOwnerId] = useState(brief?.decisionOwnerId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const clear = (v: string) => v.trim() || null;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        json: {
          brief: {
            brief: clear(text.brief),
            constraints: clear(text.constraints),
            doneWhen: clear(text.doneWhen),
            glossary: clear(text.glossary),
            status: status || null,
            targetDate: targetDate || null,
            leadId: leadId || null,
            decisionOwnerId: decisionOwnerId || null,
          },
        },
      });
      toast.success('Brief saved');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const area = (key: keyof typeof text, label: string, limit: number, hint: string, rows = 3) => (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Textarea value={text[key]} onChange={(e) => setText((t) => ({ ...t, [key]: e.target.value }))} maxLength={limit} rows={rows} placeholder={hint} className="w-full" />
      <div className="mt-0.5 text-right text-[11px] text-t3">{text[key].length} / {limit}</div>
    </div>
  );
  const person = (label: string, value: string, set: (v: string) => void) => (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Select aria-label={label} value={value} onChange={(e) => set(e.target.value)} className="max-md:h-11">
        <option value="">Nobody</option>
        {brief && value && !people.some((p) => p.id === value) && <option value={value}>{(label === 'Lead' ? brief.leadName : brief.decisionOwnerName) ?? value}</option>}
        {people.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </Select>
    </div>
  );
  const body = (
    <div className="space-y-4">
      {area('brief', 'Brief', BRIEF_LIMITS.brief, 'What this project is for, in a few sentences.', 4)}
      {area('constraints', 'Constraints', BRIEF_LIMITS.constraints, 'What must hold: budgets, rules, things not to touch.')}
      {area('doneWhen', 'Done when', BRIEF_LIMITS.doneWhen, 'How we know it is finished.')}
      {area('glossary', 'Words we use', BRIEF_LIMITS.glossary, 'Terms with a meaning here, one per line.')}
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <div>
          <FieldLabel>Status</FieldLabel>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | '')} className="max-md:h-11">
            <option value="">Not set</option>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Target date</FieldLabel>
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} aria-label="Target date" className="max-md:h-11" />
        </div>
        {person('Lead', leadId, setLeadId)}
        {person('Decision owner', decisionOwnerId, setDecisionOwnerId)}
      </div>
      {error && <p role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">{error}</p>}
    </div>
  );
  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button variant="ghost" onClick={onClose} className="max-md:min-h-11">Cancel</Button>
      <Button variant="primary" onClick={() => void save()} loading={busy} className="max-md:min-h-11">Save brief</Button>
    </div>
  );
  if (phone) return <Sheet open onClose={onClose} title="Edit brief" footer={footer} className="h-[100dvh] max-h-[100dvh] rounded-none border-0">{body}</Sheet>;
  return <Dialog title="Edit brief" onClose={onClose} footer={footer} width={600}>{body}</Dialog>;
}
