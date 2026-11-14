/**
 * What Spotlight's states offer, as pure functions (docs/assistant.md#the-spotlight-panel): the buttons of an error, what the folded bar shows, the first-visit fold, the one-time explainer, what the ghosts and the
 * card do on Apply and Undo, and which proposals share one Undo. The panel only draws what these say.
 */

/** A failed reply as the panel knows it. `kind` and `step` come with the stream's `error` event. */
export interface ErrorInfo {
  message: string;
  kind?: 'model' | 'cap' | 'stalled' | 'internal';
  step?: number;
  checkpoint?: string;
  /** The node a test-and-fix session failed at, with its name for the prefilled question. */
  node?: { id: string; name: string };
}

export interface ErrorContext {
  admin: boolean;
  /** The reply may be sent again: it is the last one and nothing else is running. */
  canRetry: boolean;
}

export type ErrorAction =
  | { id: 'continue'; label: string; primary: true }
  | { id: 'retry'; label: string }
  | { id: 'open-caps'; label: string; primary: true }
  | { id: 'open-node'; label: string }
  | { id: 'fix-node'; label: string; primary: true; prefill: string };

/** The buttons under an error, by what failed. Try again is one of them whenever sending the message again can help. */
export function errorActions(error: ErrorInfo, ctx: ErrorContext): ErrorAction[] {
  const actions: ErrorAction[] = [];
  if (error.node) {
    actions.push({ id: 'open-node', label: 'Open the node' });
    actions.push({ id: 'fix-node', label: 'Ask Spotlight to fix it', primary: true, prefill: `Fix ${error.node.name}: ${error.message}` });
    return actions;
  }
  if (error.kind === 'cap') {
    // The cap's text is the message; only an admin can change the cap.
    if (ctx.admin) actions.push({ id: 'open-caps', label: 'Open AI caps', primary: true });
    return actions;
  }
  if (error.kind === 'model' && error.checkpoint && error.step && error.step > 1 && ctx.canRetry) {
    actions.push({ id: 'continue', label: `Continue from step ${error.step}`, primary: true });
  }
  if (ctx.canRetry) actions.push({ id: 'retry', label: 'Try again' });
  return actions;
}

export const EMPTY_LINE = 'Describe a flow, or ask about this one';

/** What the folded bar of a phone shows: the amber needs-you icon with Review and Apply when a proposal waits. */
export function foldedBar(o: { waiting: number }): { needsYou: boolean; review: boolean; apply: boolean; waiting: number } {
  const waits = o.waiting > 0;
  return { needsYou: waits, review: waits, apply: waits, waiting: o.waiting };
}

/** The panel's first state: folded unless the person chose otherwise in this browser (`saved` is the kept 'yes' or 'no'). */
export function defaultCollapsed(saved: string | null | undefined): boolean {
  return saved ? saved === 'yes' : true;
}

export const EXPLAINER_KEY = 'landflow-spotlight-autonomous-explained';

/** The Asks first | Autonomous explainer shows once per browser. */
export function explainerDue(read: (key: string) => string | null): boolean {
  try {
    return read(EXPLAINER_KEY) !== 'yes';
  } catch {
    return false;
  }
}

/** What the ghosts of a change do once its card's state changes: fade out as the nodes become real, or come back on Undo. */
export function ghostFade(state: 'applied' | 'dismissed' | 'undone' | 'stale' | undefined): 'out' | 'back' | undefined {
  return state === 'applied' ? 'out' : state === 'undone' ? 'back' : undefined;
}

/** A card folds into its one-line row (with the tick) once applied; every other state keeps it open. */
export function cardFolded(state: 'applied' | 'dismissed' | 'undone' | 'stale' | undefined): boolean {
  return state === 'applied';
}

/**
 * Proposals applied as one step (Apply all, the phone bar's Apply, the live steps) share one undo function: undoing any of
 * them reverts them all. Returns the ids that share `id`'s undo, `id` included.
 */
export function undoGroup(undos: ReadonlyMap<string, () => void>, id: string): string[] {
  const fn = undos.get(id);
  return fn ? [...undos].filter(([, f]) => f === fn).map(([k]) => k) : [];
}

/** Only the newest undo is safe to use: the one nothing was applied after. */
export function isNewestUndo(undos: ReadonlyMap<string, () => void>, id: string): boolean {
  const newest = [...undos.keys()].at(-1);
  return newest !== undefined && undos.get(newest) === undos.get(id) && undos.has(id);
}

/** How long each side of the motion takes (ms): the card's Collapsible is 200, the ghosts a little longer. */
export const MOTION_MS = { card: 200, ghosts: 260, undoHold: 450 } as const;
