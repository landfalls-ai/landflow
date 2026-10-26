'use client';
/**
 * Settings → API: the public API from /api/openapi.json (lib/server/openapi.ts). How to authenticate with an API
 * key, a curl example built from this page's origin, the document itself to open or download, and every endpoint
 * by area with its method, path and the API key scope it needs; a row opens its parameters, body and responses.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, ChevronRight, Download, ExternalLink, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { Card } from '@/components/shell/page-header';
import { Badge, Chip, type Tone } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Input, SectionLabel } from '@/components/ui/inputs';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Method = (typeof METHODS)[number];

const METHOD_TONE: Record<Method, Tone> = { get: 'success', post: 'accent', put: 'warning', patch: 'warning', delete: 'danger' };

interface SchemaRef {
  $ref?: string;
  type?: string | string[];
  items?: SchemaRef;
}

interface Operation {
  operationId: string;
  tags: string[];
  summary: string;
  description?: string;
  /** Absent on public operations (the trigger URLs). */
  'x-landflow-scope'?: string;
  /** A trigger URL: no key or session, the trigger's own auth. */
  'x-landflow-public'?: boolean;
  'x-landflow-session-only'?: boolean;
  'x-landflow-role-action'?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: SchemaRef }> };
  responses: Record<string, { description?: string; $ref?: string; content?: Record<string, { schema?: SchemaRef }> }>;
}

interface OpenApiDoc {
  info: { title: string; version: string };
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Partial<Record<Method, Operation>>>;
}

interface Endpoint {
  method: Method;
  path: string;
  op: Operation;
}

const linkButton =
  'inline-flex h-7 items-center gap-1.5 rounded-full border border-bd px-[11px] text-[12px] font-semibold text-t1 transition-colors hover:border-ac hover:text-ac';

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-t2">{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} className="ml-auto" />
      </div>
      <pre className="overflow-x-auto rounded-[10px] border border-hair bg-wl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-t1">{text}</pre>
    </div>
  );
}

/** Text with `code` spans, as the document writes it. */
function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('space-y-1.5 text-[12px] leading-relaxed text-t2', className)}>
      {text.split('\n\n').map((paragraph, i) => (
        <p key={i}>
          {paragraph.split('`').map((part, j) =>
            j % 2 ? (
              <code key={j} className="font-mono text-[11px] text-t1">
                {part}
              </code>
            ) : (
              <Fragment key={j}>{part}</Fragment>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

/** `#/components/schemas/Workflow` → Workflow; an array of them → Workflow[]. */
function schemaName(schema?: SchemaRef): string | undefined {
  if (!schema) return undefined;
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array') return schema.items ? `${schemaName(schema.items) ?? 'item'}[]` : 'array';
  return Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
}

function ScopeChip({ op }: { op: Operation }) {
  if (op['x-landflow-public']) return <Chip tone="muted">public</Chip>;
  if (op['x-landflow-session-only']) return <Chip tone="warning">session only</Chip>;
  const scope = op['x-landflow-scope'];
  return (
    <Chip mono tone={scope === 'any' ? 'muted' : 'neutral'}>
      {scope === 'any' ? 'any key' : scope}
    </Chip>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <div className="pt-px text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</div>
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

function EndpointRow({ endpoint, open, onToggle }: { endpoint: Endpoint; open: boolean; onToggle: () => void }) {
  const { method, path, op } = endpoint;
  const body = op.requestBody?.content;
  const responses = Object.entries(op.responses).filter(([code]) => code !== '401' && code !== '403');
  return (
    <div className="border-b border-hair last:border-b-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-wl">
        <ChevronRight className={cn('size-3.5 shrink-0 text-t3 transition-transform', open && 'rotate-90')} />
        <Badge tone={METHOD_TONE[method]} className="w-[60px] justify-center font-mono uppercase">
          {method}
        </Badge>
        <span className="min-w-0 truncate font-mono text-[12px] text-t1">{path}</span>
        <span className="hidden min-w-0 flex-1 truncate text-[12px] text-t3 md:block">{op.summary}</span>
        <span className="ml-auto shrink-0">
          <ScopeChip op={op} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-hair bg-sf2 px-4 py-3 pl-11 animate-fade-up">
          <div className="text-[13px] font-semibold text-t1">{op.summary}</div>
          {op.description && <Prose text={op.description} />}
          {!!op.parameters?.length && (
            <Detail label="Parameters">
              {op.parameters.map((p) => (
                <div key={`${p.in}:${p.name}`} className="text-[12px] text-t2">
                  <span className="font-mono text-t1">{p.name}</span> <span className="text-t3">({p.in}{p.required ? ', required' : ''})</span>
                  {p.description && <> · {p.description}</>}
                </div>
              ))}
            </Detail>
          )}
          {body && (
            <Detail label="Body">
              {Object.entries(body).map(([type, media]) => (
                <div key={type} className="text-[12px] text-t2">
                  <span className="font-mono text-t1">{schemaName(media.schema) ?? 'object'}</span> <span className="text-t3">({type}{op.requestBody?.required === false ? ', optional' : ''})</span>
                </div>
              ))}
            </Detail>
          )}
          <Detail label="Responses">
            {responses.map(([code, response]) => {
              const media = response.content && Object.entries(response.content)[0];
              return (
                <div key={code} className="text-[12px] text-t2">
                  <span className="font-mono text-t1">{code}</span> {response.description}
                  {media && schemaName(media[1].schema) && <span className="font-mono text-[11px] text-t3"> · {schemaName(media[1].schema)}</span>}
                </div>
              );
            })}
          </Detail>
          <div className="font-mono text-[11px] text-t3">operationId: {op.operationId}</div>
        </div>
      )}
    </div>
  );
}

export function ApiDocs() {
  const [doc, setDoc] = useState<OpenApiDoc>();
  const [error, setError] = useState<string>();
  const [origin, setOrigin] = useState('http://localhost:3000');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string>();

  useEffect(() => {
    setOrigin(window.location.origin);
    api<OpenApiDoc>('/api/openapi.json')
      .then(setDoc)
      .catch((e: Error) => setError(e.message));
  }, []);

  const groups = useMemo(() => {
    if (!doc) return [];
    const q = query.trim().toLowerCase();
    const endpoints = Object.entries(doc.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((method) => ({ method, path, op: item[method]! })));
    const shown = q ? endpoints.filter((e) => `${e.method} ${e.path} ${e.op.summary}`.toLowerCase().includes(q)) : endpoints;
    return (doc.tags ?? []).map((tag) => ({ ...tag, endpoints: shown.filter((e) => e.op.tags.includes(tag.name)) })).filter((g) => g.endpoints.length);
  }, [doc, query]);

  if (!doc) {
    return error ? (
      <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>
    ) : (
      <div className="h-36 rounded-2xl border border-hair bg-sf animate-pulse-soft" />
    );
  }

  const list = `curl ${origin}/api/workflows \\\n  -H "Authorization: Bearer $LANDFLOW_API_KEY"`;
  const execute = `curl -X POST ${origin}/api/workflows/<workflow-id>/execute \\\n  -H "X-Landflow-API-Key: $LANDFLOW_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"input": {"hello": "world"}}'`;

  return (
    <div className="space-y-4">
      <Card className="space-y-4 px-5 py-4">
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>{doc.info.title}</SectionLabel>
          <span className="font-mono text-[11px] text-t3">v{doc.info.version}</span>
          <div className="ml-auto flex items-center gap-2">
            <a href="/api/openapi.json" target="_blank" rel="noreferrer" className={linkButton}>
              <ExternalLink className="size-3.5" /> Open
            </a>
            <a href="/api/openapi.json" download="landflow-openapi.json" className={linkButton}>
              <Download className="size-3.5" /> openapi.json
            </a>
          </div>
        </div>
        <p className="text-[13px] leading-relaxed text-t2">
          Build, run and inspect workflows from scripts, CI and coding agents. Create a key in Settings → API keys and send it as{' '}
          <span className="font-mono text-[12px] text-t1">Authorization: Bearer lf_…</span> or <span className="font-mono text-[12px] text-t1">X-Landflow-API-Key: lf_…</span>. A key
          acts as you, limited to its scopes (<span className="font-mono text-[12px] text-t1">admin</span> includes all of them); each endpoint below names the scope it needs.
          The OpenAPI 3.1 document works with code generators and API clients.
        </p>
        <Snippet label="List workflows" text={list} />
        <Snippet label="Start a workflow" text={execute} />
        <p className="text-[12px] text-t3">
          Set <span className="font-mono">LANDFLOW_API_KEY</span> to your key first. Errors are JSON <span className="font-mono">{'{ "error": "…" }'}</span>.
        </p>
      </Card>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter endpoints" className="pl-8" aria-label="Filter endpoints" />
      </div>

      {groups.map((group) => (
        <Card key={group.name} className="overflow-hidden">
          <div className="flex items-baseline gap-2 border-b border-hair px-4 py-3">
            <SectionLabel>{group.name}</SectionLabel>
            {group.description && <span className="truncate text-[12px] text-t3">{group.description}</span>}
            <span className="ml-auto text-[11px] text-t3">{group.endpoints.length}</span>
          </div>
          {group.endpoints.map((endpoint) => {
            const key = `${endpoint.method} ${endpoint.path}`;
            return <EndpointRow key={key} endpoint={endpoint} open={open === key} onToggle={() => setOpen(open === key ? undefined : key)} />;
          })}
        </Card>
      ))}
      {!groups.length && <p className="px-1 text-[13px] text-t3">No endpoint matches “{query}”.</p>}
    </div>
  );
}
