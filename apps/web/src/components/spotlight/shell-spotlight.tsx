'use client';
/**
 * The one Spotlight (docs/spotlight.md#one-spotlight): a panel at the right of every page but the editor, opened with ⌘K
 * (⌘I does the same), and a bottom sheet on a phone. The editor keeps its own column, which is the builder: there ⌘K
 * focuses that column and this panel stays away (unless a person asks the brain there instead, or something asks about a
 * thing: then the panel shows, and the keys still go to the builder).
 *
 * Its two backends are the builder (the editor's own panel) and the brain (`AskPanel`); the chip in its header says which
 * it is doing here. The conversation lives in this component, mounted once in the layout, so it stays while a person
 * moves between pages. The Brain page publishes the open file (`setBrainFile`); `landflow:ask-about` sets about mode.
 */
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronsUpDown } from 'lucide-react';
import { useViewer } from '../auth/viewer';
import { AskPanel, ASK_INPUT, useAskConversation, type AskTag } from '../brain/wiki/ask-panel';
import { bubblesFor } from '../brain/wiki/spotlight';
import { WikiNav } from '../brain/wiki/parts';
import { Sheet } from '../ui/sheet';
import { usePhone } from '@/lib/client/use-phone';
import { isChromelessPage } from '@/lib/shared/auth-paths';
import { listenAskAbout, takeAskAbout } from './ask-about-listener';
import { AGENT_CHANGED } from '@/lib/client/agent-change'; // AG04:
import { api } from '@/lib/client/api'; // AG04:
import {
  closeSpotlight,
  agentPageId, // AG04:
  isEditorRoute,
  isMac,
  keyAction,
  modalOpen,
  setSpotlightState,
  shellPanelShows,
  showBuilderInstead,
  spotlightMode,
  toggleResult,
  useSpotlightState,
  withOpen,
  withoutAbout,
  type SpotlightMode,
} from './context';
import { ModeChip } from './mode-chip';
import { AgentChangePanel } from './agent-change-panel'; // AG04:

const WIDTH_KEY = 'landflow-shell-spotlight-width';
export const PANEL_WIDTH = { min: 320, default: 360, max: 560 } as const;
const clampWidth = (w: number) => Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Math.round(w)));

/** The phone sheet's three heights, as the editor's: a peek, half, and nearly all of the screen. */
export const SHEET_HEIGHTS = [
  { id: 'peek', className: 'h-[34dvh]', next: 'Taller' },
  { id: 'half', className: 'h-[52dvh]', next: 'Taller' },
  { id: 'tall', className: 'h-[85dvh]', next: 'Shorter' },
] as const;

/** The panel's width, kept in this browser and read after mount so the server's HTML matches the first render. */
function usePanelWidth(): [number, (w: number, keep?: boolean) => void] {
  const [width, setWidth] = useState<number>(PANEL_WIDTH.default);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (saved) setWidth(clampWidth(saved));
    } catch {
      // Private mode: the default.
    }
  }, []);
  return [
    width,
    (w, keep) => {
      const next = clampWidth(w);
      setWidth(next);
      if (keep)
        try {
          localStorage.setItem(WIDTH_KEY, String(next));
        } catch {
          // Private mode: the width holds for this page.
        }
    },
  ];
}

// AG04: the name of the agent whose page this is, for the chip ("Changing Alert triager"); fetched while the panel shows, and again when a change renames it.
function useAgentName(agentId: string | undefined, enabled: boolean): string | undefined {
  const [named, setNamed] = useState<{ id: string; name: string }>();
  useEffect(() => {
    if (!agentId || !enabled) return;
    let live = true;
    const load = () =>
      api<{ agent: { name: string } }>(`/api/agents/${agentId}`)
        .then(({ agent }) => live && setNamed({ id: agentId, name: agent.name }))
        .catch(() => {});
    void load();
    const again = (e: Event) => (e as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId && void load();
    window.addEventListener(AGENT_CHANGED, again);
    return () => {
      live = false;
      window.removeEventListener(AGENT_CHANGED, again);
    };
  }, [agentId, enabled]);
  return named && named.id === agentId ? named.name : undefined;
}

/** The mounted-once host: keys, the ask-about event, the desktop column and the phone sheet. */
export function ShellSpotlight() {
  const pathname = usePathname();
  const viewer = useViewer();
  const phone = usePhone();
  const state = useSpotlightState();
  const conversation = useAskConversation();
  const [width, setWidth] = usePanelWidth();
  const [height, setHeight] = useState(1);
  const chromeless = !viewer || isChromelessPage(pathname);
  const editor = isEditorRoute(pathname);
  const shows = !chromeless && shellPanelShows(pathname, state);
  const agentId = agentPageId(pathname); // AG04:
  const agentName = useAgentName(agentId, shows);
  const stateRef = useRef({ state, pathname });
  stateRef.current = { state, pathname };

  // ⌘K and ⌘I: open, focus, or (pressed again from the box) close. The editor handles its own (its column is the builder).
  useEffect(() => {
    if (chromeless) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || keyAction(e, { brain: false, mac: isMac() }) !== 'toggle') return;
      const { state: s, pathname: path } = stateRef.current;
      if (isEditorRoute(path) || modalOpen(document)) return;
      e.preventDefault();
      const result = toggleResult(shellPanelShows(path, s), document.activeElement?.id === ASK_INPUT);
      if (result === 'close') return closeSpotlight();
      if (result === 'open') setSpotlightState((cur) => withOpen(cur, true));
      setTimeout(() => document.getElementById(ASK_INPUT)?.focus(), 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chromeless]);

  // An ask-about about something else starts a new conversation (its starters show, and no unrelated history goes with it).
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  useEffect(() => listenAskAbout(window, (detail) => takeAskAbout(detail, conversationRef.current)), []);

  // Leaving the editor drops "ask the brain instead": the next editor starts as the builder.
  useEffect(() => {
    if (!editor && !agentId) setSpotlightState((s) => (s.askInstead ? { ...s, askInstead: false } : s)); // AG04: an agent's page keeps it too
  }, [editor, agentId]);

  // Toasts keep clear of the column (the editor does the same for its own).
  useEffect(() => {
    if (!shows || phone) return;
    const body = document.body.style;
    body.setProperty('--toast-right', `${width + 16}px`);
    return () => void body.removeProperty('--toast-right');
  }, [shows, phone, width]);

  if (chromeless || !shows) return null;
  const mode = spotlightMode(pathname, state, undefined, agentName);
  const switchTo = switchFor(mode, editor, agentId ? { id: agentId, name: agentName ?? 'this agent' } : undefined /* AG04: */);
  const panel = <PanelBody mode={mode} conversation={conversation} file={state.brainFile} about={state.about?.starters} />;
  // On the Brain page a link in an answer opens in the workbench (a route change would remount it).
  // (Always the Provider: entering or leaving /brain must not remount the panel and lose a half-typed question.)
  const body = <WikiNav.Provider value={state.openBrainPage}>{panel}</WikiNav.Provider>;

  if (phone) {
    const sheet = SHEET_HEIGHTS[height]!;
    return (
      <Sheet
        open
        onClose={closeSpotlight}
        className={sheet.className}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ModeChip mode={mode} className="min-w-0" />
            <button
              type="button"
              onClick={() => setHeight((h) => (h + 1) % SHEET_HEIGHTS.length)}
              aria-label={`${sheet.next} (${height + 1} of ${SHEET_HEIGHTS.length})`}
              title={sheet.next}
              className="ml-auto grid size-11 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"
            >
              <ChevronsUpDown className="size-4" aria-hidden />
            </button>
          </span>
        }
      >
        <div className="-mx-4 -mb-4 flex h-full flex-col">
          {/* The chip sits in a clipped heading, so its offer is a plain button here. */}
          {switchTo && (
            <button type="button" onClick={switchTo.run} className="flex min-h-11 w-full shrink-0 items-center border-b border-hair px-4 text-left text-[13px] text-ac">
              {switchTo.label}
            </button>
          )}
          <div className="min-h-0 flex-1">{body}</div>
        </div>
      </Sheet>
    );
  }
  return (
    <aside aria-label="Spotlight" style={{ width }} className="sticky top-0 hidden h-screen shrink-0 flex-col border-l border-hair bg-sf md:z-30 md:flex">
      <ResizeEdge width={width} onChange={setWidth} />
      {body}
    </aside>
  );
}

/** The drag edge at the panel's left: wider to the left, kept in this browser; arrow keys do the same. */
function ResizeEdge({ width, onChange }: { width: number; onChange: (w: number, keep?: boolean) => void }) {
  const drag = useRef<{ x: number; w: number }>(undefined);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Spotlight"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, w: width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => drag.current && onChange(drag.current.w + (drag.current.x - e.clientX))}
      onPointerUp={(e) => {
        if (drag.current) onChange(drag.current.w + (drag.current.x - e.clientX), true);
        drag.current = undefined;
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onChange(width + 24, true);
        else if (e.key === 'ArrowRight') onChange(width - 24, true);
      }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-acdim focus-visible:bg-acdim focus-visible:outline-none"
    />
  );
}

/** What the panel holds: the brain's Q&A, about the open page, about a thing it was sent about, or about everything. */
function PanelBody({ mode, conversation, file, about }: { mode: SpotlightMode; conversation: ReturnType<typeof useAskConversation>; file?: { ref: string; name: string; page: boolean; topShared?: string; model?: string }; about?: string[] }) {
  const phone = usePhone();
  const heading = phone ? undefined : <ModeChipFor mode={mode} />;
  const common = { onClose: closeSpotlight, onSubjectOff: () => setSpotlightState(withoutAbout), conversation, ...(file?.model && { model: file.model }), ...(heading && { heading }) };
  if (mode.kind === 'about') {
    const { ref } = mode;
    const tag: AskTag = { type: ref.type, id: ref.id, name: ref.name, ...(ref.workflowId && { workflowId: ref.workflowId }) };
    // A brain page is asked about as a page (the same chip the workbench gave it).
    return ref.type === 'brainPage' ? (
      <AskPanel {...common} about={{ ref: ref.id, name: ref.name }} starters={about?.length ? about : bubblesFor({ ref: ref.id, name: ref.name, page: true })} />
    ) : (
      <AskPanel {...common} subject={tag} starters={about?.length ? about : bubblesFor()} />
    );
  }
  // AG04: on an agent's page: ask for a change to it, or ask about it.
  if (mode.kind === 'agent') return <AgentChangePanel agentId={mode.agentId} name={mode.name} onClose={closeSpotlight} conversation={conversation} {...(heading && { heading })} {...(file?.model && { model: file.model })} starters={[]} />;
  const here = mode.kind === 'brain' && mode.pageId && file?.page ? file : undefined;
  return <AskPanel {...common} {...(here && { about: { ref: here.ref, name: here.name } })} starters={bubblesFor(file)} />;
}

/** The header chip with its "instead" offer, where the shell can make one. */
function ModeChipFor({ mode }: { mode: SpotlightMode }) {
  const path = usePathname();
  const switchTo = switchFor(mode, isEditorRoute(path), agentPageId(path) /* AG04: */ ? { id: agentPageId(path)!, name: mode.kind === 'agent' ? mode.name : 'this agent' } : undefined);
  return <ModeChip mode={mode} {...(switchTo && { switchTo })} />;
}

/** The other mode a chip offers: from about, the general brain; on the editor (the brain was asked for there), the builder. */
export function switchFor(mode: SpotlightMode, editor: boolean, agent?: { id: string; name: string } /* AG04: */): { label: string; run: () => void } | undefined {
  if (mode.kind === 'about')
    return { label: 'Ask the brain instead', run: () => setSpotlightState((s) => ({ ...withoutAbout(s), open: true, ...((editor || agent) && { askInstead: true }) })) };
  // AG04: on an agent's page the chip offers the brain, and from the brain the change panel again.
  if (agent && mode.kind === 'agent') return { label: 'Ask the brain instead', run: () => setSpotlightState((s) => ({ ...s, open: true, askInstead: true })) };
  if (agent && mode.kind === 'brain' && !editor) return { label: `Change ${agent.name} instead`, run: () => setSpotlightState((s) => ({ ...s, open: true, askInstead: false })) };
  return editor ? { label: 'Build here instead', run: showBuilderInstead } : undefined;
}
