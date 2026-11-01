'use client';
/** Save as template (docs/agents.md#templates): keeps an agent's persona, instructions, skills, model and avatar as a persona to start from. */
import { useId, useState } from 'react';
import { BookmarkPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { AgentTemplate } from '@/lib/shared/agents';
import { Button } from '../ui/button';
import { Input, Textarea } from '../ui/inputs';
import { Dialog, Field } from './dialog';

const CATEGORIES = ['Support', 'Research', 'Operations', 'Content', 'Data', 'People', 'Sales'];

export function SaveTemplateDialog({
  agent,
  onClose,
  onSaved,
}: {
  agent: { id: string; name: string; description: string };
  onClose: () => void;
  onSaved?: (template: AgentTemplate) => void;
}) {
  const id = useId();
  const [name, setName] = useState(agent.name);
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState(agent.description);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { template } = await api<{ template: AgentTemplate }>('/api/agent-templates', {
        method: 'POST',
        json: { agentId: agent.id, name: name.trim() || undefined, category: category.trim() || undefined, description: description.trim() || undefined },
      });
      toast.success(`Saved “${template.name}” as a template`);
      onSaved?.(template);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Save as template"
      subtitle={agent.name}
      icon={<BookmarkPlus className="size-5 text-ac" />}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!name.trim()}>
            Save template
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !saving) void save();
        }}
      >
        <Field id={`${id}-name`} label="Name">
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field id={`${id}-category`} label="Category" hint="Left empty, it goes under Your templates.">
          <Input id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)} list={`${id}-categories`} placeholder="Your templates" />
          <datalist id={`${id}-categories`}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field id={`${id}-description`} label="Description">
          <Textarea id={`${id}-description`} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="text-[12px] leading-snug text-t3">Keeps the persona, instructions, skills, model and avatar. Tools, channels, schedules and credentials stay with this agent.</p>
      </form>
    </Dialog>
  );
}
