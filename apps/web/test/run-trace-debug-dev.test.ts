/** The Debug access dialog with developer details on: the tool names behind the plain words show (components/run-trace/debug-access.tsx). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/client/developer-details', () => ({
  useDeveloperDetails: () => true,
  DevOnly: ({ children }: { children: unknown }) => children,
}));

import { DebugAccessDialog } from '../src/components/run-trace/debug-access';

describe('Debug access with developer details on', () => {
  it('shows the tool names next to the plain words', () => {
    const html = renderToStaticMarkup(createElement(DebugAccessDialog, { executionId: 'x1', onClose: () => {} }));
    expect(html).toContain('See how the run went');
    for (const tool of ['get_execution', 'explain_failure', 'get_run_trace']) expect(html).toContain(tool);
  });
});
