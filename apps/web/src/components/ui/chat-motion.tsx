'use client';
/**
 * Motion for the chat kit (docs/assistant.md#chat-surfaces): lists that grow without jumping, a Working line that
 * cross-fades into its reply, a streaming caret. Built on `motion` with its features loaded lazily, so a chat page
 * pays for the small shell only. Transform and opacity move; width and padding never do, so the phone does not reflow.
 * `MotionConfig reducedMotion="user"` stops the transforms under Reduce motion. Every piece works alone: one with no
 * `ChatMotion` above it wraps itself.
 */
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, LazyMotion, MotionConfig, m, useReducedMotion } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatMarkdown, Working } from './chat';

const loadFeatures = () => import('motion/react').then((mod) => mod.domAnimation);
const Inside = createContext(false);

/** The motion shell: lazy features, and Reduce motion honoured. Put it once above a chat, or let each piece wrap itself. */
export function ChatMotion({ children }: { children: ReactNode }) {
  return (
    <Inside.Provider value>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={loadFeatures} strict>
          {children}
        </LazyMotion>
      </MotionConfig>
    </Inside.Provider>
  );
}

/** Wraps in the shell when none is above. */
function Shell({ children }: { children: ReactNode }) {
  return useContext(Inside) ? <>{children}</> : <ChatMotion>{children}</ChatMotion>;
}

const NEAR_BOTTOM = 48;

/**
 * Whether a scroll event means the reader left the bottom. While a programmatic scroll is in flight, only a move up
 * unpins; reaching the bottom pins again.
 */
export function nextPinned({ gap, prevTop, top, programmatic }: { gap: number; prevTop: number; top: number; programmatic: boolean }): boolean {
  if (gap <= NEAR_BOTTOM) return true;
  return programmatic ? top >= prevTop : false;
}

/**
 * A chat's scroll area. A new child rises in (180 ms, 30 ms apart; the first render does not animate). It stays at the
 * bottom while the reader is within 48 px of it; when they have scrolled up and something new arrives, "Jump to latest"
 * shows. `className` styles the scroll area itself.
 */
export function ChatList({ children, className }: { children: ReactNode; className?: string }) {
  const items = Children.toArray(children);
  const keys = items.map((c, i) => (isValidElement(c) && c.key != null ? String(c.key) : String(i)));
  const known = useRef<Set<string> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const gliding = useRef(false);
  const lastTop = useRef(0);
  const reduced = useReducedMotion();
  const [away, setAway] = useState(false);
  const lastKey = keys[keys.length - 1];
  const prevLast = useRef(lastKey);

  // Keys seen at the first render do not animate; those that arrive later do.
  const fresh = keys.map((k) => known.current !== null && !known.current.has(k));
  useEffect(() => {
    known.current = new Set(keys);
  });

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    const glide = smooth && !reduced;
    gliding.current = glide;
    el.scrollTo({ top: el.scrollHeight, behavior: glide ? 'smooth' : 'auto' });
  }, [reduced]);

  useLayoutEffect(() => {
    toBottom();
  }, [toBottom]);

  useLayoutEffect(() => {
    if (lastKey === prevLast.current) return;
    prevLast.current = lastKey;
    if (pinned.current) toBottom(true);
    else setAway(true);
  }, [lastKey, toBottom]);

  // A reply that grows in place (streaming, a step list opening) keeps the reader at the bottom too.
  useEffect(() => {
    const node = content.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = nextPinned({ gap, prevTop: lastTop.current, top: el.scrollTop, programmatic: gliding.current });
    lastTop.current = el.scrollTop;
    if (gap <= NEAR_BOTTOM) {
      gliding.current = false;
      setAway(false);
    }
  };

  let order = 0;
  return (
    <Shell>
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className={cn('h-full min-h-0 overflow-y-auto', className)}>
          <div ref={content} className="space-y-3">
            {items.map((child, i) => (
              <m.div
                key={keys[i]}
                initial={fresh[i] ? { opacity: 0, y: 6 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut', delay: fresh[i] ? order++ * 0.03 : 0 }}
              >
                {child}
              </m.div>
            ))}
          </div>
        </div>
        <AnimatePresence>
          {away && (
            <m.button
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.16 }}
              onClick={() => {
                pinned.current = true;
                setAway(false);
                toBottom(true);
              }}
              className="absolute bottom-2 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1 rounded-full border border-hair bg-sf px-3 text-[12px] font-semibold text-t1 shadow-pop hover:bg-acdim max-md:h-11"
            >
              <ArrowDown className="size-3.5" /> Jump to latest
            </m.button>
          )}
        </AnimatePresence>
      </div>
    </Shell>
  );
}

/** Height auto and 0 with a fade, 200 ms. Closed, it is `aria-hidden` and unfocusable; `keepMounted` keeps its content in the page. */
export function Collapsible({ open, children, keepMounted, className }: { open: boolean; children: ReactNode; keepMounted?: boolean; className?: string }) {
  return (
    <Shell>
      <AnimatePresence initial={false}>
        {(open || keepMounted) && (
          <m.div
            key="body"
            aria-hidden={!open}
            inert={!open}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            style={{ overflow: 'hidden' }}
            className={className}
          >
            {children}
          </m.div>
        )}
      </AnimatePresence>
    </Shell>
  );
}

/** The Working line and the reply that replaces it cross-fade (160 ms), so a reply never pops in place of the spinner. */
export function StatusSwap({ working, label, children }: { working: boolean; label?: string; children: ReactNode }) {
  return (
    <Shell>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.div key={working ? 'working' : 'reply'} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          {working ? <Working label={label} /> : children}
        </m.div>
      </AnimatePresence>
    </Shell>
  );
}

/** A reply as Markdown, with a soft caret after it while it streams (static under Reduce motion). */
export function StreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div>
      <ChatMarkdown text={text} />
      {streaming && <span aria-hidden className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-0.5 rounded-full bg-t2 animate-caret" />}
    </div>
  );
}
