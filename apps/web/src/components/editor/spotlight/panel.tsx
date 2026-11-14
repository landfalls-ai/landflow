'use client';
/** The Spotlight panel (see ./index.tsx). */
import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronDown, CircleCheck, CircleStop, Hand, Loader2, PanelRightClose, PanelRightOpen, Sparkles, Square, SquarePen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAssistant } from '../assistant';
import { useEditor } from '../store';
import { isPhone } from '@/lib/client/use-phone';
import { lastOutcomeOf, lastRunOf, openNeedOf, stepsOf, stoppedAtOf, titleOf } from '../timeline';
import { Composer, focusSpotlight } from './composer';
import { AutonomousSwitch } from './proposal';
import { Timeline } from './timeline-view';

/**
 * While Spotlight works, the canvas keeps the whole flow in view as the panel and the logs change its size; once it is on
 * one node (fixing it, or it needs the person there), the camera goes to that node at a zoom you can read instead.
 */
function useFlowInView(working: boolean, focus: string | undefined) {
  const { fitView, setCenter, getZoom, getViewport } = useReactFlow();
  const nodeCount = useEditor((s) => s.nodes.length);
  const [size, setSize] = useState('');
  const moved = useRef(false);
  useEffect(() => {
    const pane = document.querySelector('.react-flow');
    if (!working || !pane || typeof ResizeObserver === 'undefined') return;
    moved.current = false;
    const observer = new ResizeObserver(() => setSize(`${pane.clientWidth}x${pane.clientHeight}`));
    observer.observe(pane);
    // The person zooms or pans: the view is theirs until Spotlight starts again.
    const mine = () => (moved.current = true);
    pane.addEventListener('wheel', mine, { passive: true });
    pane.addEventListener('pointerdown', mine);
    return () => {
      observer.disconnect();
      pane.removeEventListener('wheel', mine);
      pane.removeEventListener('pointerdown', mine);
    };
  }, [working]);
  // On a node: pan there, at least at a readable zoom. A node out of the flow's fit is the point of it.
  useEffect(() => {
    if (!focus || moved.current) return;
    const node = useEditor.getState().nodes.find((n) => n.data.wf.name === focus);
    if (!node) return;
    const timer = setTimeout(() => {
      if (moved.current) return;
      const pane = document.querySelector('.react-flow');
      const width = node.measured?.width ?? 200;
      const height = node.measured?.height ?? 80;
      const narrow = (pane?.clientWidth ?? 1000) < 600;
      // A desktop shows the whole flow readably at fit: move only when the node is out of the clear part of the canvas
      // (not under the zoom rail, the toolbar and minimap, or the Execute bar) or too small to read, and then pan rather
      // than zoom when the zoom is readable already.
      const zoom = getZoom();
      if (!narrow && pane) {
        const { x, y } = getViewport();
        const left = node.position.x * zoom + x;
        const top = node.position.y * zoom + y;
        const clear = { left: 72, top: 48, right: pane.clientWidth - 300, bottom: pane.clientHeight - 120 };
        if (zoom >= 0.75 && left >= clear.left && top >= clear.top && left + width * zoom <= clear.right && top + height * zoom <= clear.bottom) return;
      }
      void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: narrow ? Math.max(zoom, 0.85) : zoom >= 0.75 ? zoom : 1, duration: 500 });
    }, 200);
    return () => clearTimeout(timer);
  }, [focus, size, setCenter, getZoom, getViewport]);
  useEffect(() => {
    if (!working || !nodeCount || moved.current || focus) return;
    const timer = setTimeout(() => {
      const narrow = (document.querySelector('.react-flow')?.clientWidth ?? 1000) < 600;
      void fitView({ padding: narrow ? { left: '16px', top: '16px', bottom: '72px', right: '64px' } : { left: '72px', top: '56px', bottom: '120px', right: '72px' }, duration: 500, maxZoom: 1 });
    }, 160);
    return () => clearTimeout(timer);
  }, [working, nodeCount, size, fitView, focus]);
}

/** Whole seconds since `on` turned true; 0 while off. */
function useSeconds(on: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!on) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return seconds;
}


/**
 * The Spotlight panel, at the right of the editor. Desktop: a column beside the canvas (and its logs), folded to a thin
 * strip. Phone: a sheet under the canvas (which shrinks above it), folded to its header, a line and the input.
 */
export function SpotlightPanel({ hiddenOnPhone = false, hidden = false }: { hiddenOnPhone?: boolean; /** Stays mounted and keeps its conversation, but shows nothing (the Spotlight | Chat switch). */ hidden?: boolean }) {
  const collapsed = useAssistant((s) => s.collapsed);
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents);
  const drafting = useAssistant((s) => s.drafting);
  const testing = useAssistant((s) => Boolean(s.testing));
  const pending = useAssistant((s) => s.pending);
  const fixing = useAssistant((s) => s.fixing);
  const fixingName = useEditor((s) => (fixing ? s.nodes.find((n) => n.id === fixing)?.data.wf.name : undefined));
  const waiting = items.reduce((n, item) => n + (item.role === 'assistant' ? item.parts.filter((p) => p.kind === 'proposal' && !p.proposal.state).length : 0), 0);
  const designing = agents.find((a) => a.state === 'designing')?.name;
  const live = pending || drafting;
  const busy = live || testing || Boolean(designing);
  // How the last test ended, since the person last asked for something: older verdicts no longer hold.
  const run = lastRunOf(items.slice(items.findLastIndex((i) => i.role === 'user' && !i.auto) + 1));
  const need = openNeedOf(items);
  const ended = lastOutcomeOf(items);
  const title = titleOf({
    drafting,
    testing,
    pending,
    fixingName,
    designing,
    hasItems: items.length > 0,
    ...(need && !testing && { needs: need.what }),
    ...(run && run.state !== 'running' && !testing && { lastRun: run.state, stoppedAt: stoppedAtOf(run) }),
    // A pass the review said no to stopped, whatever the last run said.
    ...(ended && !testing && { lastRun: 'failed' as const, stoppedAt: ended.node }),
  });
  const { steps } = stepsOf(items, { live, drafting, agents });
  const latest = steps.at(-1)?.text;
  // The node Spotlight is on: the one it fixes, or the one it needs the person at.
  // An open need is where Spotlight waits only while it is idle: a new session fits the flow again.
  useFlowInView(drafting || testing, fixingName ?? (testing || drafting ? undefined : need?.node));

  const panel = useRef<HTMLElement>(null);

  // Toasts (bottom right) keep clear of the panel: left of the column, above the phone sheet.
  useEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const body = document.body.style;
    const phone = window.matchMedia('(max-width: 767px)');
    const update = () => {
      body.setProperty('--toast-right', phone.matches ? '16px' : `${el.offsetWidth + 16}px`);
      body.setProperty('--toast-bottom', phone.matches ? `${el.offsetHeight + 12}px` : '24px');
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => {
      observer.disconnect();
      body.removeProperty('--toast-right');
      body.removeProperty('--toast-bottom');
    };
  }, []);

  const { setCollapsed, reset, stop } = useAssistant.getState();
  const phoneHeight = useAssistant((s) => s.phoneHeight);
  const drag = useRef<number>(undefined);
  // One set of colours: violet while it works, amber when it needs you, green when it passed; a stop is neutral.
  const icon = busy ? (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" />
  ) : need ? (
    <Hand className="size-3.5 shrink-0 text-warn" />
  ) : run?.state === 'passed' && !ended ? (
    <CircleCheck className="size-3.5 shrink-0 text-gn" />
  ) : run?.state === 'failed' || ended ? (
    <CircleStop className="size-3.5 shrink-0 text-t3" />
  ) : (
    <Sparkles className="size-3.5 shrink-0 text-viz-7" />
  );
  // Drafting is one request: the header counts its seconds, and Stop cancels it.
  const draftSeconds = useSeconds(drafting);

  return (
    <aside
      ref={panel}
      aria-label="Spotlight"
      hidden={hidden}
      className={cn(
        'z-30 flex flex-col border-hair bg-sf',
        hidden && 'hidden',
        // One panel at a time under a phone's canvas.
        hiddenOnPhone && 'max-md:hidden',
        // Phone: a sheet under the canvas, which shrinks to the space above it.
        'max-md:shrink-0 max-md:rounded-t-2xl max-md:border-t',
        // Phone: three heights, folded to its bar, peek (the newest of the timeline) and half.
        collapsed ? 'max-md:max-h-[40dvh]' : phoneHeight === 'peek' ? 'max-md:h-[34dvh]' : 'max-md:h-[52dvh]',
        // Desktop: a column beside the canvas.
        'md:relative md:shrink-0 md:border-l',
        collapsed ? 'md:w-11' : 'md:w-[360px]',
      )}
    >
      {/* Desktop, folded: a strip with what Spotlight is doing. */}
      {collapsed && (
        <button
          type="button"
          onClick={() => focusSpotlight()}
          title={latest ? `${title}: ${latest}` : 'Show Spotlight (⌘I)'}
          aria-label="Show Spotlight"
          className="hidden flex-1 flex-col items-center gap-3 py-3 text-t3 hover:bg-acdim hover:text-t1 md:flex"
        >
          <PanelRightOpen className="size-4" />
          {icon}
          {waiting > 0 && <span className="rounded-full bg-viz-7 px-1.5 text-[10.5px] font-semibold leading-4 text-bg">{waiting}</span>}
          <span className="text-[11.5px] font-semibold text-t2 [writing-mode:vertical-rl]">{title}</span>
        </button>
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'md:hidden')}>
        <div
          // A phone: drag the header up or down for the next height (the chevron goes between the bar and half).
          onPointerDown={(e) => {
            if (!isPhone() || (e.target as HTMLElement).closest('button, input, [role="switch"]')) return;
            drag.current = e.clientY;
            // The finger leaves the header as it drags: the header still gets the release.
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            const start = drag.current;
            drag.current = undefined;
            if (start === undefined || Math.abs(e.clientY - start) < 24) return;
            const heights = ['bar', 'peek', 'half'] as const;
            const at = collapsed ? 0 : phoneHeight === 'peek' ? 1 : 2;
            useAssistant.getState().setDock(heights[Math.max(0, Math.min(2, at + (e.clientY < start ? 1 : -1)))]);
          }}
          onPointerCancel={() => (drag.current = undefined)}
          className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-hair pl-3 pr-1.5 max-md:touch-none max-md:select-none"
        >
          <span className="absolute left-1/2 top-1 block h-1 w-8 -translate-x-1/2 rounded-full bg-hair md:hidden" aria-hidden />
          {icon}
          <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1" title={latest}>
            {title}
          </span>
          {/* Outside the live region: a screen reader would read the title again every second. */}
          {drafting && draftSeconds >= 2 && (
            <span aria-hidden className="-ml-1 shrink-0 text-[13px] text-t3 tabular-nums">
              · {draftSeconds} s
            </span>
          )}
          <AutonomousSwitch compact={live || testing} />
          {/* The composer has its own Stop while a reply streams; this one is for a test run, or when the panel is folded. */}
          {(collapsed ? live || testing : testing && !live) && (
            <button title="Stop" aria-label="Stop" onClick={stop} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-rddim hover:text-rd disabled:opacity-40 max-md:size-11">
              <Square className="size-3" fill="currentColor" />
            </button>
          )}
          <button title="New conversation" aria-label="New conversation" onClick={reset} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11">
            <SquarePen className="size-3.5" />
          </button>
          <button
            title={collapsed ? 'Show the conversation' : 'Hide the conversation'}
            aria-label={collapsed ? 'Show the conversation' : 'Hide the conversation'}
            aria-expanded={!collapsed}
            onClick={() => {
              // A phone unfolds to half; peek is a drag away.
              if (collapsed && isPhone()) useAssistant.setState({ phoneHeight: 'half' });
              setCollapsed(!collapsed);
              // Folding on a desktop hides this button: the strip that unfolds it takes the focus.
              if (!collapsed) requestAnimationFrame(() => document.querySelector<HTMLElement>('aside[aria-label="Spotlight"] button[aria-label="Show Spotlight"]')?.focus());
            }}
            className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11"
          >
            <PanelRightClose className="hidden size-4 md:block" />
            <ChevronDown className={cn('size-4 transition-transform md:hidden', collapsed && 'rotate-180')} />
          </button>
        </div>
        {collapsed ? (
          // Phone, folded: the step Spotlight is on.
          latest && (
            <p className="flex items-center gap-1.5 truncate px-3 py-1.5 text-[12px] text-t2 md:hidden">
              <span className="truncate">{latest}</span>
            </p>
          )
        ) : items.length || agents.length ? (
          <Timeline live={live} status={drafting ? 'Drafting the flow from the node catalog…' : undefined} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 px-4 py-4 text-[12.5px] leading-snug text-t3">
            <p className="font-semibold text-t2">Build and fix this workflow with Spotlight.</p>
            <p>Describe a flow on an empty canvas and it drafts it, tests it and fixes what fails. On a flow, ask for a change; it uses your agents, or designs one on a local model. Type @ to point at a node.</p>
          </div>
        )}
        <Composer />
      </div>
    </aside>
  );
}
