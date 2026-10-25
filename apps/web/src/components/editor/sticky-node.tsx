'use client';
/**
 * A sticky note on the editor canvas: Markdown when shown, a textarea after a
 * double-click (Escape or clicking away finishes), resizable from its edges
 * and corners, and a toolbar with the colour palette when selected. Delete it
 * with Backspace/Delete like a node.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { PencilLine, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STICKY_COLORS, STICKY_MIN_SIZE, StickyNoteView, stickyColors } from '../canvas/sticky-note';
import { useEditor, type StickyFlowNode } from './store';

export const StickyNodeView = memo(function StickyNodeView({ id, data, selected }: NodeProps<StickyFlowNode>) {
  const [editing, setEditing] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { updateSticky, removeNodes } = useEditor.getState();

  useEffect(() => {
    if (!editing) return;
    const el = textarea.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  // Deselecting the note (clicking the canvas) ends editing too.
  useEffect(() => {
    if (!selected) setEditing(false);
  }, [selected]);

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={STICKY_MIN_SIZE.width}
        minHeight={STICKY_MIN_SIZE.height}
        lineClassName="!border-transparent"
        handleClassName="!size-2.5 !rounded-[3px] !border-[1.5px] !border-t3 !bg-sf"
      />
      <NodeToolbar isVisible={selected && !editing} position={Position.Top} offset={10}>
        <div className="flex animate-in items-center gap-1 rounded-full border border-hair bg-sf p-1 shadow-pop">
          {STICKY_COLORS.map((c, index) => (
            <button
              key={c.name}
              title={c.name}
              aria-label={`${c.name} note`}
              aria-pressed={data.color === index}
              onClick={(e) => {
                e.stopPropagation();
                updateSticky(id, { color: index });
              }}
              className={cn(
                'size-[18px] rounded-full border transition-transform hover:scale-110',
                data.color === index ? 'border-t1 shadow-[0_0_0_2px_var(--sf),0_0_0_3px_var(--t1)]' : 'border-hair',
              )}
              style={{ background: stickyColors(index).swatch }}
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-hair" />
          <button
            title="Edit (double-click)"
            aria-label="Edit note"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="grid size-6 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1"
          >
            <PencilLine className="size-3.5" />
          </button>
          <button
            title="Delete (⌫)"
            aria-label="Delete note"
            onClick={(e) => {
              e.stopPropagation();
              removeNodes([id]);
            }}
            className="grid size-6 place-items-center rounded-full text-t2 transition-colors hover:bg-rddim hover:text-rd"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </NodeToolbar>
      <StickyNoteView content={data.content} color={data.color} selected={selected} onDoubleClick={() => setEditing(true)}>
        {editing ? (
          <textarea
            ref={textarea}
            value={data.content}
            spellCheck={false}
            aria-label="Note (Markdown)"
            placeholder="Write Markdown…"
            onChange={(e) => updateSticky(id, { content: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              // Keep editor shortcuts (N, Tab, ⌘D…) out of the note; Escape or ⌘↵ finishes.
              e.stopPropagation();
              if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) setEditing(false);
            }}
            className="nodrag nowheel nopan size-full resize-none bg-transparent px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-t1 outline-none placeholder:text-t3"
          />
        ) : undefined}
      </StickyNoteView>
    </>
  );
});
