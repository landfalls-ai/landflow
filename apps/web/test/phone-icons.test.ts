/** The phone keeps its old look (docs/mobile.md): the real icons show there, but the step list and the node panel header are as before. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(join(__dirname, '..', 'src', 'components', 'editor', file), 'utf8');

describe('phone icons', () => {
  it('keeps the phone step list icon at 18px', () => {
    expect(source('step-list.tsx')).toMatch(/<NodeIcon icon=\{info\?\.descriptor\.icon\} size=\{18\}/);
  });

  it('frames the node panel header icon on the phone and drops the frame only from md up', () => {
    const panel = source('node-panel.tsx');
    expect(panel).toContain('max-md:size-9 max-md:shrink-0 max-md:rounded-lg max-md:border max-md:border-hair max-md:bg-wl');
    expect(panel).toMatch(/size=\{38\} className="max-md:hidden"/);
    expect(panel).toMatch(/size=\{17\} className="md:hidden"/);
  });
});
