/**
 * The `landflow:ask-about` window event (C10): a page asks Spotlight about one thing (a run, a workflow, an agent) and
 * gives it the questions to start from. The panel opens in about mode with the chip and the starters.
 */
import { getSpotlightState, parseAskAbout, setSpotlightState, withAbout, type AskAboutDetail } from './context';
import { ASK_ABOUT_EVENT } from '@/lib/client/ask-about';

export { ASK_ABOUT_EVENT };

/** Listen on `target`; the handler gets each well-formed detail. Returns the stop function. */
export function listenAskAbout(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, onAbout: (detail: AskAboutDetail) => void): () => void {
  const handler = (event: Event) => {
    const detail = parseAskAbout((event as CustomEvent).detail);
    if (detail) onAbout(detail);
  };
  target.addEventListener(ASK_ABOUT_EVENT, handler);
  return () => target.removeEventListener(ASK_ABOUT_EVENT, handler);
}

/** The shell's conversation, as much of it as an ask-about needs (structural, so this file stays free of the panel). */
export interface AskAboutConversation {
  items: readonly unknown[];
  busy: boolean;
  clear: () => void;
}

const sameRef = (a: AskAboutDetail['ref'] | undefined, b: AskAboutDetail['ref']) => !!a && a.type === b.type && a.id === b.id;

/**
 * Whether an ask-about starts a new conversation. The shell's conversation outlives the panel, so without this a click on
 * "Ask why it failed" would open the last, unrelated talk (no starters, and its turns sent as history). It does unless the
 * panel is already about the same thing, or there is nothing to clear, or an answer is still coming (that one finishes).
 */
export const startsNew = (current: AskAboutDetail | undefined, next: AskAboutDetail, conversation: Pick<AskAboutConversation, 'items' | 'busy'>) =>
  conversation.items.length > 0 && !conversation.busy && !sameRef(current?.ref, next.ref);

/** What the shell does with one: a new conversation when it is about something else (`startsNew`), then about mode. */
export function takeAskAbout(detail: AskAboutDetail, conversation?: AskAboutConversation) {
  if (conversation && startsNew(getSpotlightState().about, detail, conversation)) conversation.clear();
  setSpotlightState((s) => withAbout(s, detail));
}
