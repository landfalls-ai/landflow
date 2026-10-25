'use client';
/**
 * "Save as template" from the editor's … menu: the open workflow (unsaved edits included) becomes a template on this
 * instance. The server turns credentials into slots and leaves out pinned data, the folder, tags and publication state.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutTemplate } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateDetail } from '@/lib/shared/templates';
import { cn } from '@/lib/utils';
import { Dialog, Field } from '@/components/agents/dialog';
import { useEditor } from '@/components/editor/store';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/inputs';

export function SaveTemplateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [workflow] = useState(() => useEditor.getState().toWorkflow());
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? '');
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [setup, setSetup] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const credentialCount = workflow.nodes.filter((n) => Object.keys(n.credentials ?? {}).length).length;

  const toggle = (id: TemplateCategory) => setCategories((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const submit = async () => {
    if (!name.trim()) return setError('Give the template a name');
    setSaving(true);
    setError(undefined);
    try {
      const { template } = await api<{ template: TemplateDetail }>('/api/templates', {
        method: 'POST',
        json: { workflow, name: name.trim(), description, categories, setup: setup.split('\n').map((s) => s.trim()).filter(Boolean) },
      });
      toast.success(`Saved “${template.name}” as a template`, { action: { label: 'Open', onClick: () => router.push(`/templates/${template.id}`) } });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Save as template"
      subtitle="Everyone on this instance can start a workflow from it"
      icon={<LayoutTemplate className="size-5 text-t2" />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving}>
            Save template
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
        <Field id="template-name" label="Name" required>
          <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <Field id="template-description" label="Description" hint="Markdown. What it does and who it’s for.">
          <Textarea id="template-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <Field label="Categories">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
            {TEMPLATE_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={categories.includes(c.id)}
                onClick={() => toggle(c.id)}
                className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', categories.includes(c.id) ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 hover:border-ac')}
              >
                {c.name}
              </button>
            ))}
          </div>
        </Field>
        <Field id="template-setup" label="Setup steps" hint="One step per line, Markdown: what to fill in before the first run.">
          <Textarea id="template-setup" value={setup} onChange={(e) => setSetup(e.target.value)} rows={4} placeholder={'Pick a Slack credential\nSet the channel in “Post to Slack”'} />
        </Field>
        <p className="rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] leading-snug text-t2">
          {credentialCount > 0 ? `Credentials stay here: the ${credentialCount} node${credentialCount === 1 ? '' : 's'} using one get a slot that whoever uses the template fills. ` : ''}
          Pinned data, the folder, tags and publication state are left out; data tables are referenced by name.
        </p>
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
      </form>
    </Dialog>
  );
}
