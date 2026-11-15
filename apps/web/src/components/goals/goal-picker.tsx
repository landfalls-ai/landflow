'use client';
/**
 * Pick a goal (docs/projects-and-goals.md). Visible goals, indented by depth, cancelled ones left out; with a
 * `projectId` that project's goals come first under "This project". `level` is the level of the goal being placed: a company
 * goal may only sit under a company goal. `exclude` leaves out ids (a goal and what is under it, when choosing its parent).
 */
import { useMemo } from 'react';
import type { GoalLevel, GoalNode } from '@/lib/shared/goals';
import { Select } from '@/components/ui/inputs';
import { allNodes, pickerOptions } from './tree';
import { useGoals } from './use-goals';

export function GoalPicker({
  value,
  onChange,
  projectId,
  level,
  allowNone,
  noneLabel = 'No goal',
  disabled,
  exclude,
  goals,
  ariaLabel = 'Goal',
}: {
  value?: string;
  onChange(id: string | undefined): void;
  projectId?: string;
  level?: GoalLevel;
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
  exclude?: ReadonlySet<string>;
  /** Goals already loaded by the caller (saves a request). */
  goals?: GoalNode[];
  ariaLabel?: string;
}) {
  const loaded = useGoals();
  const tree = goals ?? loaded.data?.goals;
  const options = useMemo(() => {
    if (!tree) return [];
    const levelOk = new Set(allNodes(tree).filter(({ node }) => level !== 'company' || node.level === 'company').map(({ node }) => node.id));
    return pickerOptions(tree, projectId, exclude).filter((o) => levelOk.has(o.id));
  }, [tree, projectId, level, exclude]);
  const mine = options.filter((o) => o.group === 'project');
  const rest = options.filter((o) => o.group === 'other');
  const render = (list: typeof options) =>
    list.map((o) => (
      <option key={o.id} value={o.id}>
        {o.label.replace(/ /g, '\u00a0')}
      </option>
    ));
  return (
    <Select aria-label={ariaLabel} value={value ?? ''} disabled={disabled || !tree} onChange={(e) => onChange(e.target.value || undefined)} className="max-md:h-11">
      {(allowNone || !value) && <option value="">{allowNone ? noneLabel : 'Choose a goal…'}</option>}
      {projectId && mine.length > 0 ? (
        <>
          <optgroup label="This project">{render(mine)}</optgroup>
          {rest.length > 0 && <optgroup label="Other goals">{render(rest)}</optgroup>}
        </>
      ) : (
        render(options)
      )}
    </Select>
  );
}
