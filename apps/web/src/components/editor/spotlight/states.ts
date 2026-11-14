/**
 * What Spotlight's states offer, as pure functions (docs/assistant.md#the-spotlight-panel): the buttons of an error, the
 * starters of an empty panel, what the folded bar shows, the first-visit fold, the one-time explainer and the order in
 * which Apply and Undo play their motion. The panel only draws what these say.
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

/** The three starters of an empty panel: examples of a flow on an empty canvas, else what to do with the one there. */
export function starters(canvas: { nodes: number }): string[] {
  if (canvas.nodes === 0) {
    return ['Build a flow that posts new GitHub issues to Slack', 'Build a flow that summarizes my inbox every morning', 'Build a flow that answers a webhook with data from an API'];
  }
  return ['Explain this flow', 'Add error handling', 'Test it'];
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

/** Apply and Undo as one sequence: the card folds into its row while its ghosts become nodes, and back. */
export interface Motion {
  card: 'open' | 'collapsing' | 'row' | 'expanding';
  ghosts: 'ghost' | 'fading' | 'real' | 'returning';
}
export type MotionEvent = 'apply' | 'undo' | 'settled';

export const MOTION_START: Motion = { card: 'open', ghosts: 'ghost' };

export function motionStep(state: Motion, event: MotionEvent): Motion {
  if (event === 'apply' && state.card === 'open') return { card: 'collapsing', ghosts: 'fading' };
  if (event === 'undo' && state.card === 'row') return { card: 'expanding', ghosts: 'returning' };
  if (event === 'settled') {
    if (state.card === 'collapsing') return { card: 'row', ghosts: 'real' };
    if (state.card === 'expanding') return { card: 'open', ghosts: 'ghost' };
  }
  return state;
}

/** How long each side of the motion takes (ms): the card's Collapsible is 200, the ghosts a little longer. */
export const MOTION_MS = { card: 200, ghosts: 260, undoHold: 450 } as const;
