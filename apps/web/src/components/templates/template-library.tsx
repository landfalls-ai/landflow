'use client';
/**
 * /templates — the templates library: search, categories, and where templates come from (built in, saved on this
 * instance, and a remote n8n-compatible library when LANDFLOW_TEMPLATES_URL is set; 30 at a time, "Load more"). The
 * project picker (`?project=`, else the project worked in last) shows that project's saved templates and the
 * instance-wide ones; "All my projects" every one the viewer sees. `?folder=` and the project carry through to "Use
 * template", so a template picked from an empty folder lands in it. Import adds a template file someone exported.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileUp } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { TEMPLATE_CATEGORIES, type TemplateDetail, type TemplateSource } from '@/lib/shared/templates';
import { PhoneFilters } from '../ui/phone-filters';
import { useViewer } from '@/components/auth/viewer';
import { rememberedProject, rememberProject } from '@/components/projects/current-project';
import { projectLabel, useProjects } from '@/components/projects/use-projects';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { FilterChip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput, Select } from '@/components/ui/inputs';
import { TemplateCard } from './template-card';
import { useNodeTypeMap, useTemplateList } from './use-templates';
import { Segmented } from '../ui/segmented';
import { plural } from '@/lib/client/format';

const SOURCES: Array<{ id?: TemplateSource; label: string }> = [
  { label: 'All' },
  { id: 'builtin', label: 'Built-in' },
  { id: 'local', label: 'Saved here' },
  { id: 'remote', label: 'Remote' },
];

/** Import a template file (from "Export" on another instance) into `projectId` (else the server's default); the new template opens. */
export function useTemplateImport(onImported: (template: TemplateDetail) => void, projectId?: string) {
  const picker = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const importFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const { template } = await api<{ template: TemplateDetail }>('/api/templates', { method: 'POST', json: { data: await file.text(), ...(projectId && { projectId }) } });
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
  const viewer = useViewer();
  const { projects } = useProjects();
  const folder = params.get('folder') ?? undefined;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | undefined>(params.get('category') ?? undefined);
  const [source, setSource] = useState<TemplateSource>();
  // The project: `?project=`, else the one worked in last (once it's known to be one the viewer sees).
  const [project, setProject] = useState<string | undefined>(params.get('project') ?? undefined);
  useEffect(() => {
    if (project || params.get('project') || !projects) return;
    const last = rememberedProject();
    if (last && projects.some((p) => p.id === last)) setProject(last);
  }, [projects, project, params]);
  const known = project && projects && !projects.some((p) => p.id === project) ? undefined : project;
  const { listing, error, loading, reload, loadMore, loadingMore } = useTemplateList(query, category, source, known);
  const types = useNodeTypeMap();
  const importer = useTemplateImport((t) => {
    reload();
    router.push(`/templates/${t.id}`);
  }, known);
  const pick = (id: string) => {
    setProject(id || undefined);
    rememberProject(id || undefined);
  };

  const templates = listing?.templates ?? [];
  const remote = listing?.remote;
  const sources = SOURCES.filter((s) => s.id !== 'remote' || remote?.enabled);
  const carried = new URLSearchParams({ ...(folder && { folder }), ...(known && { project: known }) }).toString();
  const href = (id: string) => `/templates/${encodeURIComponent(id)}${carried ? `?${carried}` : ''}`;
  const current = projects?.find((p) => p.id === known);

  return (
    <>
      <PageHeader
        title="Templates"
        meta={listing && <span>{plural(templates.length, 'template')}</span>}
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
          <SearchInput value={query} onChange={setQuery} placeholder="Search templates, apps, nodes…" label="Search templates" className="w-full max-w-[360px] max-md:max-w-none" />
          {(projects?.length ?? 0) > 0 && (
            <div className="w-[200px]">
              <Select value={known ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Project" className="h-9">
                <option value="">All my projects</option>
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {projectLabel(p, viewer?.id)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <Segmented label="Source" value={source ?? 'all'} onChange={(v) => setSource(v === 'all' ? undefined : (v as TemplateSource))} options={sources.map((s) => ({ value: s.id ?? 'all', label: s.label }))} />
        </div>
        {/* A phone: the categories in a Filters sheet (desktop: in place). */}
        <PhoneFilters active={category ? 1 : 0} onClear={() => setCategory(undefined)}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
            {[undefined, ...TEMPLATE_CATEGORIES].map((c) => (
              <FilterChip key={c?.id ?? 'all'} size="sm" active={category === c?.id} onClick={() => setCategory(c?.id)}>
                {c?.name ?? 'All categories'}
              </FilterChip>
            ))}
          </div>
        </PhoneFilters>

        {current && (
          <p className="text-[12px] text-t3">
            Saved templates of {projectLabel(current, viewer?.id)} and the instance-wide ones; built-in and remote templates show the nodes this project allows. Workflows you create go into this project.
          </p>
        )}
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
              <TemplateCard key={t.id} template={t} types={types} index={i} href={href(t.id)} remoteLabel={remote?.label} folderId={folder} projectId={known} />
            ))}
          </div>
        )}
        {listing && remote?.hasMore && (
          <div className="flex justify-center">
            <Button size="sm" onClick={() => void loadMore()} loading={loadingMore}>
              Load more from {remote.label ?? 'the remote library'}
              {remote.total !== undefined && <span className="text-t3"> ({templates.filter((t) => t.source === 'remote').length} of {remote.total})</span>}
            </Button>
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
