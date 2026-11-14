'use client';
/**
 * Spotlight in the editor (docs/assistant.md#the-spotlight-panel): one panel at the right of the canvas, beside it rather
 * than over it, that builds and fixes the workflow with the assistant. It never moves: no draft, reply or test session
 * opens, closes or shifts it; only the person folds it (to a thin strip, or on a phone to a sheet's peek). Its header says
 * what Spotlight is doing; its timeline shows every turn: what was asked, each change (as a row once applied in autonomous
 * mode), each test run and fix, each agent the Agent architect designs, and how it ended; its input sits at the bottom,
 * with bubbles that suggest what to ask and complete what is typed (`@` a node on the canvas, a node type).
 * On an empty canvas the first message drafts the whole flow. "Test and fix" (./test-session.ts) runs the workflow, has
 * failures fixed until a run passes, then offers to publish it.
 */

export { focusSpotlight } from './composer';
export { SpotlightPanel } from './panel';
