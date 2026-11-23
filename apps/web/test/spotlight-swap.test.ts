import { describe, expect, it } from 'vitest';
import { swapState } from '../src/components/editor/spotlight/swap';

const base = { live: true, streamed: true, hasSteps: false, own: false, hasWords: false, hasTrace: false };

describe('swapState', () => {
  it('builder reply: mounted and working before the first words, still mounted (not working) after', () => {
    const before = swapState({ ...base, hasSteps: true, hasTrace: true });
    expect(before).toMatchObject({ mounted: true, working: true, silent: true, spinner: false });
    const after = swapState({ ...base, hasSteps: true, hasTrace: true, hasWords: true });
    expect(after).toMatchObject({ mounted: true, working: false });
  });
  it('plain reply shows the Working line until words, silent once a trace speaks', () => {
    expect(swapState(base)).toMatchObject({ mounted: true, working: true, silent: false, spinner: true });
    expect(swapState({ ...base, hasTrace: true })).toMatchObject({ working: true, silent: true });
  });
  it('session reply (own run parts) is not working but stays mounted while live', () => {
    expect(swapState({ ...base, own: true })).toMatchObject({ mounted: true, working: false });
  });
  it('a finished streamed reply with no words mounts nothing', () => {
    expect(swapState({ ...base, live: false })).toMatchObject({ mounted: false, working: false });
  });
  it('a non-streamed reply with build steps does not mount a second line', () => {
    expect(swapState({ ...base, streamed: false, hasSteps: true }).mounted).toBe(false);
  });
});
