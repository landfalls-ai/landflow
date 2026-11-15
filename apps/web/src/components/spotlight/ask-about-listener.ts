/**
 * The `landflow:ask-about` window event (C10): a page asks Spotlight about one thing (a run, a workflow, an agent) and
 * gives it the questions to start from. The panel opens in about mode with the chip and the starters.
 */
import { parseAskAbout, setSpotlightState, withAbout, type AskAboutDetail } from './context';

export const ASK_ABOUT_EVENT = 'landflow:ask-about';

/** Listen on `target`; the handler gets each well-formed detail. Returns the stop function. */
export function listenAskAbout(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, onAbout: (detail: AskAboutDetail) => void): () => void {
  const handler = (event: Event) => {
    const detail = parseAskAbout((event as CustomEvent).detail);
    if (detail) onAbout(detail);
  };
  target.addEventListener(ASK_ABOUT_EVENT, handler);
  return () => target.removeEventListener(ASK_ABOUT_EVENT, handler);
}

/** What the shell does with one: switch the panel to about mode. */
export const takeAskAbout = (detail: AskAboutDetail) => setSpotlightState((s) => withAbout(s, detail));
