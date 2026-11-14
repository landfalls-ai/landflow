'use client';
/**
 * A setting that comes from environment variables, as one row: "SSO: not configured · How to set up ›". The variables
 * sit behind the link (a help-tip), not in a paragraph. `statusRow` is the pure part, so the words are tested.
 */
import type { ReactNode } from 'react';
import { CheckCircle2, CircleSlash, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HelpTip } from '@/components/ui/help-tip';

export interface StatusRowConfig {
  /** "SSO", "Email", "Queue mode". */
  label: string;
  configured: boolean;
  /** Words for the two states; the defaults are "configured" and "not configured". */
  on?: string;
  off?: string;
  /** Why the setting was rejected: the row then says "setting ignored" and shows this under it. */
  error?: string;
}

export interface StatusRowView {
  text: string;
  state: 'on' | 'off';
  /** The link's words. */
  help: string;
  error?: string;
}

export function statusRow(config: StatusRowConfig): StatusRowView {
  const state = config.configured ? 'on' : 'off';
  const word = config.error ? 'setting ignored' : config.configured ? (config.on ?? 'configured') : (config.off ?? 'not configured');
  return { text: `${config.label}: ${word}`, state, help: config.configured ? 'Details' : 'How to set up', ...(config.error && { error: config.error }) };
}

export function StatusRow({ config, children, helpLabel, className }: { config: StatusRowConfig; /** The variables and what they do. */ children: ReactNode; helpLabel?: string; className?: string }) {
  const view = statusRow(config);
  const Icon = view.state === 'on' ? CheckCircle2 : CircleSlash;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-2xl border border-hair bg-sf px-4 py-2.5 text-[13px]', className)} data-state={view.state}>
      <Icon className={cn('size-4 shrink-0', view.state === 'on' ? 'text-gn' : 'text-t3')} strokeWidth={1.8} aria-hidden />
      <span className="font-medium text-t1">{view.text}</span>
      <span className="text-t3 max-md:hidden" aria-hidden>
        ·
      </span>
      <HelpTip label={helpLabel ?? `${view.help}: ${config.label}`} title={config.label} text={`${view.help} ›`}>
        {children}
      </HelpTip>
      {view.error && <p role="alert" className="basis-full break-words pl-6 text-[12px] text-rd">{view.error}</p>}
    </div>
  );
}

/** Which transport kinds the list shows: the direct ones and brokers with a connection; the rest are only counted. */
export function listedKinds<K extends { kind: string; direct: boolean }>(kinds: readonly K[], connections: ReadonlyArray<{ kind: string }>): { listed: K[]; hidden: number } {
  const listed = kinds.filter((k) => k.direct || connections.some((c) => c.kind === k.kind));
  return { listed, hidden: kinds.length - listed.length };
}

export interface HealthIssue {
  message: string;
  labels: string[];
}

/** Failing things grouped by message: eleven kinds with the same error become one issue naming all eleven. */
export function groupIssues(items: ReadonlyArray<{ label: string; message?: string }>): HealthIssue[] {
  const byMessage = new Map<string, string[]>();
  for (const item of items) {
    if (!item.message) continue;
    byMessage.set(item.message, [...(byMessage.get(item.message) ?? []), item.label]);
  }
  return [...byMessage].map(([message, labels]) => ({ message, labels }));
}

/** One banner for the failures, however many things share them. */
export function IssueBanner({ issues, noun }: { issues: HealthIssue[]; noun: string }) {
  if (!issues.length) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <div className="min-w-0 space-y-1">
        {issues.map((issue) => (
          <p key={issue.message} className="break-words">
            {issue.labels.length === 1 ? issue.labels[0] : `${issue.labels.length} ${noun}`}: {issue.message}
            {issue.labels.length > 1 && <span className="block text-[12px] text-rd">{issue.labels.join(', ')}</span>}
          </p>
        ))}
      </div>
    </div>
  );
}
