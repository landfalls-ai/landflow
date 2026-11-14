'use client';
/** A session's timeline: chat bubbles, expandable tool calls, approvals, errors. Shared by the test chat and the Sessions tab. */
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Ban, Bot, Check, ChevronRight, Copy, ExternalLink, Hand, Info, Loader2, RadioTower, ShieldAlert, ThumbsDown, ThumbsUp, TriangleAlert, User, Waypoints, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { duration } from '@/lib/client/format';
import { nodeColor, tint } from '@/lib/client/node-style';
import type { RemoteRun, TimelineEntry, ToolKind } from '@/lib/shared/agents';
import type { ChatFeedback, FeedbackRating } from '@/lib/shared/chat-feedback';
import { Button } from '../ui/button';
import { AssistantRow, ChatError, ChatMarkdown, ReplyMeta, UserBubble, type ReplyInfo } from '../ui/chat';
import { ActivityTrace } from '../ui/activity-trace';
import type { ActivityKind, ActivityStep } from '@/lib/shared/activity';
import { NodeIcon } from '../ui/icon';
import { JsonView } from '../ui/json-view';
import { shortArg, snippetOf } from '@/lib/client/node-progress';
import { useNodeTypes } from './use-agent-data';

export type ToolEntry = Extract<TimelineEntry, { type: 'tool' }>;

/** A run's OpenTelemetry trace id: copyable, and a link when a URL is known. */
export function TraceChip({ traceId, url }: { traceId: string; url?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(traceId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy the trace id'),
    );
  };
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-hair py-px pl-2 pr-0.5 text-[12px] text-t2" title={`Trace ${traceId}`}>
      <Waypoints className="size-3 shrink-0" />
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-t2 hover:text-t1" title="Open the trace">
          {traceId.slice(0, 12)}…
          <ExternalLink className="size-3" />
        </a>
      ) : (
        <span className="font-mono text-t3">{traceId.slice(0, 12)}…</span>
      )}
      <button
        onClick={copy}
        aria-label="Copy trace id"
        title="Copy trace id"
        className="grid size-5 place-items-center rounded-full text-t3 transition-colors hover:bg-acdim hover:text-t1"
      >
        {copied ? <Check className="size-3 text-gn" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}


const STEP_KIND: Record<ToolKind, ActivityKind> = { node: 'tool', workflow: 'run', agent: 'tool', skill: 'read', memory: 'think', a2a: 'tool', flow: 'run', notebook: 'write' };

/** A tool row as a step of the activity trace: what it is called, how it ended, how long it took, a line of what came back. */
export function toolStep(entry: ToolEntry): ActivityStep {
  const status: ActivityStep['status'] = entry.status === 'success' ? 'ok' : entry.status === 'error' || entry.status === 'denied' ? 'failed' : 'running';
  const detail = entry.error ?? (entry.status === 'denied' ? 'Denied' : snippetOf(entry.output, 300));
  return { id: entry.id, label: entry.label, kind: STEP_KIND[entry.kind] ?? 'tool', status, ...(entry.durationMs !== undefined && { durationMs: entry.durationMs }), ...(detail && { detail }) };
}

/**
 * What the footer under the reply at `index` says: the model, how long the turn took (from what the person said to the
 * reply), the tool calls of the turn as steps, tokens and cost. Parts that are not known are left out.
 */
export function replyInfo(entries: TimelineEntry[], index: number): ReplyInfo {
  const reply = entries[index];
  if (reply?.type !== 'assistant') return {};
  let start = index - 1;
  while (start >= 0 && entries[start].type !== 'user') start--;
  const asked = start >= 0 ? Date.parse(entries[start].at) : NaN;
  const answered = Date.parse(reply.at);
  const durationMs = Number.isFinite(asked) && Number.isFinite(answered) && answered >= asked ? answered - asked : undefined;
  const steps = entries.slice(start + 1, index).filter((e) => e.type === 'tool').length;
  return {
    ...(reply.model && { model: reply.model, ...(reply.model.startsWith('ollama/') && { local: true }) }),
    ...(durationMs !== undefined && { durationMs }),
    ...(steps > 0 && { steps }),
    ...(reply.usage && { inputTokens: reply.usage.inputTokens, outputTokens: reply.usage.outputTokens }),
    ...(reply.usage?.costUsd !== undefined && { costUsd: reply.usage.costUsd }),
  };
}

/** The steps of a run of tool calls, and the time they took together when every call says how long it took. */
export function traceOf(tools: ToolEntry[]): { steps: ActivityStep[]; durationMs?: number } {
  const steps = tools.map(toolStep);
  const known = steps.filter((s) => s.durationMs !== undefined);
  return { steps, ...(known.length === steps.length && steps.length > 0 && { durationMs: known.reduce((n, s) => n + (s.durationMs ?? 0), 0) }) };
}

export interface TimelineProps {
  entries: TimelineEntry[];
  /** A running tool call's live steps from elsewhere (the execution view: a sub-node's `node.progress`). */
  liveSteps?: (entry: ToolEntry) => RemoteRun | undefined;
  childHref?: (entry: ToolEntry) => string | undefined;
  onDecide?: (callId: string, approved: boolean) => void;
  deciding?: boolean;
  /** Wider bubbles, for the Sessions tab. */
  wide?: boolean;
  /** Ratings by assistant entry id, and the handler that rates a reply (null takes it back); both given: thumbs under each reply. */
  feedback?: Record<string, ChatFeedback>;
  onRate?: (entryId: string, rating: FeedbackRating | null) => void;
  /**
   * The chat kit's look: a run of tool calls is one activity line that opens into its steps (a call waiting for approval
   * stays a full row). `running` while the run is live; `traceUrl` becomes the last line's "Open trace".
   */
  trace?: { running: boolean; traceUrl?: string };
}

const KIND_ICON: Record<ToolKind, string> = {
  node: 'wrench',
  workflow: 'workflow',
  agent: 'bot',
  skill: 'book-open',
  memory: 'brain',
  a2a: 'radio-tower',
  flow: 'plug',
  notebook: 'notebook-pen',
};

const A2A_COLOR = '#a855f7';

export function useToolIcon() {
  const nodeTypes = useNodeTypes();
  return (entry: Pick<ToolEntry, 'kind' | 'nodeType'>) => {
    if (entry.kind === 'node' && entry.nodeType) {
      const info = nodeTypes?.[entry.nodeType];
      return {
        icon: info?.descriptor.icon ?? KIND_ICON.node,
        color: nodeColor(info),
      };
    }
    return {
      icon: KIND_ICON[entry.kind] ?? 'wrench',
      color: entry.kind === 'agent' ? 'var(--ac)' : entry.kind === 'a2a' ? A2A_COLOR : 'var(--t2)',
    };
  };
}

export function ToolStatusIcon({ status, className }: { status: ToolEntry['status']; className?: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className={cn('size-3.5 animate-spin text-ac', className)} aria-label="Running" />;
    case 'success':
      return <Check className={cn('size-3.5 text-gn animate-pop', className)} aria-label="Succeeded" />;
    case 'error':
      return <X className={cn('size-3.5 text-rd animate-pop', className)} aria-label="Failed" />;
    case 'awaiting_approval':
      return <Hand className={cn('size-3.5 text-warn animate-pulse-soft', className)} aria-label="Waiting for approval" />;
    case 'denied':
      return <Ban className={cn('size-3.5 text-t3', className)} aria-label="Denied" />;
  }
}

/** What a remote (A2A) agent did during the call: its tool calls as they happen, each expandable, and its token usage. */
export function RemoteSteps({ remote }: { remote: RemoteRun }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!remote.steps.length && !remote.usage) return null;
  return (
    <div className="border-t border-hair px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-t3">
        <RadioTower className="size-3 shrink-0" style={{ color: A2A_COLOR }} />
        <span className="font-semibold text-t2">{remote.agent}</span>
        <span>{remote.state}</span>
        {remote.usage && (
          <span className="ml-auto font-mono" title="Tokens the remote agent reports using">
            {remote.usage.inputTokens.toLocaleString()} in · {remote.usage.outputTokens.toLocaleString()} out
          </span>
        )}
      </div>
      {remote.steps.length > 0 && (
        <ol className="space-y-0.5">
          {remote.steps.map((step) => {
            const ms = step.startedAt && step.endedAt ? Date.parse(step.endedAt) - Date.parse(step.startedAt) : undefined;
            const expanded = open === step.id;
            return (
              <li key={step.id}>
                <button
                  onClick={() => setOpen(expanded ? null : step.id)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left hover:bg-acdim"
                >
                  <ChevronRight className={cn('size-3 shrink-0 text-t3 transition-transform', expanded && 'rotate-90')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1">
                    {step.name}
                    {shortArg(step.args) && <span className="ml-1.5 text-t3">{shortArg(step.args)}</span>}
                    {!expanded && step.status !== 'running' && (step.error ?? snippetOf(step.output, 80)) && (
                      <span className={cn('ml-1.5 text-[11px]', step.error ? 'text-rd' : 'text-t3')}>→ {snippetOf(step.error ?? step.output, 80)}</span>
                    )}
                  </span>
                  {ms !== undefined && Number.isFinite(ms) && <span className="font-mono text-[11px] text-t3">{duration(ms)}</span>}
                  <ToolStatusIcon status={step.status} className="size-3" />
                </button>
                {expanded && (
                  <div className="ml-5 mt-1 space-y-1.5 animate-in">
                    {step.args && (
                      <div className="max-h-40 overflow-auto rounded-lg border border-hair bg-wl px-2 py-1">
                        <JsonView value={step.args} />
                      </div>
                    )}
                    {step.error ? (
                      <div className="whitespace-pre-wrap rounded-lg border border-rdbd bg-rddim px-2.5 py-1.5 font-mono text-[12px] text-rd [overflow-wrap:anywhere]">{step.error}</div>
                    ) : step.output !== undefined ? (
                      <div className="max-h-48 overflow-auto rounded-lg border border-hair bg-wl px-2 py-1">
                        {typeof step.output === 'string' ? (
                          <div className="whitespace-pre-wrap py-1 font-mono text-[12px] text-t1 [overflow-wrap:anywhere]">{step.output}</div>
                        ) : (
                          <JsonView value={step.output} />
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function ToolRow({
  entry,
  childHref,
  onDecide,
  deciding,
  live,
}: {
  entry: ToolEntry;
  /** The tool is a workflow sub-node reporting progress (no `remote` of its own): its steps so far. */
  live?: RemoteRun;
  childHref?: (entry: ToolEntry) => string | undefined;
  onDecide?: (callId: string, approved: boolean) => void;
  deciding?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const iconOf = useToolIcon();
  const { icon, color } = iconOf(entry);
  const child = entry.childSessionId ? childHref?.(entry) : undefined;
  const waiting = entry.status === 'awaiting_approval';
  return (
    <div
      className={cn('overflow-hidden rounded-xl border bg-sf animate-in', waiting ? 'border-warnbd' : entry.status === 'error' ? 'border-rdbd' : 'border-hair')}
    >
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-acdim">
        <ChevronRight className={cn('size-3 shrink-0 text-t3 transition-transform', open && 'rotate-90')} />
        <span className="grid size-5 shrink-0 place-items-center rounded-md border border-hair" style={{ background: tint(color, 12) }}>
          <NodeIcon icon={icon} size={11} style={{ color }} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-t1">
          {entry.label}
          {entry.label !== entry.tool && <span className="ml-1.5 font-mono text-[11px] font-normal text-t3">{entry.tool}</span>}
        </span>
        {entry.status === 'denied' && <span className="text-[11px] text-t3">Denied</span>}
        {entry.durationMs !== undefined && <span className="font-mono text-[11px] text-t3">{duration(entry.durationMs)}</span>}
        <ToolStatusIcon status={entry.status} />
      </button>
      {(entry.remote ?? (entry.status === 'running' ? live : undefined)) && <RemoteSteps remote={(entry.remote ?? live)!} />}
      {waiting && (
        <div className="border-t border-warnbd bg-warndim px-3 py-2.5">
          <div className="flex items-start gap-2 text-[12px] text-warn">
            <Hand className="mt-px size-3.5 shrink-0" />
            {entry.approval ? (
              <span>
                <strong>{entry.approval.message}</strong>. It waits until someone approves.
              </span>
            ) : (
              <span>
                The agent wants to run <strong>{entry.label}</strong>. It waits until someone approves.
              </span>
            )}
          </div>
          {!open && !entry.approval && Object.keys(entry.input ?? {}).length > 0 && (
            <div className="mt-2 max-h-40 overflow-auto rounded-lg border border-hair bg-sf px-2 py-1">
              <JsonView value={entry.input} />
            </div>
          )}
          {entry.approval &&
            entry.remote?.steps
              .filter((step) => step.status === 'awaiting_approval' && step.args)
              .map((step) => (
                <div key={step.id} className="mt-2 max-h-40 overflow-auto rounded-lg border border-hair bg-sf px-2 py-1">
                  <div className="pt-1 font-mono text-[11px] text-t3">{step.name}</div>
                  <JsonView value={step.args} />
                </div>
              ))}
          {onDecide && (
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" className="max-md:min-h-11" loading={deciding} onClick={() => onDecide(entry.callId, true)}>
                {!deciding && <Check className="size-3.5" />} Approve
              </Button>
              <Button size="sm" variant="outline" className="max-md:min-h-11" disabled={deciding} onClick={() => onDecide(entry.callId, false)}>
                <Ban className="size-3.5" /> Deny
              </Button>
            </div>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-hair px-3 py-2.5 animate-in">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Input</div>
            <div className="max-h-60 overflow-auto rounded-lg border border-hair bg-wl px-2 py-1">
              <JsonView value={entry.input ?? {}} />
            </div>
          </div>
          {entry.error ? (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Error</div>
              <div className="whitespace-pre-wrap rounded-lg border border-rdbd bg-rddim px-2.5 py-1.5 font-mono text-[12px] text-rd [overflow-wrap:anywhere]">
                {entry.error}
              </div>
            </div>
          ) : entry.output !== undefined ? (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Output</div>
              <div className="max-h-72 overflow-auto rounded-lg border border-hair bg-wl px-2 py-1">
                {typeof entry.output === 'string' ? (
                  <div className="whitespace-pre-wrap py-1 font-mono text-[12px] text-t1 [overflow-wrap:anywhere]">{entry.output}</div>
                ) : (
                  <JsonView value={entry.output} />
                )}
              </div>
            </div>
          ) : null}
          {(entry.executionId || entry.childSessionId) && (
            <div className="flex flex-wrap gap-3 text-[12px]">
              {entry.executionId && (
                <Link
                  href={
                    entry.workflowId
                      ? `/workflows/${encodeURIComponent(entry.workflowId)}/executions/${encodeURIComponent(entry.executionId)}`
                      : `/executions?id=${encodeURIComponent(entry.executionId)}`
                  }
                  className="inline-flex items-center gap-1 text-ac hover:underline"
                >
                  <ExternalLink className="size-3" /> Open execution
                </Link>
              )}
              {entry.childSessionId &&
                (child ? (
                  <Link href={child} className="inline-flex items-center gap-1 text-ac hover:underline">
                    <Bot className="size-3" /> Open sub-agent session
                  </Link>
                ) : (
                  <span className="font-mono text-t3" title="Sub-agent session">
                    {entry.childSessionId}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The timeline as keyed items, for a list that animates each one (ChatList) or a plain stack (TimelineView). */
export function timelineItems({ entries, childHref, onDecide, deciding, wide, feedback, onRate, liveSteps, trace }: TimelineProps): ReactNode[] {
  // The Sessions tab is wide: a reply keeps a readable line length.
  const measure = wide ? 'max-w-[680px]' : undefined;
  const items: ReactNode[] = [];
  let group: ToolEntry[] = [];
  const flush = (last: boolean) => {
    if (!group.length) return;
    const { steps, durationMs } = traceOf(group);
    const live = !!trace?.running && last;
    items.push(
      <div key={`trace-${group[0].id}`} className={cn('pl-7', measure)}>
        <ActivityTrace steps={steps} live={live} durationMs={durationMs} {...(last && trace?.traceUrl && { traceUrl: trace.traceUrl })} />
      </div>,
    );
    group = [];
  };
  entries.forEach((entry, index) => {
    if (trace && entry.type === 'tool' && entry.status !== 'awaiting_approval') {
      group.push(entry);
      return;
    }
    flush(false);
    switch (entry.type) {
      case 'user':
        items.push(
          <UserBubble key={entry.id} from={entry.from && entry.from !== 'you' ? entry.from : undefined}>
            {entry.text}
          </UserBubble>,
        );
        break;
      case 'assistant':
        items.push(
          <AssistantRow key={entry.id} mark={<Bot className="size-3.5" />} className={measure}>
            <ChatMarkdown text={entry.text} />
            <ReplyMeta info={replyInfo(entries, index)} copy={entry.text}>
              {onRate && (
                <span className="flex items-center gap-0.5 font-sans">
                  {(['up', 'down'] as const).map((rating) => {
                    const on = feedback?.[entry.id]?.rating === rating;
                    const Icon = rating === 'up' ? ThumbsUp : ThumbsDown;
                    return (
                      <button
                        key={rating}
                        onClick={() => onRate(entry.id, on ? null : rating)}
                        aria-pressed={on}
                        aria-label={rating === 'up' ? 'Good reply' : 'Bad reply'}
                        title={rating === 'up' ? 'Good reply' : 'Bad reply'}
                        className={cn('grid size-6 place-items-center rounded-full transition-colors hover:bg-wl max-md:size-11', on ? (rating === 'up' ? 'text-gn' : 'text-rd') : 'text-t3 hover:text-t1')}
                      >
                        <Icon className="size-3" />
                      </button>
                    );
                  })}
                  {feedback?.[entry.id]?.comment && <span className="truncate text-[11px] text-t3" title={feedback[entry.id].comment}>“{feedback[entry.id].comment}”</span>}
                </span>
              )}
            </ReplyMeta>
          </AssistantRow>,
        );
        break;
      case 'tool':
        items.push(
          <div key={entry.id} className={cn('pl-7', !wide && 'pr-1', measure)}>
            <ToolRow entry={entry} childHref={childHref} onDecide={onDecide} deciding={deciding} live={liveSteps?.(entry)} />
          </div>,
        );
        break;
      case 'error':
        items.push(
          <div key={entry.id} className={cn('pl-7', measure)}>
            <ChatError message={entry.message} />
          </div>,
        );
        break;
      case 'guardrail':
        items.push(
          <div key={entry.id} className={cn('pl-7', !wide && 'pr-1', measure)}>
            <div className="animate-in rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[12.5px] leading-snug text-t1">
              <div className="flex items-center gap-1.5 font-semibold">
                <ShieldAlert className="size-3.5 shrink-0 text-warn" />
                {entry.stage === 'input' ? 'Input' : entry.stage === 'tool' ? 'Tool result' : 'Output'} guardrail {entry.action}
              </div>
              <ul className="mt-1 space-y-0.5 text-t2">
                {entry.violations.map((v, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    <span className="font-mono text-[11.5px]">{v.check}</span> · {v.type}
                    {v.match ? <span className="font-mono text-[11.5px]"> {v.match}</span> : null}
                    {v.confidence !== undefined ? ` (${Math.round(v.confidence * 100)}%)` : ''}
                    {v.reason ? ` — ${v.reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </div>,
        );
        break;
      case 'notice':
        items.push(
          <div key={entry.id} className="flex animate-in items-center justify-center gap-1.5 px-6 text-center text-[12px] text-t3">
            <Info className="size-3 shrink-0" />
            {entry.message}
          </div>,
        );
        break;
    }
  });
  flush(true);
  return items;
}

export function TimelineView(props: TimelineProps) {
  return <div className="space-y-3">{timelineItems(props)}</div>;
}
