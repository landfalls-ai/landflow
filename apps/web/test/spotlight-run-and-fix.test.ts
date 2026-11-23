/**
 * Wave ag4 carryover (the integrator's live pass, asks.md C): Spotlight answered the typed "Run it now and fix it if it
 * fails." with "I can't run the workflow from here". The composer now hands such an ask to the Test and fix session (which
 * asks before a run that writes outside); a step run or an ask that also changes something stays the chat's.
 */
import { describe, expect, it } from 'vitest';
import { runAndFixAsk, runAsk, runStepAsk, wrongOutputAsk } from '@/lib/shared/spotlight';

describe('a typed run-and-fix ask is the Test and fix session', () => {
  it('reads the asks that run the whole flow and fix it', () => {
    for (const ask of ['Run it now and fix it if it fails.', 'Test it and fix what fails', 'run the flow and fix anything that breaks', 'Please test this and fix it']) expect(runAndFixAsk(ask), ask).toBe(true);
  });
  it('leaves the chat a step run, a question, a change, and a run without a fix', () => {
    for (const ask of ['Run this step and show me what it returns.', 'Run it now', 'Why did the run fail?', 'Add a filter, then run it and fix it', 'Test the flow with the new agent version and publish it if it works', 'Wire a Sentiment tool into this step.', '']) expect(runAndFixAsk(ask), ask).toBe(false);
  });
});

describe('a typed step run is the step’s own run (asks.md E1)', () => {
  it('reads "Run this step …", never a change or a whole-flow run', () => {
    for (const ask of ['Run this step and show me what it returns.', 'run the selected node', 'Test this step']) expect(runStepAsk(ask), ask).toBe(true);
    for (const ask of ['Run it now and fix it if it fails.', 'Wire a Sentiment tool into this step.', 'Run this step and fix it', 'What does this step return?', '']) expect(runStepAsk(ask), ask).toBe(false);
  });
});

describe('re-check 3: a bare run ask and a "looks made up" ask are the session’s', () => {
  it('reads "Run it now", "Run it" and "Run the workflow" as a run; never a step, a change or a question', () => {
    for (const ask of ['Run it now.', 'Run it', 'run the workflow', 'Please run it again', 'Execute the flow']) expect(runAsk(ask), ask).toBe(true);
    for (const ask of ['Run this step', 'Run it and send the email', 'How do I run it?', 'Run the workflow every hour', 'Run it now and fix it if it fails.', '']) expect(runAsk(ask), ask).toBe(false);
  });
  it('reads output that looks wrong or made up as the session with the log', () => {
    for (const ask of ['The numbers in the report look made up. Test it and fix it.', 'The sales figures are invented', 'That output is wrong, fix it', 'These look fake']) expect(wrongOutputAsk(ask), ask).toBe(true);
    for (const ask of ['Why are the numbers wrong?', 'Add a made up number to the report', 'Make the report shorter', 'What does this do?', '']) expect(wrongOutputAsk(ask), ask).toBe(false);
    for (const ask of ['The numbers in the summary look made up. Test it and fix it.', 'the output is wrong, fix it', 'the report looks off, can you fix it', 'The report looks off, fix it', 'The summary seems off', 'The numbers look off. Test it and fix it.', 'The email looks wrong', 'The numbers in the email are made up', 'The Slack message it posted is wrong', 'The report it sends is wrong', 'The updated totals are wrong', 'The summary is wrong, fix it']) expect(wrongOutputAsk(ask), ask).toBe(true);
    for (const ask of ['The total is wrong, it needs to be in EUR', 'The amounts are wrong, show them in USD', 'The report is wrong, it must include Q3', 'The Slack step is off', 'The retry is off', 'The totals look off — add tax', 'The totals look off – add tax']) expect(wrongOutputAsk(ask), ask).toBe(false);
    // Changes and questions that merely mention something wrong or off stay the chat's.
    for (const ask of ['The retry is off, turn it on', 'The date format is wrong, make it ISO', 'the schedule is wrong, it should run at 9', 'The output was wrong: use the EU endpoint instead', 'The invented field should be removed', 'The Slack step is off', 'this looks wrong to me, why', 'Explain why the figures are wrong']) expect(wrongOutputAsk(ask), ask).toBe(false);
  });
});
