/**
 * "Ask about it" (docs/spotlight.md#ask-about-it): the three starter questions each kind of resource offers when a
 * person opens the chat from its menu. Pure, so the menus, the chat panel and the tests share one list.
 */
import type { MentionType } from './mentions';

/** What the starters may depend on: a failed run asks why first. */
export interface StarterContext {
  /** True for a run that ended in an error. */
  failed?: boolean;
}

const STARTERS: Partial<Record<MentionType, readonly [string, string, string]>> = {
  workflow: ['What does this flow do?', 'Why did its last run fail?', 'How can I make it faster?'],
  run: ['Why did this fail?', 'How do I fix it?', 'Has this happened before?'],
  agent: ['What does this agent do?', 'Which tools and knowledge does it use?', 'How can I make it better?'],
  dataTable: ['What is in this table?', 'Which flows use it?', 'How should I clean it up?'],
  credential: ['Where is this credential used?', 'Which flows would break if it expired?', 'When was it last tested?'],
  brainPage: ['Summarise this page.', 'What is out of date here?', 'Where does this come from?'],
};

const FALLBACK: readonly [string, string, string] = ['What is this?', 'Where is it used?', 'What should I do next?'];
const FAILED_RUN: readonly [string, string, string] = ['Why did this fail?', 'How do I fix it?', 'Has this happened before?'];

/** Three questions for a kind of resource; a failed run's start with why it failed. */
export function startersFor(type: MentionType, ctx: StarterContext = {}): string[] {
  if (type === 'run') return [...(ctx.failed ? FAILED_RUN : ['What happened in this run?', 'Which step took longest?', 'Has this happened before?'])];
  return [...(STARTERS[type] ?? FALLBACK)];
}
