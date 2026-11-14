'use client';
/**
 * The chat kit (docs/assistant.md#chat-surfaces): one look for every conversation with an AI in Landflow (Spotlight, the
 * editor's Chat, an agent's test chat and Sessions, the Agent architect, the brain). Your message is a bubble on the
 * right; a reply is text beside a small mark, written in Markdown; under a finished reply, what answered and how long it
 * took, with Copy. One message box, one way to say it is working, one error with Try again, one empty state.
 */
import { lazy, Suspense, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ArrowUp, Loader2, Sparkles, Square, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCost, formatTokens } from '@/lib/shared/ai-usage';
import { formatSeconds } from '@/lib/shared/activity';
import { CopyButton } from './copy-button';

const Markdown = lazy(() => import('../run-trace/doc-markdown'));

/** A header's icon button in a chat panel: 28 px, 44 px on a phone. */
export const CHAT_ICON_BUTTON = 'grid size-7 shrink-0 place-items-center rounded-full text-t3 transition-colors hover:bg-acdim hover:text-t1 max-md:size-11';

/**
 * A model's reply as it means it: "•" bullets are a list, and a single line break stays a break (Markdown would join the
 * lines). Code blocks are left as they are.
 */
export function chatText(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) => (i % 2 ? part : part.replace(/^(\s*)[•·▪]\s+/gm, '$1- ').replace(/([^\n])\n(?!\n|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/g, '$1  \n')))
    .join('');
}

/** A reply's text, as Markdown (bold, lists, code, links, tables); plain text while the renderer loads. */
export function ChatMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<div className={cn('whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]', className)}>{text}</div>}>
      <Markdown text={chatText(text)} chat className={cn('[overflow-wrap:anywhere]', className)} />
    </Suspense>
  );
}

/** What you wrote: a bubble on the right. `from` names someone else who wrote it (a teammate, a trigger). */
export function UserBubble({ children, from, className }: { children: ReactNode; from?: string; className?: string }) {
  return (
    <div className={cn('ml-auto flex w-fit max-w-[85%] animate-in flex-col items-end', className)}>
      {from && <span className="mb-0.5 text-[11px] text-t3">{from}</span>}
      <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-acdim px-3 py-1.5 text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** A reply: its mark (Spotlight's sparkle, an agent's avatar) and what it said and did. */
export function AssistantRow({ mark, children, className, title }: { mark?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={cn('flex animate-in gap-2', className)} title={title}>
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-viz-7">{mark ?? <Sparkles className="size-3.5" />}</span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** What answered and how, for the footer under a reply. Each part is left out when unknown. */
export interface ReplyInfo {
  model?: string;
  /** A local model (Ollama and the like): "local" stands in for the cost. */
  local?: boolean;
  durationMs?: number;
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** "model · 14.5 s · 10 steps · 1.6k tokens · ≈$0.004" (or "local" in place of the cost). */
export function replyInfoParts(info: ReplyInfo): string[] {
  const tokens = (info.inputTokens ?? 0) + (info.outputTokens ?? 0);
  return [
    info.model,
    info.durationMs !== undefined && formatSeconds(info.durationMs),
    info.steps ? `${info.steps} ${info.steps === 1 ? 'step' : 'steps'}` : undefined,
    tokens > 0 && `${formatTokens(tokens)} tokens`,
    info.local ? 'local' : info.costUsd ? `≈${formatCost(info.costUsd)}` : undefined,
  ].filter((p): p is string => typeof p === 'string' && p !== '');
}

/** Under a finished reply: what answered and how (model · time · steps · tokens · cost), and Copy for its text. */
export function ReplyMeta({ parts, info, copy, children }: { parts?: Array<string | false | undefined>; info?: ReplyInfo; copy?: string; children?: ReactNode }) {
  const shown = [...((parts ?? []).filter(Boolean) as string[]), ...(info ? replyInfoParts(info) : [])];
  if (!shown.length && !copy && !children) return null;
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-t3">
      {shown.length > 0 && <span className="min-w-0 truncate">{shown.join(' · ')}</span>}
      {children}
      {copy && <CopyButton text={copy} label="Copy the reply" className="-my-1 size-6 max-md:size-11" />}
    </div>
  );
}

/** A small neutral pill naming the model that will answer: its short name, "local" after it for a local one. */
export function ModelChip({ model, local }: { model: string; local?: boolean }) {
  const name = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return (
    <span title={model} className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full border border-hair bg-sf px-2 font-mono text-[10.5px] text-t3">
      <span className="min-w-0 truncate">{name}</span>
      {local && <span className="shrink-0">· local</span>}
    </span>
  );
}

/**
 * The first `n` sentences of a reply, and whether there is more. Not cut after "e.g.", "i.e.", "etc." or a digit
 * ("Step 2."), nor inside a quoted name; a list or a code block is not split, so it counts as one sentence's worth.
 */
export function firstSentences(text: string, n: number): { text: string; more: boolean } {
  const t = text.trim();
  if (n < 1) return { text: '', more: t.length > 0 };
  let quoted = 0;
  let fence = false;
  let found = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (t.startsWith('```', i)) {
      fence = !fence;
      i += 2;
    } else if (fence) continue;
    else if (c === '“') quoted++;
    else if (c === '”') quoted = Math.max(0, quoted - 1);
    else if ('.!?'.includes(c) && !quoted && /\s/.test(t[i + 1] ?? '') && !/\b(?:e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|No)\.$/i.test(t.slice(Math.max(0, i - 5), i + 1)) && !/(?:^|\n)\s*\d+\.$/.test(t.slice(Math.max(0, i - 6), i + 1))) {
      // A list item or table row ends at its line, not at a full stop inside a following item.
      if (++found >= n) return { text: t.slice(0, i + 1), more: t.slice(i + 1).trim().length > 0 };
    }
  }
  return { text: t, more: false };
}

/** A reply cut to its first sentences, the rest on "Show more". */
export function ShortReply({ text, sentences = 2 }: { text: string; sentences?: number }) {
  const [more, setMore] = useState(false);
  const cut = firstSentences(text, sentences);
  if (more || !cut.more) return <ChatMarkdown text={text} />;
  return (
    <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">
      {cut.text.replace(/\*\*|`/g, '')}
      <button type="button" onClick={() => setMore(true)} className="ml-1 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11 max-md:px-1">
        Show more
      </button>
    </div>
  );
}

/** It is working: a spinner and what it is doing ("Thinking…", a tool's name). */
export function Working({ label = 'Thinking…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex min-w-0 items-center gap-1.5 text-[12px] text-t3', className)}>
      <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" />
      <span className="min-w-0 truncate animate-pulse-soft">{label}</span>
    </div>
  );
}

/** A provider's raw error ("Ollama error 500: {…}"): say it plainly, keep the raw text behind Details. */
export function plainError(message: string): { text: string; details?: string } {
  const raw = /\b(error|status)\s*\d{3}\b|[{[]".*[}\]]|^\w+Error:/i.test(message);
  if (!raw) return { text: message };
  const status = /\b(\d{3})\b/.exec(message)?.[1];
  const text = status === '401' || status === '403' ? 'The model refused the request: check its credential.' : status === '429' ? 'The model is busy or over its limit. Try again in a moment.' : 'The model returned an error.';
  return { text, details: message };
}

/** Something went wrong with a reply: what, Try again when it can be retried, other actions (Open settings), and the raw text on demand. */
export function ChatError({ message, onRetry, actions, className }: { message: string; onRetry?: () => void; actions?: Array<{ label: string; onClick: () => void; primary?: boolean }>; className?: string }) {
  const [open, setOpen] = useState(false);
  const { text, details } = plainError(message);
  return (
    <div role="alert" className={cn('space-y-1.5 rounded-xl border border-rdbd bg-rddim px-2.5 py-2 text-[12px] leading-snug text-rd', className)}>
      <div className="flex items-start gap-1.5">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{text}</span>
      </div>
      {(onRetry || details || actions?.length) && (
        <div className="flex flex-wrap items-center gap-1 pl-5">
          {onRetry && (
            <button type="button" onClick={onRetry} className="min-h-7 rounded-full border border-rdbd px-2.5 font-semibold hover:bg-rd/10 max-md:min-h-11">
              Try again
            </button>
          )}
          {actions?.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              className={cn('min-h-7 rounded-full border px-2.5 font-semibold max-md:min-h-11', a.primary ? 'border-rd bg-rd text-on-ac hover:opacity-90' : 'border-rdbd hover:bg-rd/10')}
            >
              {a.label}
            </button>
          ))}
          {details && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="min-h-7 rounded-full px-2 font-semibold hover:bg-rd/10 max-md:min-h-11">
              {open ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
      )}
      {open && details && <pre className="max-h-40 overflow-auto whitespace-pre-wrap pl-5 font-mono text-[11px] text-t2 [overflow-wrap:anywhere]">{details}</pre>}
    </div>
  );
}

/** A conversation with nothing in it yet: a mark, one line, one line of help, and up to three starters that fill the box. */
export function ChatEmpty({ mark, title, help, starters = [], onStarter, className }: { mark?: ReactNode; title: string; help?: ReactNode; starters?: string[]; onStarter?: (text: string) => void; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-2 text-center animate-fade-up', className)}>
      {mark ?? (
        <span className="grid size-10 place-items-center rounded-full border border-hair bg-wl text-viz-7">
          <Sparkles className="size-4" />
        </span>
      )}
      <p className="text-[13px] font-semibold text-t1">{title}</p>
      {help && <p className="max-w-[300px] text-[12px] leading-relaxed text-t3">{help}</p>}
      {starters.length > 0 && onStarter && (
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {starters.slice(0, 3).map((s) => (
            <button key={s} type="button" onClick={() => onStarter(s)} className="rounded-2xl border border-hair bg-sf px-3 py-1.5 text-left text-[12px] leading-snug text-t2 transition-colors hover:border-acbd hover:text-t1 max-md:min-h-11">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The message box: a growing text area with Send (↑) or, while a reply streams, Stop. Enter sends, Shift+Enter adds a
 * line, nothing sends while an input method is composing. `before` sits left of the text (a sparkle, Attach, a page chip),
 * `after` right of it (Dictate, a count); `top` above it (attached files, the selected node).
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  canSend = true,
  placeholder,
  label,
  id,
  inputRef,
  before,
  after,
  top,
  chip,
  onKeyDown,
  onFocus,
  onBlur,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  canSend?: boolean;
  placeholder: string;
  label: string;
  id?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  before?: ReactNode;
  after?: ReactNode;
  top?: ReactNode;
  /** At the left of the footer row, before Send: a ModelChip. */
  chip?: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
}) {
  const send = () => {
    if (value.trim() && canSend && !busy) onSend(value);
  };
  return (
    <div className={cn('rounded-2xl border border-hair bg-wl px-2.5 py-1.5 transition-colors focus-within:border-[color-mix(in_oklab,var(--viz-7)_45%,var(--bd))]', className)}>
      {top}
      <div className="flex items-end gap-2">
        {before}
        <textarea
          id={id}
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          className="max-h-[120px] min-h-[32px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 text-t1 outline-none [field-sizing:content] placeholder:text-t3 max-md:text-base"
        />
        {after}
        {chip && <span className="mb-1.5 flex max-w-[45%] shrink-0 items-center">{chip}</span>}
        {busy && onStop ? (
          <button type="button" onClick={onStop} aria-label="Stop" title="Stop" className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-rd hover:text-rd max-md:size-11">
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!value.trim() || !canSend || busy}
            aria-label="Send"
            title="Send"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full bg-ac2 text-on-ac transition-all hover:bg-ac2-hover disabled:opacity-30 max-md:size-11"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
