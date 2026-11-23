'use client';
/**
 * What an AI Judge that could not decide shows the person who decides (C13, docs/approval-inbox.md#judge-requests): the item it
 * judged (masked by the server and again here), what it concluded and how sure it was, and each tool it used. Every value is
 * rendered as text, never as markup: the reason and the tool answers are a model's words and may quote the item.
 */
import { cn } from '@/lib/utils';
import { FALLBACK_WORDS, type JudgeEvidence } from '@/lib/shared/judge';
import { maskParams, MASK } from '@/lib/shared/approval-inbox';

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? '' : (JSON.stringify(value) ?? String(value)));

const H = ({ children }: { children: React.ReactNode }) => <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{children}</h4>;

/** The item as two columns of key and value; a secret-looking value reads ••••••. `hidden` says the run keeps no item text. */
export function JudgedItem({ params }: { params: Record<string, unknown> }) {
  const entries = Object.entries(maskParams(params));
  return (
    <>
      <H>The item</H>
      <dl className="mb-4 grid grid-cols-[minmax(0,96px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border border-hair bg-wl px-3 py-2.5" data-testid="judge-item">
        {entries.length ? (
          entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-[12px] text-t3">{key}</dt>
              <dd className={cn('min-w-0 whitespace-pre-wrap text-[13px] text-t1 [overflow-wrap:anywhere]', value === MASK && 'font-mono text-t3')}>{text(value)}</dd>
            </div>
          ))
        ) : (
          <p className="col-span-2 text-[12.5px] text-t2">This run keeps no item text (its trace content is off).</p>
        )}
      </dl>
    </>
  );
}

/** The judge's conclusion and its steps. */
export function JudgeEvidenceView({ evidence }: { evidence: JudgeEvidence }) {
  return (
    <div data-testid="judge-evidence">
      <H>What the judge did</H>
      <p className="mb-2 text-[12.5px] text-t2" data-testid="judge-why">
        It could not decide: {FALLBACK_WORDS[evidence.fallbackReason] ?? evidence.fallbackReason} · {evidence.rounds} {evidence.rounds === 1 ? 'round' : 'rounds'} · {evidence.toolCalls} tool {evidence.toolCalls === 1 ? 'call' : 'calls'}
      </p>
      {(evidence.reason || evidence.confidence !== undefined) && (
        <blockquote className="mb-3 whitespace-pre-line rounded-xl border border-hair bg-wl px-3 py-2 text-[13px] text-t1 [overflow-wrap:anywhere]" data-testid="judge-reason">
          {evidence.decision && <b>{evidence.decision === 'approve' ? 'Leaned towards approving' : 'Leaned towards denying'}</b>}
          {evidence.confidence !== undefined && <span className="text-t3"> · confidence {evidence.confidence.toFixed(2)}</span>}
          {evidence.reason && <span className="block">{evidence.reason}</span>}
        </blockquote>
      )}
      {evidence.steps.length > 0 && (
        <ol className="mb-4 flex flex-col gap-2" data-testid="judge-steps">
          {evidence.steps.map((step, index) => (
            <li key={index} className="rounded-xl border border-hair px-3 py-2">
              <p className={cn('font-mono text-[12.5px] text-t1', step.isError && 'text-warn')}>{step.tool}{step.isError ? ' (failed)' : ''}</p>
              {text(step.input) !== '{}' && text(step.input) !== '' && <p className="whitespace-pre-wrap text-[12px] text-t3 [overflow-wrap:anywhere]">{text(maskParams(step.input))}</p>}
              {step.output && <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-t2 [overflow-wrap:anywhere]">{step.output}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
