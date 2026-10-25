'use client';
/**
 * /templates/:id — one template: a read-only canvas preview, its description, the setup steps, the credentials and
 * data tables it needs, and (remote templates) what the n8n importer did. "Use template" opens the setup dialog;
 * templates whose nodes are missing here or blocked by the governance policy say why and can't be used.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Ban, ChevronLeft, Download, KeyRound, LayoutTemplate, PackageX, Table2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { TemplateDetail } from '@/lib/shared/templates';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { Markdown } from '@/components/canvas/markdown';
import { CredentialTypeIcon } from '@/components/credentials/credential-dialog';
import { useCredentials } from '@/components/credentials/use-credentials';
import { ImportReportView } from '@/components/editor/import-report';
import { ExecutionCanvas } from '@/components/executions/execution-canvas';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionLabel } from '@/components/ui/inputs';
import { categoryName, ProblemBadge, SourceBadge, TemplateNodeIcons } from './template-card';
import { UseTemplateDialog } from './use-template-dialog';
import { downloadTemplate, useNodeTypeMap, useTemplateDetail } from './use-templates';

const NO_RUN_DATA = {};

function Credentials({ template }: { template: TemplateDetail }) {
  const { types } = useCredentials();
  if (!template.credentials.length) return <p className="text-[12px] text-t3">None: this template runs without credentials.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {template.credentials.map((slot) => (
        <li key={slot.id} className="flex items-center gap-2.5 rounded-[10px] border border-hair bg-wl px-2.5 py-2">
          <CredentialTypeIcon info={types?.find((t) => t.type === slot.type)} size={26} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-t1">
              {slot.name}
              {slot.optional && <span className="ml-1.5 font-normal text-t3">optional</span>}
            </div>
            <div className="truncate text-[11px] text-t3">{slot.nodes?.length ? slot.nodes.join(', ') : slot.type}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Problems({ template, types }: { template: TemplateDetail; types: Record<string, NodeTypeInfo> }) {
  if (template.usable) return null;
  return (
    <div role="alert" className="flex flex-col gap-1.5 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[12px] text-rd">
      <div className="font-semibold">This template can’t be used here</div>
      <ul className="flex flex-col gap-1">
        {template.problems.map((p) => (
          <li key={`${p.kind}:${p.nodeType}`} className="flex items-start gap-1.5">
            {p.kind === 'blocked' ? <Ban className="mt-0.5 size-3 shrink-0" /> : <PackageX className="mt-0.5 size-3 shrink-0" />}
            <span>
              {p.message}
              {p.kind === 'blocked' && types[p.nodeType]?.blocked ? ` (${types[p.nodeType].blocked})` : ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="text-rd/80">
        {template.problems.some((p) => p.kind === 'missing') ? 'Install the plugin from the Marketplace, then come back.' : 'An owner or admin can change this in Settings → Governance.'}
      </div>
    </div>
  );
}

export function TemplateView({ id }: { id: string }) {
  const router = useRouter();
  const folder = useSearchParams().get('folder') ?? undefined;
  const { template, error } = useTemplateDetail(id);
  const types = useNodeTypeMap();
  const [using, setUsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const back = (
    <Link href={`/templates${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`} className="inline-flex items-center gap-1 text-t3 hover:text-t1">
      <ChevronLeft className="size-4" /> Templates
    </Link>
  );

  if (error)
    return (
      <>
        <PageHeader title={back} />
        <PageBody>
          <Card className="py-6">
            <EmptyState compact title={error.status === 404 ? 'Template not found' : 'Couldn’t load this template'} hint={error.status === 404 ? 'It may have been deleted.' : error.message} />
          </Card>
        </PageBody>
      </>
    );

  if (!template)
    return (
      <>
        <PageHeader title={back} />
        <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="h-[440px] animate-pulse-soft rounded-2xl bg-wl" />
          <div className="h-[440px] animate-pulse-soft rounded-2xl bg-wl" />
        </PageBody>
      </>
    );

  const remove = async () => {
    setDeleting(true);
    try {
      await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' });
      toast.success(`Deleted “${template.name}”`);
      router.push('/templates');
    } catch (e) {
      toast.error((e as Error).message);
      setDeleting(false);
    }
  };

  const download = () =>
    downloadTemplate(template)
      .then((name) => toast(`Downloaded ${name}`))
      .catch((e: Error) => toast.error(e.message));

  return (
    <>
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            {back}
            <span className="text-t3">/</span>
            <span className="truncate">{template.name}</span>
          </span>
        }
        actions={
          <>
            {template.source === 'local' &&
              (confirmDelete ? (
                <Button size="sm" variant="danger" onClick={() => void remove()} loading={deleting} onBlur={() => setConfirmDelete(false)} autoFocus>
                  Delete template?
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete template">
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              ))}
            <Button size="sm" variant="ghost" onClick={() => void download()} title="Download as a template file to import on another instance">
              <Download className="size-3.5" /> Export
            </Button>
            <Button variant="primary" size="sm" onClick={() => setUsing(true)} disabled={!template.usable} title={template.usable ? undefined : template.problems.map((p) => p.message).join('\n')}>
              <LayoutTemplate className="size-3.5" /> Use template
            </Button>
          </>
        }
      />
      <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="h-[440px] overflow-hidden p-0">
            <ExecutionCanvas workflow={template.workflow} nodeTypes={types} runData={NO_RUN_DATA} />
          </Card>
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <TemplateNodeIcons nodeTypes={template.nodeTypes} types={types} size="md" />
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <ProblemBadge template={template} />
                <SourceBadge template={template} />
                {template.categories.map((c) => (
                  <Chip key={c}>{categoryName(c)}</Chip>
                ))}
              </span>
            </div>
            {template.description ? <Markdown text={template.description} className="text-[13px] leading-relaxed text-t1" /> : <p className="text-[13px] text-t3">No description.</p>}
            <div className="text-[12px] text-t3">
              {[
                template.author && `By ${template.author}`,
                `${template.nodeCount} node${template.nodeCount === 1 ? '' : 's'}`,
                template.workflow.groups?.length && `${template.workflow.groups.length} group${template.workflow.groups.length === 1 ? '' : 's'}`,
                template.createdAt && `added ${timeAgo(template.createdAt)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </Card>
          {template.report && (
            <Card className="flex flex-col gap-2">
              <SectionLabel>Import report</SectionLabel>
              <ImportReportView report={template.report} />
            </Card>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <Problems template={template} types={types} />
          <Card className="flex flex-col gap-2.5">
            <SectionLabel>Setup</SectionLabel>
            {template.setup.length ? (
              <ol className="flex flex-col gap-2.5">
                {template.setup.map((step, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full border border-acbd bg-acdim font-mono text-[11px] font-semibold text-ac">{i + 1}</span>
                    <Markdown text={step} className="min-w-0 flex-1 text-[12px] leading-snug text-t2" />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12px] text-t3">No setup steps: use it and run it.</p>
            )}
          </Card>
          <Card className="flex flex-col gap-2.5">
            <SectionLabel>
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="size-3.5" /> Credentials
              </span>
            </SectionLabel>
            <Credentials template={template} />
          </Card>
          {template.dataTables.length > 0 && (
            <Card className="flex flex-col gap-2.5">
              <SectionLabel>
                <span className="inline-flex items-center gap-1.5">
                  <Table2 className="size-3.5" /> Data tables
                </span>
              </SectionLabel>
              <ul className="flex flex-col gap-1.5 text-[12px]">
                {template.dataTables.map((t) => (
                  <li key={t.name}>
                    <span className="font-semibold text-t1">{t.name}</span>
                    <span className="text-t3"> · {t.columns.map((c) => c.name).join(', ') || 'no columns'}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-t3">Created when you use the template, unless a table with that name exists.</p>
            </Card>
          )}
        </aside>
      </PageBody>
      {using && <UseTemplateDialog template={template} folderId={folder} onClose={() => setUsing(false)} />}
    </>
  );
}
