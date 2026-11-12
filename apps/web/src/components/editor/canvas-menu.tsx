'use client';
/**
 * The canvas's right-click menu: group or ungroup the selection (selected groups nest in the new one), collapse,
 * rename or wrap a group in a new one, duplicate, add a sticky note where the pointer is, delete. Right-clicking an
 * element that isn't selected selects it first, so the menu always acts on what is highlighted. Escape, a click
 * elsewhere or scrolling closes it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ChevronsDownUp, ChevronsUpDown, Copy, Group, StickyNote, Trash2, Ungroup } from 'lucide-react';
import { Kbd } from '../ui/inputs';
import { descendantGroupIds, descendantNodeIds } from '@/lib/shared/groups';
import { MenuItem, MenuLabel, MenuSeparator } from '../ui/popover';
import { linksOf } from './groups';
import { useEditor } from './store';

interface MenuState {
  /** Where it opened: the screen point and the same point on the canvas. */
  at?: { x: number; y: number; flow: { x: number; y: number } };
  open(at: { x: number; y: number; flow: { x: number; y: number } }): void;
  close(): void;
}

export const useCanvasMenu = create<MenuState>((set) => ({
  open: (at) => set({ at }),
  close: () => set({ at: undefined }),
}));

/** Before opening the menu on an element: make it the selection unless it already is part of it. */
export function selectForMenu(id: string) {
  const state = useEditor.getState();
  const all = [...state.nodes, ...state.stickies, ...state.groups];
  if (all.find((n) => n.id === id)?.selected) return;
  state.onNodesChange(all.flatMap((n) => (n.id === id || n.selected ? [{ type: 'select' as const, id: n.id, selected: n.id === id }] : [])));
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

export function CanvasMenu() {
  const at = useCanvasMenu((s) => s.at);
  const close = useCanvasMenu((s) => s.close);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const nodes = useEditor((s) => s.nodes);
  const stickies = useEditor((s) => s.stickies);
  const groups = useEditor((s) => s.groups);

  useLayoutEffect(() => {
    if (!at) return setPos(undefined);
    // Keep the menu on screen.
    const rect = panel.current?.getBoundingClientRect();
    const width = rect?.width ?? 240;
    const height = rect?.height ?? 280;
    setPos({ left: Math.min(at.x, window.innerWidth - width - 8), top: Math.min(at.y, window.innerHeight - height - 8) });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
    };
  }, [at, close]);

  // Move focus into the menu so it can be used from the keyboard.
  useEffect(() => {
    if (pos) panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [pos]);

  if (!at) return null;
  const state = useEditor.getState();
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedGroups = groups.filter((g) => g.selected);
  const selectedNotes = stickies.filter((n) => n.selected);
  const memberGroups = groups.filter((g) => g.data.nodeIds.some((id) => selectedNodes.some((n) => n.id === id)));
  const single = selectedGroups.length === 1 && !selectedNodes.length && !selectedNotes.length ? selectedGroups[0] : undefined;
  const links = linksOf(groups);
  const parent = single?.data.parentId ? groups.find((g) => g.id === single.data.parentId) : undefined;
  const anything = selectedNodes.length + selectedGroups.length + selectedNotes.length > 0;
  const act = (fn: () => void) => () => {
    close();
    fn();
  };
  const rename = (id: string) => {
    // The frame's header turns into a field on double-click.
    setTimeout(() => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] .lf-frame-handle`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 0);
  };

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label="Canvas actions"
      style={pos ?? { left: at.x, top: at.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}
      className="fixed z-50 min-w-[230px] animate-in rounded-xl border border-hair bg-sf p-1 text-[13px] shadow-pop max-md:[&_[role=menuitem]]:min-h-11"
    >
      {single ? (
        <>
          <MenuLabel>
            {single.data.name || 'Group'}
            {parent && <span className="font-normal"> · in {parent.data.name || 'Group'}</span>}
          </MenuLabel>
          <MenuItem onClick={act(() => rename(single.id))}>
            <Group /> Rename group
          </MenuItem>
          <MenuItem onClick={act(() => state.updateGroup(single.id, { collapsed: !single.data.collapsed }))}>
            {single.data.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} {single.data.collapsed ? 'Expand group' : 'Collapse group'}
          </MenuItem>
          <MenuItem onClick={act(() => state.duplicateNode(single.id))} hint={<Kbd>{mod}D</Kbd>}>
            <Copy /> Duplicate group and nodes
          </MenuItem>
          <MenuItem onClick={act(() => state.groupSelection())} hint={<Kbd>{mod}G</Kbd>}>
            <Group /> Put in a new group
          </MenuItem>
          <MenuItem onClick={act(() => state.ungroup([single.id]))} hint={<Kbd>⇧{mod}G</Kbd>}>
            <Ungroup /> Ungroup
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={act(() => state.removeNodes([...descendantNodeIds(links, single.id), ...descendantGroupIds(links, single.id), single.id]))}>
            <Trash2 /> Delete group and everything in it
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem disabled={!selectedNodes.length && !selectedGroups.length} onClick={act(() => state.groupSelection())} hint={<Kbd>{mod}G</Kbd>}>
            <Group /> Group selection
          </MenuItem>
          <MenuItem disabled={!selectedGroups.length && !memberGroups.length} onClick={act(() => state.ungroup())} hint={<Kbd>⇧{mod}G</Kbd>}>
            <Ungroup /> Ungroup
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!anything} onClick={act(() => state.duplicateSelection())} hint={<Kbd>{mod}D</Kbd>}>
            <Copy /> Duplicate
          </MenuItem>
          <MenuItem onClick={act(() => state.addSticky({ x: at.flow.x, y: at.flow.y }))} hint={<Kbd>⇧S</Kbd>}>
            <StickyNote /> Add sticky note here
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            disabled={!anything}
            onClick={act(() => state.removeNodes([...selectedNodes, ...selectedNotes, ...selectedGroups].map((n) => n.id)))}
            hint={<Kbd>⌫</Kbd>}
          >
            <Trash2 /> Delete
          </MenuItem>
        </>
      )}
    </div>,
    document.body,
  );
}
