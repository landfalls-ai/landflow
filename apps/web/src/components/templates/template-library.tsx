'use client';
/**
 * /templates — the templates library: search, categories, and where templates come from (built in, saved on this
 * instance, and a remote n8n-compatible library when LANDFLOW_TEMPLATES_URL is set). `?folder=` carries through to
 * "Use template", so a template picked from an empty folder lands in it. Import adds a template file someone exported.
 */
import { useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileUp, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { TEMPLATE_CATEGORIES, type TemplateDetail, type TemplateSource } from '@/lib/shared/templates';
import { cn } from '@/lib/utils';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/inputs';
import { TemplateCard } from './template-card';
import { useNodeTypeMap, useTemplateList } from './use-templates';

const SOURCES: Array<{ id?: TemplateSource; label: string }> = [
  { label: 'All' },
  { id: 'builtin', label: 'Built in' },
  { id: 'local', label: 'Saved here' },
  { id: 'remote', label: 'Remote' },
];

/** Import a template file (from "Export" on another instance); the new template opens. */
export function useTemplateImport(onImported: (template: TemplateDetail) => void) {
  const picker = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const importFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const { template } = await api<{ template: TemplateDetail }>('/api/templates', { method: 'POST', json: { data: await file.text() } });
      toast.success(`Imported “${template.name}”`);
      onImported(template);
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
      if (picker.current) picker.current.value = '';
    }
  };
  const input = <input ref={picker} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void importFile(e.target.files?.[0] ?? undefined)} />;
  return { input, importing, open: () => picker.current?.click() };
}

export function TemplateLibrary() {
  const router = useRouter();
  const params = useSearchParams();
  const folder = params.get('folder') ?? undefined;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | undefined>(params.get('category') ?? undefined);
  const [source, setSource] = useState<TemplateSource>();
  const { listing, error, loading, reload } = useTemplateList(query, category, source);
  const types = useNodeTypeMap();
  const importer = useTemplateImport((t) => {
    reload();
    router.push(`/templates/${t.id}`);
  });

  const templates = listing?.templates ?? [];
  const remote = listing?.remote;
  const sources = SOURCES.filter((s) => s.id !== 'remote' || remote?.enabled);
  const href = (id: string) => `/templates/${encodeURIComponent(id)}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`;

  return (
    <>
      <PageHeader
        title="Templates"
        meta={listing && <span>{templates.length}</span>}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={importer.open} loading={importer.importing} title="Add a template file exported from Landflow">
              {!importer.importing && <FileUp className="size-3.5" />} Import
            </Button>
            {importer.input}
          </>
        }
      />
      <PageBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-[360px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-t3" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates, apps, nodes…" className="pl-9" aria-label="Search templates" />
          </div>
          <div role="tablist" aria-label="Source" className="flex w-fit items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
            {sources.map((s) => (
              <button
                key={s.label}
                role="tab"
                aria-selected={source === s.id}
                onClick={() => setSource(s.id)}
                className={cn('h-7 rounded-full px-3 text-[12px] text-t2 transition-all duration-200 hover:text-t1', source === s.id && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]')}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
          {[undefined, ...TEMPLATE_CATEGORIES].map((c) => (
            <button
              key={c?.id ?? 'all'}
              onClick={() => setCategory(c?.id)}
              aria-pressed={category === c?.id}
              className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', category === c?.id ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 hover:border-ac')}
            >
              {c?.name ?? 'All categories'}
            </button>
          ))}
        </div>

        {folder && <p className="text-[12px] text-t3">The workflow you create goes into the folder you came from.</p>}
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {remote?.error && (
          <div className="rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
            Couldn’t reach the remote templates{remote.label ? ` at ${remote.label}` : ''}: {remote.error}
          </div>
        )}
        {remote?.enabled && !source && !query.trim() && <p className="text-[12px] text-t3">Search to include remote templates from {remote.label}.</p>}

        {listing && templates.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-2.5">
            {templates.map((t, i) => (
              <TemplateCard key={t.id} template={t} types={types} index={i} href={href(t.id)} remoteLabel={remote?.label} />
            ))}
          </div>
        )}
        {listing && !templates.length && !loading && (
          <Card className="py-6">
            <EmptyState
              compact
              title={source === 'local' && !query.trim() && !category ? 'No saved templates yet' : 'No template matches'}
              hint={source === 'local' ? 'Save a workflow as a template from its … menu in the editor, or import a template file.' : 'Try another search or category.'}
            />
          </Card>
        )}
        {!listing && loading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-2.5">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="h-[172px] animate-pulse-soft rounded-2xl bg-wl" />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
