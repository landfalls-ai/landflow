'use client';
/**
 * One bubble's look, and a small diagram of an agent's bubbles (wave ag4). The canvas's virtual bubble nodes (AG16,
 * `components/canvas/agent-bubbles.tsx` `BubbleNode`) render `BubbleView` at `size="canvas"`; Spotlight's agent card
 * (AG19, `components/editor/spotlight/agent-card.tsx`) renders `BubbleDiagram` with `BubbleView` at `size="card"` (the
 * person, 2026-11-18: "Bubbles there too"). One component, so the card and the canvas never look different.
 *
 * Contract file: backbone/contracts/ag4/bubble-view.tsx (wave ag4, owner AG16, copied byte for byte by AG19), copied to
 * apps/web/src/components/canvas/bubble-view.tsx. It imports only modules that exist on 797eafd8 and
 * `lib/shared/agent-bubbles.ts` (the ag4 contract). The owner may refine the look (the mockup,
 * backbone/mockups/ag4/agent-node.html, is the reference) here first, then copy, and says so in the report.
 */
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BRANDS, brandIcon, brandOfProvider } from '@/lib/shared/brand-icons';
import { bubbleOrder, bubbleTitle, type Bubble, type BubbleSlot } from '@/lib/shared/agent-bubbles';
import type { ActorConnection } from '@/lib/shared/run-trace';
import { useConnectionIcon } from '../run-trace/connections';
import { NodeIcon } from '../ui/icon';

const SIZE = {
  canvas: { circle: 64, icon: 26, label: 'w-[150px] text-[12px]', sub: 'text-[11px]', lock: 'size-[18px]' },
  card: { circle: 40, icon: 18, label: 'w-[76px] text-[11px]', sub: 'text-[10px]', lock: 'size-4' },
} as const;

export const SLOT_LABEL: Record<BubbleSlot, string> = { model: 'Chat Model', memory: 'Memory', tool: 'Tool' };

/** The big line: a tool's call name in snake case reads as words (`normalize_alert` → Normalize Alert); anything else as it is. */
export function bubbleLabel(b: Bubble): string {
  if (b.slot !== 'tool' || b.kind === 'knowledge' || !/^[a-z0-9]+(_[a-z0-9]+)+$/.test(b.label)) return b.label;
  return b.label
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The small line: the provider's name for a model, then the marks a person must see, then the source's own line. */
export function bubbleSub(b: Bubble): string | undefined {
  if (b.credential === 'missing') return 'needs a credential';
  if (b.withheld) return 'withheld';
  if (b.asksFirst) return 'asks first';
  if (b.fromProject) return 'project default';
  if (b.slot === 'model' && b.sub) {
    const brand = brandOfProvider(b.sub);
    return brand ? BRANDS[brand].title : b.sub;
  }
  return b.sub;
}

/** The logo: the node type's, else the bubble's own icon, else the model provider's brand, else the app's or the kind's. */
export function useBubbleIcon(): (b: Bubble) => string {
  const iconOf = useConnectionIcon();
  return (b) => {
    if (b.slot === 'model' && !b.icon && !b.nodeType) {
      const brand = brandOfProvider(b.sub ?? b.label);
      if (brand) return brandIcon(brand);
    }
    return iconOf({ kind: b.kind as ActorConnection['kind'], name: b.label, ...(b.nodeType && { nodeType: b.nodeType }), ...(b.icon && { icon: b.icon }) });
  };
}

export function BubbleView({ bubble: b, agentName, size = 'canvas', open = false, onOpen }: { bubble: Bubble; agentName: string; size?: keyof typeof SIZE; open?: boolean; onOpen?: () => void }) {
  const s = SIZE[size];
  const icon = useBubbleIcon()(b);
  const sub = bubbleSub(b);
  const title = bubbleTitle(agentName, b);
  const body = (
    <>
      <span
        className={cn(
          'relative grid shrink-0 place-items-center rounded-full border-[1.5px] bg-sf transition-colors duration-150 motion-reduce:transition-none',
          b.pending === 'added' || b.movedHere ? 'border-dashed border-ac' : b.pending === 'changed' ? 'border-ac' : 'border-hair',
          b.pending === 'removed' && 'opacity-50',
          b.withheld && 'opacity-60 grayscale',
          open && 'ring-2 ring-ac/40',
        )}
        style={{ width: s.circle, height: s.circle }}
      >
        <NodeIcon icon={icon} size={s.icon} strokeWidth={1.7} className="text-t1" />
        {b.asksFirst && (
          <span aria-hidden className={cn('absolute -right-1 -top-1 grid place-items-center rounded-full border-2 border-sf bg-warn text-bg', s.lock)}>
            <Lock className="size-2.5" strokeWidth={2.4} />
          </span>
        )}
        {(b.pending === 'added' || b.pending === 'changed' || b.movedHere) && <span aria-hidden className="absolute -left-0.5 -top-0.5 size-2.5 rounded-full border-2 border-sf bg-ac" />}
      </span>
      <span className={cn('mt-1 line-clamp-2 text-center font-semibold leading-tight text-t1 [overflow-wrap:anywhere]', s.label, b.pending === 'removed' && 'line-through')}>{bubbleLabel(b)}</span>
      {sub && <span className={cn('text-center leading-tight', s.sub, b.credential === 'missing' ? 'text-rd' : 'text-t3')}>{sub}</span>}
    </>
  );
  const common = { 'data-testid': 'bubble', 'data-bubble': b.id, 'data-slot': b.slot, ...(b.pending && { 'data-pending': b.pending }), title, 'aria-label': title };
  return onOpen ? (
    <button type="button" {...common} aria-expanded={open} onClick={onOpen} className="flex flex-col items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ac/40 max-md:min-h-11 max-md:min-w-11">
      {body}
    </button>
  ) : (
    <div {...common} className="flex flex-col items-center">
      {body}
    </div>
  );
}

/**
 * An agent's bubbles under a small tile with its three slots, each slot's bubbles hanging on a dashed line: the canvas's
 * picture at card size, for Spotlight's agent card before Create (and after, from the same card). Wraps on a phone; no
 * horizontal scroll at 390 px. `onOpen` makes each bubble a button (the card shows that bubble's detail under the diagram).
 */
export function BubbleDiagram({ agentName, bubbles, openId, onOpen, className }: { agentName: string; bubbles: readonly Bubble[]; openId?: string; onOpen?: (b: Bubble) => void; className?: string }) {
  const of = (slot: BubbleSlot) => bubbles.filter((b) => b.slot === slot).sort(bubbleOrder);
  return (
    <div data-testid="bubble-diagram" role="group" aria-label={`${agentName}: model, memory, tools and knowledge`} className={cn('rounded-lg border border-hair bg-sf2 p-2', className)}>
      <div className="truncate rounded-md border border-hair bg-sf px-2 py-1 text-center text-[11.5px] font-semibold text-t1">{agentName}</div>
      <div className="grid grid-cols-[minmax(76px,auto)_minmax(76px,auto)_minmax(0,1fr)] gap-x-2">
        {(['model', 'memory', 'tool'] as const).map((slot) => (
          <div key={slot} className="flex min-w-0 flex-col items-center">
            <span className="mt-1 text-[10px] text-t3">{SLOT_LABEL[slot]}</span>
            <span aria-hidden className="h-3 border-l-[1.5px] border-dashed border-t3" />
            <div className="flex flex-wrap justify-center gap-x-1.5 gap-y-1.5">
              {of(slot).map((b) => (
                <BubbleView key={b.id} bubble={b} agentName={agentName} size="card" open={openId === b.id} {...(onOpen && { onOpen: () => onOpen(b) })} />
              ))}
              {of(slot).length === 0 && <span className="text-[10.5px] text-t3">none</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
