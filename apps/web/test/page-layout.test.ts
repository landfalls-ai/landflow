/** The page layout (docs/ui-review.md#page-layout): which sidebar item a page belongs to. */
import { describe, expect, it } from 'vitest';
import { navActive } from '@/components/shell/sidebar';

describe('the sidebar marks the section a page belongs to', () => {
  it('puts a run’s page, Search runs and Compare under the Runs item', () => {
    for (const path of ['/runs/ex_123', '/runs', '/runs/compare']) expect(navActive('/executions', path)).toBe(true);
  });
  it('matches Home only on itself and other items by prefix', () => {
    expect(navActive('/', '/')).toBe(true);
    expect(navActive('/', '/workflows')).toBe(false);
    expect(navActive('/workflows', '/workflows/wf_1')).toBe(true);
  });
});
