'use client';
/** The Spotlight panel (see ./index.tsx). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronDown, CircleCheck, CircleStop, Hand, Loader2, PanelRightClose, PanelRightOpen, Sparkles, Square, SquarePen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { applyChanges, editorLookup, undos, useAssistant } from '../assistant';
import { ChatEmpty } from '../../ui/chat';
import { Button } from '../../ui/button';
import { EMPTY_LINE, foldedBar } from './states';
import { checkCards, DELETED_AGENT_NOTE, deletedCards, markStale, planKeeping, recordPlan, restore, shouldResume } from '../spotlight-history';
import { ConversationHistory } from '../../ui/conversation-history';
import { useConversation } from '@/lib/client/conversations';
import { usePreference } from '@/lib/client/preferences';
import { api, ApiError } from '@/lib/client/api';
import type { ConversationItem, ConversationRecord } from '@/lib/shared/conversations';
import { useEditor } from '../store';
import { isPhone } from '@/lib/client/use-phone';
import { draftPhase, draftStatus, lastOutcomeOf, lastRunOf, openNeedOf, sessionIsWaiting, stepsOf, stoppedAtOf, titleOf } from '../timeline';
import { Composer, focusSpotlight } from './composer';
import { AsksFirstNote, AutonomousExplainer, AutonomousSwitch, useAutonomousExplainer } from './proposal';
import { Timeline } from './timeline-view';
import { useAskParam } from './ask-param';
import { ModelPicker } from './model-picker'; // SB19:
import { ModeChip } from '../../spotlight/mode-chip';
import { showBrainInstead } from '../../spotlight/context';

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

/** Apply every change that waits (the phone bar's Apply): one step each, with its Undo. */
function applyWaiting() {
  const open = useAssistant
    .getState()
    .items.flatMap((item) => (item.role === 'assistant' ? item.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [{ itemId: item.id, proposal: p.proposal }] : [])) : []));
  if (!open.length) return;
  const label = open.length === 1 ? open[0].proposal.summary : `${open.length} changes`;
  const ok = applyChanges(open.map((o) => ({ ops: o.proposal.ops, kind: 'proposal' as const })), label, {
    onApplied: ({ undo }) => {
      for (const o of open) undos.set(o.proposal.id, undo);
    },
  });
  if (ok) for (const o of open) useAssistant.getState().setProposalState(o.itemId, o.proposal.id, 'applied');
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
 * Spotlight's conversation is kept per workflow (docs/assistant.md#conversation-history): each turn is stored when it is
 * said or has finished, the last conversation of this workflow comes back under "Earlier" when the editor opens, and the
 * history button opens another in place. With the person's "keep conversations" off nothing is stored and nothing comes back.
 */
function useSpotlightKeeping() {
  const workflowId = useEditor((s) => s.workflowId);
  const keeping = usePreference('keepConversations');
  const conversation = useConversation({ surface: 'spotlight', subjectType: 'workflow', subjectId: workflowId || undefined });
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents); // AG11:
  const live = useAssistant((s) => s.pending || s.drafting);
  const boundTo = useAssistant((s) => s.workflowId);
  const appendRef = useRef(conversation.append);
  appendRef.current = conversation.append;
  const here = Boolean(workflowId) && boundTo === workflowId;

  // Show a stored conversation under "Earlier", its waiting proposals checked against the workflow as it is now.
  const show = useCallback((turns: Parameters<typeof restore>[0], replace: boolean, id: string) => {
    const back = restore(turns);
    const editor = useEditor.getState();
    const checked = checkCards(markStale(back.items, editor.toWorkflow(), editorLookup()), editor.workflowId); // AG11: a waiting card keeps Create only here
    const before = useAssistant.getState().kept.stored;
    const next = replace ? back.stored : { turns: new Set([...before.turns, ...back.stored.turns]), proposals: new Map([...before.proposals, ...back.stored.proposals]), cards: new Map([...before.cards, ...back.stored.cards]) /* AG11: */ };
    useAssistant.getState().showEarlier(checked, { replace, agents: back.agents /* AG11: */ });
    useAssistant.getState().setKept(id, next);
    // AG11: a created card looks at its agent once: a 404 says it was deleted, and its row goes.
    void deletedCards(checked, (agentId) => api(`/api/agents/${agentId}`, { background: true }).then(() => false, (e) => (e instanceof ApiError && e.status === 404 ? true : Promise.reject(e)))).then((gone) => {
      if (useAssistant.getState().kept.id !== id) return; // AG11: another conversation was opened meanwhile: its cards are not these
      for (const [itemId, agentId] of gone) {
        useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'agentCard' ? { ...p, card: { ...p.card, error: DELETED_AGENT_NOTE } } : p)));
        useAssistant.setState((st) => ({ agents: st.agents.filter((a) => a.agentId !== agentId) }));
      }
    });
  }, []);

  // A panel that mounts again over the same chat (Home, then Back) follows the conversation it is already kept in. The kept
  // record lives in the assistant store, so nothing is stored a second time.
  useEffect(() => {
    const kept = useAssistant.getState().kept;
    if (here && kept.id) conversation.attach(kept.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, workflowId]);

  // A conversation made by the first thing said is the chat's from then on.
  useEffect(() => {
    if (here && conversation.id) useAssistant.getState().setKept(conversation.id);
  }, [here, conversation.id]);

  // Fetch a stored conversation and make it the one the chat writes to; null if it could not be read.
  const load = useCallback(
    async (id: string) => {
      try {
        const body = await api<{ conversation: ConversationRecord; items: ConversationItem[] }>(`/api/conversations/${id}`, { background: true });
        await conversation.open(id);
        return body.items;
      } catch {
        return null;
      }
    },
    [conversation],
  );

  // Resume: the last conversation of this workflow, once the editor has loaded it (and only if the person has not started).
  const resumed = useRef<string>(undefined);
  useEffect(() => {
    if (!here || !keeping || resumed.current === workflowId || useAssistant.getState().kept.id) return;
    resumed.current = workflowId;
    if (!shouldResume(keeping, useAssistant.getState().items)) return;
    const params = new URLSearchParams({ surface: 'spotlight', subjectType: 'workflow', subjectId: workflowId, limit: '1' });
    void api<{ conversations: ConversationRecord[] }>(`/api/conversations?${params}`, { background: true })
      .then(async ({ conversations }) => {
        const latest = conversations[0];
        // The person may have started while it loaded: theirs stays, with nothing from before mixed into it.
        if (!latest || !shouldResume(true, useAssistant.getState().items) || useEditor.getState().workflowId !== workflowId) return;
        const turns = await load(latest.id);
        if (turns?.length && useEditor.getState().workflowId === workflowId) show(turns, false, latest.id);
      })
      .catch(() => undefined);
  }, [here, keeping, workflowId, load, show]);

  // Store the turns as they are said and finished.
  useEffect(() => {
    if (!here) return;
    const plan = planKeeping(items, useAssistant.getState().kept.stored, { keeping, live, agents: useAssistant.getState().agents /* AG11: */ });
    if (!plan.inputs.length && !plan.turns.length) return;
    recordPlan(useAssistant.getState().kept.stored, plan);
    if (plan.inputs.length) void appendRef.current(plan.inputs).catch(() => undefined);
  }, [items, live, keeping, here, agents /* AG11: */]);

  const open = async (id: string) => {
    if (useAssistant.getState().pending || useAssistant.getState().testing) return;
    const turns = await load(id);
    if (turns) show(turns, true, id);
  };
  const startNew = () => {
    useAssistant.getState().reset();
    conversation.startNew();
  };
  return { open, startNew, workflowId };
}

/**
 * The Spotlight panel, at the right of the editor. Desktop: a column beside the canvas (and its logs), folded to a thin
 * strip. Phone: a sheet under the canvas (which shrinks above it), folded to its header, a line and the input.
 */
export function SpotlightPanel({ hiddenOnPhone = false, hidden = false }: { hiddenOnPhone?: boolean; /** Stays mounted and keeps its conversation, but shows nothing (the Spotlight | Chat switch). */ hidden?: boolean }) {
  const keep = useSpotlightKeeping();
  const workflowName = useEditor((s) => s.name) || 'this workflow';
  // "Build it" on a suggestion opens the editor with ?ask=proposal:<id>: Spotlight builds from its prompt once (./ask-param.ts).
  const boundTo = useAssistant((s) => s.workflowId);
  useAskParam(Boolean(keep.workflowId) && boundTo === keep.workflowId);
  const collapsed = useAssistant((s) => s.collapsed);
  const explainer = useAutonomousExplainer();
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents);
  const drafting = useAssistant((s) => s.drafting);
  const testing = useAssistant((s) => Boolean(s.testing));
  const pending = useAssistant((s) => s.pending);
  const fixing = useAssistant((s) => s.fixing);
  const fixingName = useEditor((s) => (fixing ? s.nodes.find((n) => n.id === fixing)?.data.wf.name : undefined));
  const waiting = items.reduce((n, item) => n + (item.role === 'assistant' ? item.parts.filter((p) => p.kind === 'proposal' && !p.proposal.state).length : 0), 0);
  // The session's own wait: only a card of a reply the session asked for (a held removal of an autonomous typed change is not its).
  const testingId = useAssistant((s) => s.testingId);
  const sessionWaits = sessionIsWaiting({ testing, pending }, items, testingId);
  const bar = foldedBar({ waiting });
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
    ...(sessionWaits && { waitingForApply: true }),
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

  // The column's width eases between the strip and the full panel; once it stops, the flow is fitted again, once.
  const { fitView } = useReactFlow();
  const refit = useCallback(() => {
    if (!isPhone() && useEditor.getState().nodes.length) void fitView({ padding: { left: '72px', top: '56px', bottom: '120px', right: '72px' }, duration: 200, maxZoom: 1 });
  }, [fitView]);
  const [moving, setMoving] = useState(false);
  const was = useRef(collapsed);
  useEffect(() => {
    if (was.current === collapsed) return;
    was.current = collapsed;
    // Under Reduce motion (or a phone) the width doesn't transition, so no transitionend comes: fit now.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(min-width: 768px)').matches) return void setTimeout(refit, 60);
    setMoving(true);
    // A hidden panel never transitions: let go after the time it would have taken.
    const timer = setTimeout(() => setMoving(false), 400);
    return () => clearTimeout(timer);
  }, [collapsed, refit]);

  // A phone's sheet: three explicit heights (the bar as measured, peek, half) so each move eases, and the header drag sets
  // the height live and settles on the nearest one.
  const [barPx, setBarPx] = useState(0);
  const [dragH, setDragH] = useState<number>();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      // Only the natural height counts: while folded the content is not stretched by the sheet.
      if (el.dataset.folded === 'yes') setBarPx(Math.ceil(el.offsetHeight));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

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

  const { setCollapsed, stop } = useAssistant.getState();
  const phoneHeight = useAssistant((s) => s.phoneHeight);
  const drag = useRef<{ y: number; h: number }>(undefined);
  // The three stops of the sheet, in px: the bar, peek (34 dvh) and half (52 dvh).
  const stops = () => [barPx, Math.round(window.innerHeight * 0.34), Math.round(window.innerHeight * 0.52)];
  // The body shows from the moment a drag lifts the bar.
  const folded = collapsed && !(dragH !== undefined && dragH > barPx + 8);
  const sheet = dragH !== undefined ? `${dragH}px` : collapsed ? (barPx ? `${barPx}px` : 'auto') : phoneHeight === 'peek' ? '34dvh' : '52dvh';
  // One set of colours: violet while it works, amber when it needs you, green when it passed; a stop is neutral.
  const icon = busy && !sessionWaits ? (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" />
  ) : need || bar.needsYou ? (
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
      style={{ ['--sheet' as string]: sheet }}
      className={cn(
        'z-30 flex flex-col border-hair bg-sf',
        hidden && 'hidden',
        // One panel at a time under a phone's canvas.
        hiddenOnPhone && 'max-md:hidden',
        // Phone: a sheet under the canvas, which shrinks to the space above it.
        'max-md:shrink-0 max-md:rounded-t-2xl max-md:border-t',
        // Phone: three heights, folded to its bar, peek (the newest of the timeline) and half; they ease between each other,
        // and follow the finger while the header is dragged.
        'max-md:h-[var(--sheet)] max-md:transition-[height] max-md:duration-[240ms] max-md:ease-out motion-reduce:transition-none',
        dragH !== undefined && 'max-md:transition-none',
        // Desktop: a column beside the canvas; its width eases (240 ms) and the canvas fits again when it stops.
        'md:relative md:shrink-0 md:border-l md:transition-[width] md:duration-[240ms] md:ease-out',
        moving && 'md:overflow-hidden',
        collapsed ? 'md:w-11' : 'md:w-[360px]',
      )}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== 'width') return;
        setMoving(false);
        // Under Reduce motion the effect above has already fitted; the near-zero transition the global rule leaves ends here too.
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) refit();
      }}
      onTransitionCancel={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'width') setMoving(false);
      }}
    >
      {/* The strip at the panel's right edge with what Spotlight is doing: it shows when the panel is folded. */}
      <button
          type="button"
          onClick={() => focusSpotlight()}
          title={latest ? `${title}: ${latest}` : 'Show Spotlight (⌘K)'}
          aria-label="Show Spotlight"
          className={cn('hidden flex-1 flex-col items-center gap-3 py-3 text-t3 hover:bg-acdim hover:text-t1 md:absolute md:inset-y-0 md:right-0 md:flex md:w-11 md:transition-[opacity,visibility] md:duration-200 motion-reduce:transition-none', !collapsed && 'md:invisible md:opacity-0')}
        >
          <PanelRightOpen className="size-4" />
          {icon}
          {waiting > 0 && <span className="rounded-full bg-viz-7 px-1.5 text-[10.5px] font-semibold leading-4 text-bg">{waiting}</span>}
          <span className="text-[11.5px] font-semibold text-t2 [writing-mode:vertical-rl]">{title}</span>
        </button>
      <div ref={content} data-folded={folded ? 'yes' : 'no'} className={cn('flex flex-col md:absolute md:inset-y-0 md:right-0 md:w-[360px] md:transition-[opacity,visibility] md:duration-200 motion-reduce:transition-none', folded ? 'max-md:flex-none' : 'min-h-0 flex-1', collapsed && 'md:invisible md:opacity-0')}>
        <div
          // A phone: drag the header up or down for the next height (the chevron goes between the bar and half).
          onPointerDown={(e) => {
            if (!isPhone() || (e.target as HTMLElement).closest('button, input, [role="switch"]')) return;
            drag.current = { y: e.clientY, h: panel.current?.offsetHeight ?? 0 };
            // The finger leaves the header as it drags: the header still gets the moves and the release.
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const start = drag.current;
            if (!start || Math.abs(e.clientY - start.y) < 6) return;
            const [low, , high] = stops();
            setDragH(Math.max(low, Math.min(high, start.h + (start.y - e.clientY))));
          }}
          onPointerUp={() => {
            const start = drag.current;
            drag.current = undefined;
            if (!start) return;
            const h = dragH;
            setDragH(undefined);
            if (h === undefined) return;
            // Settle on the nearest stop.
            const heights = ['bar', 'peek', 'half'] as const;
            const at = stops().map((v) => Math.abs(v - h));
            useAssistant.getState().setDock(heights[at.indexOf(Math.min(...at))]);
          }}
          onPointerCancel={() => {
            drag.current = undefined;
            setDragH(undefined);
          }}
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
          <div className="md:hidden">
            <AutonomousSwitch compact={live || testing} />
          </div>
          {/* The composer has its own Stop while a reply streams; this one is for a test run, or when the panel is folded. */}
          {(collapsed ? live || testing : testing && !live) && (
            <button title="Stop" aria-label="Stop" onClick={stop} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-rddim hover:text-rd disabled:opacity-40 max-md:size-11">
              <Square className="size-3" fill="currentColor" />
            </button>
          )}
          <button title="New conversation" aria-label="New conversation" onClick={keep.startNew} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11">
            <SquarePen className="size-3.5" />
          </button>
          {keep.workflowId && <ConversationHistory surface="spotlight" subjectType="workflow" subjectId={keep.workflowId} subjectLabel="This workflow" ownSurfaceOnly onOpen={(id) => void keep.open(id)} onNew={keep.startNew} />}
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
        {/* Desktop: the switch has a row of its own, so the title keeps its width in the 360 px column. The first-run
            note sits under the row, in the panel's flow, so it pushes the conversation down instead of covering it. */}
        <div className="hidden shrink-0 border-b border-hair md:block">
          <div className="flex h-9 items-center justify-between gap-2 px-3">
            {/* What Spotlight is doing here; the chip offers the brain instead (the shell's panel opens and this column folds to its strip). */}
            <ModeChip mode={{ kind: 'build', workflowId: keep.workflowId ?? '', name: workflowName }} switchTo={{ label: 'Ask the brain instead', run: showBrainInstead }} />
            <AutonomousSwitch explainer={explainer} />
          </div>
          {/* SB19: the model for this session; desktop only, a phone uses the default. */}
          <ModelPicker />
          {explainer.note && <AutonomousExplainer onClose={explainer.close} className="mx-3 mb-2.5 shadow-none" />}
          <AsksFirstNote />
        </div>
        <AsksFirstNote className="border-b border-hair pt-1.5 md:hidden" />
        {/* Phone, folded: the step Spotlight is on, and Review and Apply when a change waits. */}
        {folded && latest && (
          <p className="flex items-center gap-1.5 truncate px-3 py-1.5 text-[12px] text-t2 md:hidden">
            <span className="truncate">{latest}</span>
          </p>
        )}
        {folded && bar.review && (
          <div className="flex items-center gap-2 px-3 pb-1.5 md:hidden">
            <Hand className="size-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-t1">{waiting === 1 ? 'A change needs you' : `${waiting} changes need you`}</span>
            <Button size="sm" variant="outline" className="min-h-11" onClick={() => useAssistant.getState().setDock('half')}>
              Review
            </Button>
            <Button size="sm" variant="primary" className="min-h-11" onClick={applyWaiting}>
              Apply
            </Button>
          </div>
        )}
        <div className={cn('flex min-h-0 flex-1 flex-col', folded && 'max-md:hidden')}>
          {items.length || agents.length ? (
            <Timeline live={live} status={drafting ? draftStatus(draftPhase(items, drafting) ?? 'planning') : undefined} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col justify-end px-4 py-4">
              <ChatEmpty title={EMPTY_LINE} />
            </div>
          )}
        </div>
        <Composer />
      </div>
    </aside>
  );
}
