'use client';
/**
 * One suggestion of the second brain (docs/second-brain.md): what it found, the evidence, the change it would make and
 * the buttons. Shared by Home's inbox and the editor's canvas card; `useProposalActions` runs the buttons.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Clock, FilePlus2, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { detectorLabel, type DismissReason, type Proposal, type ProposalAction } from '@/lib/shared/brain';
import { Badge, Chip, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { MenuItem, Popover } from '../ui/popover';
import { OpsDiff, Warnings } from '../editor/suggestions-card';

const RISK_TONE: Record<Proposal['risk'], Tone> = { low: 'success', medium: 'warning', high: 'danger' };

const DISMISS_LABELS: Array<{ reason: DismissReason; label: string }> = [
  { reason: 'intended', label: 'It’s intended' },
  { reason: 'not-relevant', label: 'Not relevant' },
  { reason: 'wrong', label: 'Wrong' },
  { reason: 'done', label: 'Already done' },
];

/** What Apply does for this suggestion. */
export function proposalKind(p: Proposal): 'draft' | 'agent' | 'ops' | 'build' | 'advice' | 'note' {
  if (p.draft) return 'draft';
  // A team's notebook asks to keep a note for the project (docs/team-notebook.md).
  if (p.notebook) return 'note';
  if (p.agentChange) return 'agent';
  // A missing tool: approving it starts the workflows that build one.
  if (p.detector === 'missing-tool') return 'build';
  return p.ops.length ? 'ops' : 'advice';
}

const APPLY_LABEL = { draft: 'Create workflow', agent: 'Apply', ops: 'Apply', build: 'Build it', advice: 'Mark done', note: 'Keep it' } as const;

export interface ProposalActions {
  busy?: string;
  apply: (p: Proposal) => void;
  /** Take one of the buttons a flow put on the suggestion. */
  act: (p: Proposal, action: ProposalAction) => void;
  dismiss: (p: Proposal, reason: DismissReason) => void;
  snooze: (p: Proposal, days: number) => void;
}

/**
 * The buttons' work. `localApply` applies an ops suggestion to the open canvas (the person sees it and saves it) and
 * returns false when nothing applied; without it the server applies the ops.
 */
export function useProposalActions({ onDone, onForbidden, localApply }: { onDone: (id: string) => void; onForbidden?: () => void; localApply?: (p: Proposal) => boolean }): ProposalActions {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();

  const run = async (p: Proposal, work: () => Promise<void>) => {
    setBusy(p.id);
    try {
      await work();
      onDone(p.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403) onForbidden?.();
      else toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  /** The toast that names the workflows a decision started (the missing tool's "Build it" and any On Suggestion Decided). */
  const startedToast = (started?: Array<{ id: string; name: string }>, verb = 'Started') => {
    if (started?.length) toast.success(`${verb}: ${started.map((w) => `“${w.name}”`).join(', ')}`, { action: { label: 'Executions', onClick: () => router.push('/executions') } });
  };
  const patch = (p: Proposal, json: unknown) => api(`/api/proposals/${encodeURIComponent(p.id)}`, { method: 'PATCH', json });

  return {
    busy,
    dismiss: (p, reason) => void run(p, async () => void (await patch(p, { action: 'dismiss', reason }))),
    act: (p, action) => {
      if (action.confirm && !window.confirm(action.confirm)) return;
      void run(p, async () => {
        const result = await api<{ warnings: string[]; started?: Array<{ id: string; name: string }> }>(`/api/proposals/${encodeURIComponent(p.id)}/act`, { method: 'POST', json: { action: action.id } });
        for (const warning of result.warnings) toast.warning(warning);
        if (result.started?.length) startedToast(result.started);
        else toast.success(`${action.label}: done`);
      });
    },
    snooze: (p, days) => void run(p, async () => void (await patch(p, { action: 'snooze', days }))),
    apply: (p) => {
      const kind = proposalKind(p);
      // Advice with buttons of its own has no Apply (see the card); without them, "Mark done".
      if (kind === 'advice') return void run(p, async () => void (await patch(p, { action: 'dismiss', reason: 'done' })));
      void run(p, async () => {
        if (kind === 'ops' && localApply) {
          if (!localApply(p)) throw new Error('The change no longer fits this workflow.');
          const applied = await api<{ started?: Array<{ id: string; name: string }> }>(`/api/proposals/${encodeURIComponent(p.id)}/applied`, { method: 'POST' });
          startedToast(applied.started, 'Started');
          return;
        }
        const projectId = p.projectId ? `?projectId=${encodeURIComponent(p.projectId)}` : '';
        const result = await api<{ workflow?: { id: string }; warnings: string[]; started?: Array<{ id: string; name: string }> }>(`/api/proposals/${encodeURIComponent(p.id)}/apply${projectId}`, { method: 'POST' });
        for (const warning of result.warnings) toast.warning(warning);
        if (kind === 'draft' && result.workflow) {
          toast.success('Workflow created');
          router.push(`/workflows/${result.workflow.id}`);
        } else if (kind === 'build') {
          if (result.started?.length) toast.success(`Approved: ${result.started.map((w) => `“${w.name}”`).join(', ')} builds it`, { action: { label: 'Executions', onClick: () => router.push('/executions') } });
        } else {
          toast.success(kind === 'note' ? 'Kept for the project' : 'Applied');
          startedToast(result.started);
        }
      });
    },
  };
}

function Evidence({ proposal }: { proposal: Proposal }) {
  if (!proposal.evidence.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {proposal.evidence.map((e, i) => {
        const chip = (
          <Chip key={i} className={cn(e.href && 'hover:text-ac')}>
            <span className="text-t3">{e.label}</span>
            {e.value !== undefined && <span className="ml-1 text-t1">{e.value}</span>}
          </Chip>
        );
        return e.href ? (
          <Link key={i} href={e.href}>
            {chip}
          </Link>
        ) : (
          chip
        );
      })}
    </div>
  );
}

function Changes({ proposal }: { proposal: Proposal }) {
  const [open, setOpen] = useState(false);
  const { draft, agentChange, ops } = proposal;
  if (draft)
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-t2">
        <FilePlus2 className="size-3.5 shrink-0 text-ac" /> Creates a new workflow: {draft.name} ({draft.nodes.length} node{draft.nodes.length === 1 ? '' : 's'})
      </p>
    );
  if (agentChange)
    return (
      <div className="space-y-0.5 rounded-lg border border-hair bg-sf px-2 py-1.5 text-[11.5px] leading-snug text-t2">
        {agentChange.always?.map((rule, i) => (
          <div key={`a${i}`}>
            <span className="font-semibold text-gn">Always</span> {rule}
          </div>
        ))}
        {agentChange.never?.map((rule, i) => (
          <div key={`n${i}`}>
            <span className="font-semibold text-rd">Never</span> {rule}
          </div>
        ))}
      </div>
    );
  if (!ops.length) return null;
  return (
    <div className="space-y-1">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[12px] font-semibold text-t2 hover:text-t1">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Changes ({ops.length})
      </button>
      {open && <OpsDiff ops={ops} />}
    </div>
  );
}

export function ProposalCard({ proposal, actions, compact, onFocus }: { proposal: Proposal; actions: ProposalActions; compact?: boolean; onFocus?: () => void }) {
  const tag = proposal.detector ? detectorLabel(proposal.detector, proposal.label) : (proposal.label ?? 'Suggestion');
  const kind = proposalKind(proposal);
  const busy = actions.busy === proposal.id;
  const target = [proposal.target.name, proposal.target.nodeName].filter(Boolean).join(' · ');
  return (
    <div className={cn('animate-fade-up space-y-1.5 rounded-[10px] border border-hair bg-wl', compact ? 'p-2.5' : 'p-3')}>
      <div className="flex items-start gap-2">
        <Badge tone="accent" className="mt-px">
          {tag}
        </Badge>
        <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-t1">{proposal.title}</span>
        <Badge tone={RISK_TONE[proposal.risk]} title="How risky the change is">
          {proposal.risk} risk
        </Badge>
        <span className="font-mono text-[11px] text-t3" title="How sure Landflow is">
          {Math.round(proposal.confidence * 100)}%
        </span>
      </div>
      {target &&
        (onFocus ? (
          <button onClick={onFocus} className="text-[11.5px] text-t3 hover:text-ac">
            {target}
          </button>
        ) : (
          <div className="text-[11.5px] text-t3">{target}</div>
        ))}
      <p className="text-[12px] leading-relaxed text-t2">{proposal.why}</p>
      {!compact && <Evidence proposal={proposal} />}
      {proposal.effect && <p className="text-[12px] leading-relaxed text-t1">Expected: {proposal.effect}</p>}
      {proposal.metricSpec && (
        <p className="text-[11.5px] leading-relaxed text-t3">
          Measured by: {proposal.metricSpec.label} ({proposal.metricSpec.better} is better)
        </p>
      )}
      <Changes proposal={proposal} />
      <Warnings warnings={proposal.warnings} />
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {proposal.actions?.map((a) => (
          <Button key={a.id} size="sm" variant={a.style === 'primary' ? 'primary' : 'outline'} onClick={() => actions.act(proposal, a)} loading={busy} disabled={!!actions.busy && !busy}>
            {a.label}
          </Button>
        ))}
        {(kind !== 'advice' || !proposal.actions?.length) && (
          <Button size="sm" variant={proposal.actions?.length ? 'outline' : 'primary'} onClick={() => actions.apply(proposal)} loading={busy} disabled={!!actions.busy && !busy}>
            {APPLY_LABEL[kind]}
          </Button>
        )}
        <Popover
          align="start"
          trigger={({ toggle }) => (
            <Button size="sm" variant="ghost" onClick={toggle} disabled={!!actions.busy}>
              Dismiss <MoreHorizontal className="size-3.5" />
            </Button>
          )}
        >
          {(close) =>
            DISMISS_LABELS.map(({ reason, label }) => (
              <MenuItem
                key={reason}
                onClick={() => {
                  close();
                  actions.dismiss(proposal, reason);
                }}
              >
                {label}
              </MenuItem>
            ))
          }
        </Popover>
        <Button size="sm" variant="ghost" onClick={() => actions.snooze(proposal, 7)} disabled={!!actions.busy}>
          <Clock className="size-3.5" /> Snooze 7 days
        </Button>
      </div>
    </div>
  );
}
