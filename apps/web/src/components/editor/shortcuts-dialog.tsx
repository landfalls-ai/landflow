'use client';
/** The editor's keyboard shortcuts, from the "…" menu or `?`. */
import { create } from 'zustand';
import { Keyboard } from 'lucide-react';
import { Dialog } from '../agents/dialog';
import { Kbd, SectionLabel } from '../ui/inputs';

export const useShortcuts = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Canvas',
    keys: [
      ['N  or  Tab', 'Add a node'],
      ['⇧ S', 'Add a sticky note'],
      ['⌘ C  /  ⌘ X  /  ⌘ V', 'Copy, cut, paste nodes and notes (also n8n nodes)'],
      ['⌘ D', 'Duplicate the selection'],
      ['⌫  or  Delete', 'Delete the selection'],
      ['⌘ Z  /  ⇧ ⌘ Z', 'Undo, redo'],
      ['⇧ ⌥ T', 'Tidy up'],
      ['⇧ drag', 'Select an area'],
      ['Double-click', 'Open a node, edit a note'],
    ],
  },
  {
    title: 'Run and debug',
    keys: [
      ['⌘ ↵', 'Execute workflow'],
      ['⇧ ⌘ ↵', 'Debug'],
      ['F9', 'Toggle breakpoint on the selected node'],
      ['F10  /  F8', 'Step, continue (while paused)'],
    ],
  },
  {
    title: 'Editor',
    keys: [
      ['⌘ S', 'Save'],
      ['⌘ I', 'Assistant'],
      ['{{', 'Start an expression (with autocomplete)'],
      ['⌃ Space', 'Show expression suggestions'],
      ['?', 'This list'],
    ],
  },
];

export function ShortcutsDialog() {
  const { open, setOpen } = useShortcuts();
  if (!open) return null;
  return (
    <Dialog title="Keyboard shortcuts" icon={<Keyboard className="size-5 text-t2" />} onClose={() => setOpen(false)} width={520}>
      <div className="space-y-4">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <SectionLabel className="mb-1.5">{group.title}</SectionLabel>
            <div className="divide-y divide-hair rounded-xl border border-hair">
              {group.keys.map(([keys, label]) => (
                <div key={label} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
                  <span className="text-t2">{label}</span>
                  <span className="ml-auto flex shrink-0 gap-1">
                    {keys.split('  ').map((k, i) =>
                      k === 'or' || k === '/' ? (
                        <span key={i} className="text-[11px] text-t3">
                          {k}
                        </span>
                      ) : (
                        <Kbd key={i}>{k}</Kbd>
                      ),
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
