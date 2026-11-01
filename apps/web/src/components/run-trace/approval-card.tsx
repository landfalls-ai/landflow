'use client';
/**
 * An approval with its evidence (docs/run-trace.md#an-approval-with-its-evidence), drawn in the new look only: when a run waits
 * for a person to approve a tool, the card says in the member's own words what it wants and recommends, shows the case (what
 * the tool acts on and its input made readable), lists what the member looked at (each row leads to its place in the Run
 * Trace), and offers buttons named by the action: "Post review & approve", Edit, Deny. Edit opens the input; "Approve with these
 * changes" sends it with the approval and the tool runs with it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Clock, FileDiff, FlaskConical, Gauge, Hourglass, Pencil, Repeat, ShieldCheck, Timer, X } from 'lucide-react';
import { toast } from 'sonner';
import { decideAsk } from '@/lib/client/run-controls';
import { decideToolApprovals } from '@/lib/client/run-trace';
import { approvalCase, editedInput, VERDICT_LABEL, type ApprovalCase, type ApprovalWait, type CaseEdit, type ReviewVerdict } from '@/lib/shared/approval-case';
import { approvalEvidence, type EvidenceLink, type EvidenceRow, type EvidenceTone, type NeedFace } from '@/lib/shared/approval-evidence';
import type { RunChanges } from '@/lib/shared/run-changes';
import type { RunProfile } from '@/lib/shared/run-profiles';
import type { RunActor } from '@/lib/shared/run-trace';
import type { RunModel } from '@/lib/shared/run-trace-model';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';
import { Avatar, clock } from './parts';
import type { Open } from './sheet';

type Tab = Extract<EvidenceLink, { tab: string }>['tab'];

/** What the person decided, as the card passes it on: `input` for a tool call, `command` for a guard's ask. */
export interface ApprovalEdit {
  input?: Record<string, unknown>;
  command?: string;
}

const ICON: Record<EvidenceRow['id'], typeof Clock> = { asked: Clock, checks: ShieldCheck, tests: FlaskConical, changes: FileDiff, rounds: Repeat, budget: Gauge, time: Timer };
const TONE: Record<EvidenceTone, string> = { ok: 'text-gn', bad: 'text-rd', warn: 'text-warn', '': 'text-t2' };

const Label = ({ children }: { children: ReactNode }) => <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{children}</div>;

/** The member's actor: the one the run recorded, else made from the name (its face is found by name). */
function memberActor(model: RunModel, member: string | undefined, fallback: RunActor): RunActor {
  if (!member) return fallback;
  return model.actors.find((a) => a.actor.name.trim().toLowerCase() === member.trim().toLowerCase())?.actor ?? { id: `member:${member}`, name: member, type: 'agent' };
}

/** A row of the evidence: a button into the Run Trace (a sheet or a tab), or a link where the page isn't the Run Trace. */
function Evidence({ row, open, onTab, traceHref, member }: { row: EvidenceRow; open?: (o: Open) => void; onTab?: (tab: Tab, member?: string) => void; traceHref?: string; member?: string }) {
  const Icon = ICON[row.id];
  const inner = (
    <>
      <Icon className={cn('size-3.5 shrink-0', TONE[row.tone])} />
      <span className="w-[74px] shrink-0 text-[12px] text-t3">{row.label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', row.tone ? TONE[row.tone] : 'text-t1')}>{row.detail}</span>
      {row.link && <ChevronRight className="size-3.5 shrink-0 text-t3" />}
    </>
  );
  const cls = 'flex min-h-[34px] w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-acdim/60';
  const link = row.link;
  if (link && 'open' in link && open) return <button type="button" className={cls} onClick={() => open(link.open)}>{inner}</button>;
  if (link && 'tab' in link) {
    if (onTab) return <button type="button" className={cls} onClick={() => onTab(link.tab, link.member ?? member)}>{inner}</button>;
    if (traceHref) return <a className={cls} href={`${traceHref}?tab=${link.tab}${link.member ? `&member=${encodeURIComponent(link.member)}` : ''}`} target="_blank" rel="noopener">{inner}</a>;
  }
  return <div className={cls.replace('hover:bg-acdim/60', '')}>{inner}</div>;
}

/** The edit: a review's verdict and body, a command, or the input as JSON. */
function Editor({ draft, onChange }: { draft: CaseEdit; onChange: (next: CaseEdit) => void }) {
  if (draft.kind === 'review')
    return (
      <div className="flex flex-col gap-2">
        <div role="radiogroup" aria-label="Verdict" className="flex flex-wrap gap-1.5">
          {(['approve', 'request_changes', 'comment'] as ReviewVerdict[]).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={draft.verdict === v}
              onClick={() => onChange({ ...draft, verdict: v })}
              className={cn('h-8 rounded-full border px-3 text-[12.5px] font-medium', draft.verdict === v ? 'border-ac bg-acdim text-t1' : 'border-bd text-t2 hover:border-ac')}
            >
              {VERDICT_LABEL[v]}
            </button>
          ))}
        </div>
        <Textarea aria-label="Review" rows={6} value={draft.body} onChange={(e) => onChange({ ...draft, body: e.target.value })} />
      </div>
    );
  if (draft.kind === 'command') return <Textarea aria-label="Command" rows={3} spellCheck={false} className="font-mono text-[12.5px]" value={draft.command} onChange={(e) => onChange({ ...draft, command: e.target.value })} />;
  return <Textarea aria-label="Input as JSON" rows={9} spellCheck={false} className="font-mono text-[12px]" value={draft.json} onChange={(e) => onChange({ ...draft, json: e.target.value })} />;
}

export function ApprovalCard({
  wait,
  model,
  executionId,
  executionHref,
  changes,
  profile,
  open,
  onTab,
  traceHref,
  onDecided,
  decide,
  className,
}: {
  wait: ApprovalWait;
  model: RunModel;
  executionId: string;
  executionHref?: string;
  changes?: RunChanges;
  profile?: RunProfile;
  open?: (o: Open) => void;
  /** Open a tab of the Run Trace (the page is the Run Trace); else rows that lead to a tab are links to it (`traceHref`). */
  onTab?: (tab: Tab, member?: string) => void;
  traceHref?: string;
  onDecided?: () => void;
  /** Decide where the page follows the run itself (the editor); else the approvals route is called and the page catches up. */
  decide?: (approved: boolean, edit?: ApprovalEdit & { callId?: string }) => Promise<void>;
  className?: string;
}) {
  const c: ApprovalCase = useMemo(() => approvalCase(wait, model), [wait, model]);
  const rows = useMemo(() => approvalEvidence(model, wait, { ...(changes && { changes }), ...(profile && { profile }) }), [model, wait, changes, profile]);
  const [draft, setDraft] = useState<CaseEdit>();
  const [busy, setBusy] = useState<'approve' | 'deny'>();
  const edited = draft ? editedInput(c, draft) : undefined;
  const actor = memberActor(model, c.member, wait.actor);
  const who = c.member ?? wait.actor.name;
  const verb = c.verb;

  const send = async (approved: boolean, edit?: ApprovalEdit) => {
    setBusy(approved ? 'approve' : 'deny');
    try {
      if (decide) await decide(approved, { ...edit, ...(c.callId && { callId: c.callId }) });
      else {
        const done = c.ask ? Boolean(await decideAsk(executionId, c.ask, approved, edit?.command)) : await decideToolApprovals(executionId, approved, undefined, { ...(edit?.input && { input: edit.input }), ...(c.callId && { callId: c.callId }) });
        if (!done && executionHref) {
          toast.message('Open the run to answer this one');
          window.location.assign(executionHref);
          return;
        }
      }
      toast.success(approved ? (edit ? 'Approved with your changes' : 'Approved') : 'Denied');
      onDecided?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const approveEdited = () => {
    if (!edited) return;
    if (!edited.ok) return toast.error(edited.error);
    void send(true, edited.command !== undefined ? { command: edited.command } : { input: edited.input });
  };

  return (
    <section className={cn('rounded-2xl border border-warnbd bg-warndim p-3.5', className)} aria-label={`${who} waits for your approval`} data-testid="approval-card">
      <header className="flex items-start gap-3">
        <span className="relative shrink-0">
          <Avatar actor={actor} size={40} />
          <span className="absolute -bottom-1.5 -right-1.5 grid size-[18px] place-items-center rounded-full bg-warn text-bg ring-2 ring-sf">
            <Hourglass className="size-2.5" strokeWidth={3} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-5 text-t1">
            <b>{who}</b> <span className="text-t2">wants to {c.kind === 'command' ? 'run' : 'use'}</span> <span className="font-mono font-semibold" data-testid="approval-tool">{c.toolName}</span>
            {c.target && <span className="text-t2" data-testid="approval-target"> on {c.target}</span>}
          </div>
          <div className="font-mono text-[11px] tabular-nums text-t3">waiting since {clock(wait.since)}</div>
        </div>
      </header>

      {c.words && (
        <div className="mt-3">
          <Label>In its own words</Label>
          <blockquote className="whitespace-pre-line rounded-xl border border-warnbd/70 bg-sf px-3 py-2 text-[13px] leading-5 text-t1" data-testid="approval-words">
            “{c.words}”
          </blockquote>
        </div>
      )}

      <div className="mt-3">
        <Label>{draft ? 'Edit what it would do' : 'The case'}</Label>
        {draft ? (
          <div className="rounded-xl border border-warnbd/70 bg-sf p-2.5" data-testid="approval-editor">
            <Editor draft={draft} onChange={setDraft} />
            {edited && !edited.ok && <p className="mt-1.5 text-[12px] text-rd">{edited.error}</p>}
          </div>
        ) : (
          <dl className="flex flex-col gap-1.5 rounded-xl border border-warnbd/70 bg-sf px-3 py-2" data-testid="approval-case">
            {c.rows.length ? (
              c.rows.map((r) => (
                <div key={r.label} className={cn(r.block ? 'flex flex-col gap-0.5' : 'flex items-baseline gap-2')}>
                  <dt className="w-[70px] shrink-0 text-[12px] text-t3">{r.label}</dt>
                  <dd className={cn('min-w-0 flex-1 text-[13px] text-t1', r.mono ? 'whitespace-pre-wrap break-all font-mono text-[12.5px]' : 'break-words', r.block && !r.mono && 'line-clamp-6 whitespace-pre-line')}>{r.value}</dd>
                </div>
              ))
            ) : (
              <p className="text-[12.5px] text-t2">No input.</p>
            )}
          </dl>
        )}
      </div>

      {rows.length > 0 && !draft && (
        <div className="mt-3">
          <Label>What it looked at</Label>
          <div className="rounded-xl border border-warnbd/70 bg-sf p-1" data-testid="approval-evidence">
            {rows.map((r) => (
              <Evidence key={r.id} row={r} open={open} onTab={onTab} traceHref={traceHref} member={c.member} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-3.5 flex flex-wrap gap-2">
        {draft ? (
          <>
            <Button variant="primary" loading={busy === 'approve'} disabled={Boolean(busy) || !edited || !edited.ok || !edited.changed} onClick={approveEdited} data-testid="approval-approve-edited">
              <Check className="size-3.5" strokeWidth={3} /> Approve with these changes
            </Button>
            <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" loading={busy === 'approve'} disabled={Boolean(busy)} onClick={() => send(true)} data-testid="approval-approve">
              <Check className="size-3.5" strokeWidth={3} /> {verb}
            </Button>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setDraft(c.edit)} data-testid="approval-edit">
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button variant="danger" loading={busy === 'deny'} disabled={Boolean(busy)} onClick={() => send(false)} data-testid="approval-deny">
              <X className="size-3.5" /> Deny
            </Button>
          </>
        )}
        {open && !draft && (
          <Button variant="ghost" onClick={() => open({ kind: 'span', id: wait.spanId })}>
            Details
          </Button>
        )}
      </div>
    </section>
  );
}

/** Who has something for you: the faces across the top of Needs you, a dot on each that waits (and how many things it has). */
export function NeedFaces({ faces, className }: { faces: NeedFace[]; className?: string }) {
  if (!faces.length) return null;
  const waiting = faces.filter((f) => f.waiting).length;
  return (
    <div className={cn('flex items-center gap-2.5', className)} data-testid="need-faces" aria-label={`${waiting} of ${faces.length} have something for you`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {faces.map((f) => (
          <span key={f.name} className={cn('relative shrink-0', !f.waiting && 'opacity-55')} title={f.waiting ? `${f.name} waits for you${f.count > 1 ? ` (${f.count})` : ''}` : f.name} data-waiting={f.waiting || undefined}>
            <Avatar actor={f.actor} size={30} />
            {f.waiting && <span className="absolute -right-0.5 -top-0.5 size-3 animate-pulse-soft rounded-full border-2 border-sf bg-warn" />}
          </span>
        ))}
      </div>
      <span className="text-[12px] text-t2">{waiting === 1 ? `${faces.find((f) => f.waiting)!.name} has something for you` : `${waiting} have something for you`}</span>
    </div>
  );
}
