/**
 * One Spotlight for the whole app (docs/spotlight.md#one-spotlight): what it is doing here (its mode), whether the shell
 * panel is open, and the keys that open it. The pieces that decide are pure functions (`modeForRoute`, `keyAction`,
 * `parseAskAbout` and the state steps) so the tests can run them in node; the hook and the small store at the bottom
 * only carry them to React.
 */
import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { MENTION_TYPES } from '@/lib/shared/mentions';

/** What the panel does on this page: builds the open workflow, asks the brain, or asks about one thing it was sent. */
export type SpotlightMode =
  | { kind: 'build'; workflowId: string; name: string }
  | { kind: 'brain'; pageId?: string; name?: string }
  | { kind: 'about'; ref: { type: string; id: string; name: string; workflowId?: string } };

/** The detail of the `landflow:ask-about` window event (C10), typed here so nothing imports from the sender. */
export interface AskAboutDetail {
  ref: { type: string; id: string; name: string; workflowId?: string };
  starters: string[];
}

/** The open brain file, as the workbench publishes it for the chip and the starters. */
export interface BrainFile {
  ref: string;
  name: string;
  /** A page (asked about), not index.md or log.md (asked about everything). */
  page: boolean;
  /** For the starters: the busiest shared page, when the file is the index. */
  topShared?: string;
  model?: string;
}

export interface SpotlightState {
  open: boolean;
  /** Set by an ask-about event: the panel asks about this until the chip is removed. */
  about?: AskAboutDetail;
  brainFile?: BrainFile;
  /** The Brain page's own opener, so a link in an answer opens in the workbench instead of navigating. */
  openBrainPage?: (ref: string) => void;
  /** On the editor the builder is the panel; this lets a person ask the brain there instead. */
  askInstead: boolean;
  /** Counts how often the editor's own Spotlight was asked for (a click on the rail's button). */
  buildFocus: number;
}

export const INITIAL_STATE: SpotlightState = { open: false, askInstead: false, buildFocus: 0 };

const EDITOR_ROUTE = /^\/workflows\/([^/?#]+)\/?$/;

/** The id of the workflow when the path is the editor (`/workflows/<id>`; its tabs and `/workflows` are not). */
export function editorWorkflowId(path: string): string | undefined {
  const id = EDITOR_ROUTE.exec(path)?.[1];
  return id && id !== 'new' ? decodeURIComponent(id) : undefined;
}

export const isEditorRoute = (path: string) => editorWorkflowId(path) !== undefined;

/** The mode a route gives: the editor builds, `/brain*` and everywhere else asks the brain (the general Q&A). */
export function modeForRoute(path: string, ctx: { workflowName?: string; brainFile?: BrainFile } = {}): Exclude<SpotlightMode, { kind: 'about' }> {
  const workflowId = editorWorkflowId(path);
  if (workflowId) return { kind: 'build', workflowId, name: ctx.workflowName?.trim() || 'this workflow' };
  const file = path === '/brain' || path.startsWith('/brain/') ? ctx.brainFile : undefined;
  return file?.page ? { kind: 'brain', pageId: file.ref, name: file.name } : { kind: 'brain' };
}

/** The mode with an ask-about taken in: it wins over the route until its chip is removed. */
export function spotlightMode(path: string, state: Pick<SpotlightState, 'about' | 'brainFile' | 'askInstead'>, workflowName?: string): SpotlightMode {
  if (state.about) return { kind: 'about', ref: state.about.ref };
  const mode = modeForRoute(path, { ...(workflowName && { workflowName }), ...(state.brainFile && { brainFile: state.brainFile }) });
  // "Ask the brain instead" on the editor.
  return mode.kind === 'build' && state.askInstead ? { kind: 'brain' } : mode;
}

/** Whether the shell panel shows: open, and not on the editor (whose column is the builder) unless asked for there. */
export const shellPanelShows = (path: string, state: Pick<SpotlightState, 'open' | 'askInstead' | 'about'>) =>
  state.open && (!isEditorRoute(path) || state.askInstead || Boolean(state.about));

/** The event's detail as an `AskAboutDetail`, or nothing when it is not shaped like one. */
export function parseAskAbout(detail: unknown): AskAboutDetail | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const { ref, starters } = detail as { ref?: Record<string, unknown>; starters?: unknown };
  if (!ref || typeof ref.type !== 'string' || typeof ref.id !== 'string' || typeof ref.name !== 'string' || !ref.type || !ref.id) return undefined;
  // The brain's ask route only takes mention types; anything else would fail every question in about mode.
  if (!(MENTION_TYPES as readonly string[]).includes(ref.type)) return undefined;
  return {
    ref: { type: ref.type, id: ref.id, name: ref.name.trim().slice(0, 200) || ref.id, ...(typeof ref.workflowId === 'string' && ref.workflowId && { workflowId: ref.workflowId }) },
    starters: Array.isArray(starters) ? starters.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 6) : [],
  };
}

// ---- state steps (pure) -----------------------------------------------------------------------------------------

export const withOpen = (s: SpotlightState, open: boolean): SpotlightState => (s.open === open ? s : { ...s, open });
/** An ask-about opens the panel in about mode (on the editor too: someone asked about a thing, not to build). */
export const withAbout = (s: SpotlightState, detail: AskAboutDetail): SpotlightState => ({ ...s, open: true, about: detail });
export const withoutAbout = (s: SpotlightState): SpotlightState => {
  const { about: _gone, ...rest } = s;
  return rest;
};

/** The keys. ⌘K and ⌘I open (or focus) Spotlight everywhere; ⌘P on the brain page is QuickOpen (it was ⌘K). */
export type KeyAction = 'toggle' | 'quick' | 'none';
export function keyAction(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, where: { brain: boolean; mac?: boolean }): KeyAction {
  // On a Mac, Ctrl+K in a text field is the system's kill-line: only ⌘ counts there.
  if (!(e.metaKey || (e.ctrlKey && !where.mac)) || e.shiftKey || e.altKey) return 'none';
  const key = e.key.toLowerCase();
  if (key === 'k' || key === 'i') return 'toggle';
  if (key === 'p' && where.brain) return 'quick';
  return 'none';
}

/** Whether a modal dialog is open: the keys leave it alone, so ⌘K does not open the panel behind a dialog. */
export const modalOpen = (doc: Pick<Document, 'querySelector'>) => Boolean(doc.querySelector('[aria-modal="true"]'));

/** What ⌘K does to the shell panel: open it, focus its box, or (pressed again from the box) close it. */
export const toggleResult = (open: boolean, inBox: boolean): 'open' | 'focus' | 'close' => (!open ? 'open' : inBox ? 'close' : 'focus');

// ---- the store --------------------------------------------------------------------------------------------------

let current = INITIAL_STATE;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getSpotlightState = () => current;
export function setSpotlightState(next: SpotlightState | ((s: SpotlightState) => SpotlightState)) {
  const value = typeof next === 'function' ? next(current) : next;
  if (value === current) return;
  current = value;
  emit();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
/** Test hook: back to a closed panel. */
export const resetSpotlightState = () => setSpotlightState(INITIAL_STATE);

export function useSpotlightState(): SpotlightState {
  return useSyncExternalStore(subscribe, getSpotlightState, () => INITIAL_STATE);
}

/** The mode for this page (the route, or what an ask-about set). `workflowName` is the editor's own, for the chip. */
export function useSpotlightMode(workflowName?: string): SpotlightMode {
  const path = usePathname();
  return spotlightMode(path, useSpotlightState(), workflowName);
}

/** Open Spotlight from a button: on the editor its column takes the focus, elsewhere the shell panel opens. */
export function openSpotlight(path: string) {
  setSpotlightState((s) => (isEditorRoute(path) && !s.askInstead && !s.about ? { ...s, buildFocus: s.buildFocus + 1 } : withOpen(s, true)));
}
/** Closing also drops an ask-about: the next ⌘K starts from the page again. */
export const closeSpotlight = () => setSpotlightState((s) => ({ ...withOpen(withoutAbout(s), false), askInstead: false }));
/** Drop the brain panel on the editor without asking the builder for focus (the caller focuses it). */
export const dropShell = (s: SpotlightState): SpotlightState => ({ ...withoutAbout(s), open: false, askInstead: false });
/** The editor shows one column at a time: while the brain panel shows there, the builder column folds to its strip. */
export const builderFolds = (path: string, state: Pick<SpotlightState, 'open' | 'askInstead' | 'about'>) => isEditorRoute(path) && shellPanelShows(path, state);
/**
 * The editor's right column holds one panel (docs/spotlight.md#one-spotlight). What to do when the brain panel, the builder
 * column or the flow chat changes: fold the builder (and close the flow chat) when the brain panel first shows; drop the
 * brain panel again when the builder unfolds or the flow chat opens beside it; else nothing.
 */
export type ColumnRule = { fold: boolean; closeChat: boolean; dropShell: boolean };
export function columnRule(input: { brainPanelShows: boolean; wasShowing: boolean; builderFolded: boolean; column: string | null }): ColumnRule {
  const none = { fold: false, closeChat: false, dropShell: false };
  if (!input.brainPanelShows) return none;
  if (!input.wasShowing) return { fold: true, closeChat: input.column === 'chat', dropShell: false };
  return { ...none, dropShell: !input.builderFolded || input.column === 'chat' };
}

/** Whether ⌘ (rather than Ctrl) is the shortcut key here: a Mac, an iPhone or an iPad. */
export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The Brain page hands Spotlight its way to open a page (a link in an answer opens it beside the panel); undefined on leaving. */
export const setBrainOpener = (openBrainPage: ((ref: string) => void) | undefined) =>
  setSpotlightState((s) => {
    const { openBrainPage: _old, ...rest } = s;
    return openBrainPage ? { ...rest, openBrainPage } : rest;
  });

/** "Ask the brain instead" on the editor: the shell's brain panel opens in the builder's place. */
export const showBrainInstead = () => setSpotlightState((s) => ({ ...s, open: true, askInstead: true }));

/** "Build here instead" on the editor: the brain panel goes and the editor's own Spotlight takes the focus. */
export const showBuilderInstead = () => setSpotlightState((s) => ({ ...withoutAbout(s), open: false, askInstead: false, buildFocus: s.buildFocus + 1 }));

/** The Brain page publishes its open file, which Spotlight asks about (its starters and its `@` chip); undefined on leaving. */
export const setBrainFile = (brainFile: BrainFile | undefined) =>
  setSpotlightState((s) => {
    const { brainFile: _old, ...rest } = s;
    return brainFile ? { ...rest, brainFile } : rest;
  });
