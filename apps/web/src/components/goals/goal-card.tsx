'use client';
/**
 * A goal as a card (the phone's goals list) and the chips a goal wears everywhere: status and level
 * (docs/projects-and-goals.md). Targets are 44 px; nothing scrolls sideways.
 */
import { ChevronRight } from 'lucide-react';
import { GOAL_LEVEL_LABELS, GOAL_STATUS_LABELS, type GoalNode, type GoalStatus } from '@/lib/shared/goals';
import { plural } from '@/lib/client/format';
import { Badge, type Tone } from '@/components/ui/badge';
import { formatTarget } from './tree';

const STATUS_TONE: Record<GoalStatus, Tone> = { planned: 'neutral', active: 'accent', achieved: 'success', cancelled: 'muted' };

export const GoalStatusChip = ({ status }: { status: GoalStatus }) => <Badge tone={STATUS_TONE[status]}>{GOAL_STATUS_LABELS[status]}</Badge>;
export const GoalLevelChip = ({ level }: { level: GoalNode['level'] }) => <Badge tone="muted">{GOAL_LEVEL_LABELS[level]}</Badge>;

export function GoalCard({ goal, parent, onOpen, onDrill }: { goal: GoalNode; parent?: string; onOpen: () => void; onDrill?: () => void }) {
  const target = formatTarget(goal.targetDate);
  const count = goal.children.length;
  return (
    <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
      <button type="button" onClick={onOpen} className="block min-h-11 w-full px-4 py-3 text-left">
        <span className="block text-[15px] font-semibold leading-snug text-t1">{goal.title}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <GoalStatusChip status={goal.status} />
          <GoalLevelChip level={goal.level} />
          {target && <span className="text-[12px] text-t3">by {target}</span>}
        </span>
        {parent && <span className="mt-1.5 block truncate text-[12px] text-t3">Under: {parent}</span>}
        {goal.ownerName && <span className="mt-0.5 block truncate text-[12px] text-t3">Owner: {goal.ownerName}</span>}
      </button>
      {count > 0 && onDrill && (
        <button type="button" onClick={onDrill} className="flex min-h-11 w-full items-center justify-between border-t border-hair px-4 text-[13px] font-semibold text-ac hover:bg-acdim">
          {plural(count, 'sub-goal')}
          <ChevronRight className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
