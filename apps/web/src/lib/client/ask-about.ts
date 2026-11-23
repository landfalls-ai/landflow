/**
 * "Ask about it": a resource's menu asks the chat panel (B35) to open with the resource as a chip and three starter
 * questions. The two sides share only this event, typed structurally. A credential's ref carries no value.
 */
import { startersFor, type StarterContext } from '../shared/ask-starters';
import type { MentionType } from '../shared/mentions';

export const ASK_ABOUT_EVENT = 'landflow:ask-about';

export interface AskAboutDetail {
  ref: { type: MentionType; id: string; name: string; workflowId?: string };
  starters: string[];
}

/** Open the chat about a resource. Does nothing outside the browser. */
export function askAbout(detail: AskAboutDetail, target: Pick<Window, 'dispatchEvent'> | undefined = typeof window === 'undefined' ? undefined : window): void {
  target?.dispatchEvent(new CustomEvent(ASK_ABOUT_EVENT, { detail }));
}

/** The detail for a resource, with the starters for its type. */
export function askDetail(ref: AskAboutDetail['ref'], ctx: StarterContext = {}): AskAboutDetail {
  return { ref, starters: startersFor(ref.type, ctx) };
}
