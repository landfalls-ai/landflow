/** The Templates page's project scope note carries the way back to the unscoped list ("Show all projects"). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectScopeNote } from '@/components/templates/template-library';

describe('the Templates project scope note', () => {
  it('names the project and offers Show all projects', () => {
    const html = renderToStaticMarkup(createElement(ProjectScopeNote, { label: 'Acme', onClear: () => {} }));
    expect(html).toContain('Saved templates of Acme');
    expect(html).toContain('Show all projects');
    expect(html).toContain('<button');
  });
});
