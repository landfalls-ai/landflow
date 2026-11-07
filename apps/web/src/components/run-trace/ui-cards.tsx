'use client';
/**
 * Run Trace cards drawn from a model-written spec with json-render (docs/research/json-render-verdict.md), behind the
 * json-render setting. The spec is validated first (lib/shared/ui-spec.ts); only the result reaches the renderer.
 * The provider is mounted with no handlers, navigate, functions or directives, so the spec cannot trigger anything; an unknown component is dropped
 * and the card says so in plain text. One column, cards not tables.
 */
import { defineCatalog } from '@json-render/core';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { schema } from '@json-render/react/schema';
import { Check, CircleAlert, Clock, Loader2, ShieldQuestion } from 'lucide-react';
import { approvalProps, CARD_DESCRIPTIONS, diffProps, parseUiSpec, statusProps } from '@/lib/shared/ui-spec';
import { cn } from '@/lib/utils';
import { useJsonRender } from './use-json-render';

export const catalog = defineCatalog(schema, {
  components: {
    Status: { props: statusProps, description: CARD_DESCRIPTIONS.Status },
    Diff: { props: diffProps, description: CARD_DESCRIPTIONS.Diff },
    Approval: { props: approvalProps, description: CARD_DESCRIPTIONS.Approval },
  },
  actions: {},
});

const shell = 'flex flex-col gap-1.5 rounded-xl border border-hair bg-bg p-3';
const TONE = { ok: 'text-gn', warn: 'text-warn', bad: 'text-rd', neutral: 'text-t2' } as const;
const STATUS_TONE = { queued: 'neutral', running: 'neutral', succeeded: 'ok', failed: 'bad', waiting: 'warn' } as const;
const STATUS_ICON = { queued: Clock, running: Loader2, succeeded: Check, failed: CircleAlert, waiting: Clock } as const;

export const { registry } = defineRegistry(catalog, {
  components: {
    Status: ({ props }) => {
      const tone = TONE[props.tone ?? STATUS_TONE[props.status]];
      const Icon = STATUS_ICON[props.status];
      return (
        <div className={shell}>
          <div className="flex items-center gap-2">
            <Icon className={cn('size-4 shrink-0', tone, props.status === 'running' && 'animate-spin')} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-t1">{props.title}</span>
            <span className={cn('text-[12px] font-medium', tone)}>{props.status}</span>
          </div>
          {props.detail && <p className="text-[12.5px] text-t2">{props.detail}</p>}
        </div>
      );
    },
    Diff: ({ props }) => (
      <div className={shell}>
        <span className="truncate font-mono text-[12px] text-t2">{props.path}</span>
        <pre className="max-h-72 overflow-auto rounded-lg border border-hair font-mono text-[11.5px] leading-5">
          {props.lines.map((l, i) => (
            <div key={i} className={cn('whitespace-pre px-2', l.kind === 'add' ? 'bg-gndim text-gn' : l.kind === 'del' ? 'bg-rddim text-rd' : 'text-t2')}>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} {l.text}
            </div>
          ))}
        </pre>
      </div>
    ),
    Approval: ({ props }) => (
      <div className={shell}>
        <div className="flex items-center gap-2">
          <ShieldQuestion className="size-4 shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-[13.5px] font-semibold text-t1">{props.title}</span>
          {props.risk && <span className={cn('text-[12px] font-medium', props.risk === 'high' ? 'text-rd' : props.risk === 'medium' ? 'text-warn' : 'text-gn')}>{props.risk} risk</span>}
        </div>
        <p className="text-[12.5px] text-t2">{props.summary}</p>
        <p className="text-[11.5px] text-t3">Decide it in the run&apos;s approval card{props.approvalId ? ` (${props.approvalId})` : ''}. This card cannot approve.</p>
      </div>
    ),
  },
});

/**
 * One card from an untrusted spec (an object or JSON text). Renders nothing unless json-render is on: `enabled` when the
 * caller already knows it, else the host's setting (useJsonRender).
 */
export function SpecCard({ spec, className, enabled }: { spec: unknown; className?: string; enabled?: boolean }) {
  const reported = useJsonRender(enabled !== undefined);
  if (!(enabled ?? reported)) return null;
  const { spec: safe, problems } = parseUiSpec(spec);
  return (
    <div className={className} data-testid="spec-card">
      {safe ? <JSONUIProvider registry={registry}><Renderer spec={safe} registry={registry} fallback={() => null} /></JSONUIProvider> : <p className="text-[12.5px] text-t3">This card could not be shown.</p>}
      {problems.length > 0 && <p className="mt-1 text-[11px] text-t3">Ignored: {problems.join('; ')}</p>}
    </div>
  );
}

const card = (type: string, props: Record<string, unknown>) => ({ root: 'c', elements: { c: { type, props } } });
export const GALLERY: { label: string; spec: unknown }[] = [
  { label: 'Status', spec: card('Status', { title: 'Build plugin', status: 'running', detail: 'Step 3 of 5: running the tests.' }) },
  { label: 'Diff', spec: card('Diff', { path: 'src/greet.ts', lines: [{ kind: 'ctx', text: 'export function greet(name) {' }, { kind: 'del', text: "  return 'hi ' + name;" }, { kind: 'add', text: '  return `Hello, ${name}!`;' }, { kind: 'ctx', text: '}' }] }) },
  { label: 'Approval', spec: card('Approval', { title: 'Run git push', summary: 'The Tech Lead wants to push branch plugin/greet to origin.', approvalId: 'wait-42', risk: 'medium' }) },
  { label: 'Unknown component (ignored)', spec: card('Script', { code: 'alert(1)' }) },
  { label: 'Malicious props (rejected)', spec: card('Status', { title: { $state: '/secrets' }, status: 'ok', onClick: 'alert(1)', href: 'javascript:alert(1)' }) },
];

/** The dev gallery: the three cards, then what an unknown component and malicious props do. Shown at /runs/json-render-gallery when json-render is on (Settings → General). */
export function JsonRenderGallery() {
  const on = useJsonRender();
  if (!on) return null;
  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 p-3">
      <h1 className="text-[15px] font-semibold text-t1">json-render cards (dev)</h1>
      {GALLERY.map((g) => (
        <section key={g.label} className="flex flex-col gap-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{g.label}</div>
          <SpecCard spec={g.spec} enabled />
        </section>
      ))}
    </div>
  );
}
