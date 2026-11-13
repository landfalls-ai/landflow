import { describe, expect, it } from 'vitest';
import { sourceParts } from '../src/lib/shared/notebook-view';

describe('where a note came from', () => {
  it('names the run, the step and the page it was read from, in that order', () => {
    expect(sourceParts({ source: { executionId: 'exec_1', spanId: 's1', step: 'Build plugin', url: 'https://docs.example.com/a/b' } })).toEqual([
      { kind: 'run', label: 'Run trace', href: '/runs/exec_1?tab=trace&span=s1' },
      { kind: 'step', label: 'Build plugin' },
      { kind: 'url', label: 'docs.example.com', href: 'https://docs.example.com/a/b' },
    ]);
  });

  it('says nothing for a note a person wrote, and never links a page that is not http', () => {
    expect(sourceParts({ source: {} })).toEqual([]);
    expect(sourceParts({ source: { url: 'javascript:alert(1)' } })).toEqual([]);
    expect(sourceParts({ source: { url: 'ftp://files.example.com/x' } })).toEqual([{ kind: 'url', label: 'files.example.com' }]);
  });
});
