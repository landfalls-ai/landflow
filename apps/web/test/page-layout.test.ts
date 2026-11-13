/** The page layout (docs/ui-review.md#page-layout): which sidebar item a page belongs to. */
import { describe, expect, it } from 'vitest';
import { navActive } from '@/components/shell/sidebar';

describe('the sidebar marks the section a page belongs to', () => {
  it('puts a run’s own page under Executions, not Search runs', () => {
    expect(navActive('/executions', '/runs/ex_123')).toBe(true);
    expect(navActive('/runs', '/runs/ex_123')).toBe(false);
  });
  it('keeps Search runs and Compare under Search runs', () => {
    for (const path of ['/runs', '/runs/compare']) {
      expect(navActive('/runs', path)).toBe(true);
      expect(navActive('/executions', path)).toBe(false);
    }
  });
  it('matches Home only on itself and other items by prefix', () => {
    expect(navActive('/', '/')).toBe(true);
    expect(navActive('/', '/workflows')).toBe(false);
    expect(navActive('/workflows', '/workflows/wf_1')).toBe(true);
  });
});
