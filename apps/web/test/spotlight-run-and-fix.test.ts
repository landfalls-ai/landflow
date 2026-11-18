/**
 * Wave ag4 carryover (the integrator's live pass, asks.md C): Spotlight answered the typed "Run it now and fix it if it
 * fails." with "I can't run the workflow from here". The composer now hands such an ask to the Test and fix session (which
 * asks before a run that writes outside); a step run or an ask that also changes something stays the chat's.
 */
import { describe, expect, it } from 'vitest';
import { runAndFixAsk } from '@/lib/shared/spotlight';

describe('a typed run-and-fix ask is the Test and fix session', () => {
  it('reads the asks that run the whole flow and fix it', () => {
    for (const ask of ['Run it now and fix it if it fails.', 'Test it and fix what fails', 'run the flow and fix anything that breaks', 'Please test this and fix it']) expect(runAndFixAsk(ask), ask).toBe(true);
  });
  it('leaves the chat a step run, a question, a change, and a run without a fix', () => {
    for (const ask of ['Run this step and show me what it returns.', 'Run it now', 'Why did the run fail?', 'Add a filter, then run it and fix it', 'Test the flow with the new agent version and publish it if it works', 'Wire a Sentiment tool into this step.', '']) expect(runAndFixAsk(ask), ask).toBe(false);
  });
});
