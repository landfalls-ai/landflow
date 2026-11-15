'use client';
/**
 * Parts of the Workflows list (workflows-list.tsx) kept beside its model (list-model.ts): a row's last run, on a desktop
 * and on a phone, and the page's one New menu.
 */
import { ChevronDown, FileUp, FolderPlus, LayoutTemplate, Plus } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import type { ExecutionSummary } from '@/lib/shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MenuItem, Popover } from '@/components/ui/popover';
import { describeLastRun, NEW_MENU_ITEMS, type NewMenuItem } from './list-model';

/**
 * The row's last run: its state, and when it started (or "Not run yet"). On a phone only the state badge shows, beside
 * the updated time. `unknown` (the executions read did not reach back far enough) shows nothing for a row without a run.
 */
export function LastRun({ run, unknown }: { run?: ExecutionSummary; unknown?: boolean }) {
  if (!run && unknown) return null;
  const last = describeLastRun(run);
  const title = last.startedAt ? `Last run ${new Date(last.startedAt).toLocaleString()}` : undefined;
  return (
    <>
      <span className="flex w-[110px] shrink-0 flex-col items-end gap-0.5 max-md:hidden" data-testid="last-run" title={title}>
        <Badge tone={last.tone}>{last.label}</Badge>
        {last.startedAt && <span className="text-[11px] tabular-nums text-t3">{timeAgo(last.startedAt)}</span>}
      </span>
    </>
  );
}

/** The last run on a phone: the badge alone, on the row's second line (`WorkflowRow`). */
export function LastRunPhone({ run, unknown }: { run?: ExecutionSummary; unknown?: boolean }) {
  if (!run && unknown) return null;
  const last = describeLastRun(run);
  return (
    <span className="shrink-0" data-testid="last-run-phone" title={last.startedAt ? `Last run ${new Date(last.startedAt).toLocaleString()}` : undefined}>
      <Badge tone={last.tone}>{last.label}</Badge>
    </span>
  );
}

/** The page's one create menu: workflow, from template, import, folder. A bottom sheet on a phone (Popover does that). */
const NEW_MENU_ICON = { workflow: Plus, template: LayoutTemplate, import: FileUp, folder: FolderPlus };

export function NewMenu({ locked, creating, onWorkflow, onTemplate, onImport, onFolder }: { locked: boolean; creating: boolean; onWorkflow: () => void; onTemplate: () => void; onImport: () => void; onFolder: () => void }) {
  const actions: Record<NewMenuItem, () => void> = { workflow: onWorkflow, template: onTemplate, import: onImport, folder: onFolder };
  return (
    <Popover
      title="New"
      trigger={({ toggle, open }) => (
        <Button variant="primary" size="sm" onClick={toggle} loading={creating} disabled={locked} aria-haspopup="menu" aria-expanded={open}>
          {!creating && <Plus className="size-3.5" strokeWidth={2} />} New <ChevronDown className="size-3" />
        </Button>
      )}
    >
      {(close) => {
        const pick = (run: () => void) => () => {
          close();
          run();
        };
        return (
          <>
            {NEW_MENU_ITEMS.map((item) => {
              const Icon = NEW_MENU_ICON[item.id];
              return (
                <MenuItem key={item.id} onClick={pick(actions[item.id])}>
                  <Icon /> {item.label}
                </MenuItem>
              );
            })}
          </>
        );
      }}
    </Popover>
  );
}
