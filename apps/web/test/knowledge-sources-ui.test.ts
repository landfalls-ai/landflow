/** C22: the Sources panel's words, and its wiring in the knowledge base dialog. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceStatusLine } from '../src/components/agents/knowledge-sources';
import { EMPTY_COUNTS, ENABLED_SOURCE_KINDS, type SourceView } from '../src/lib/shared/knowledge-sources';

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
const source = (patch: Partial<SourceView> = {}): SourceView => ({ id: 's', kind: 'folder', name: 'runbooks', settings: { folder: 'runbooks' }, schedule: 'hourly', paused: false, running: false, createdAt: new Date(NOW).toISOString(), ...patch });

describe('sourceStatusLine', () => {
  it('says what a source is doing, how the last sync went and when the next is', () => {
    expect(sourceStatusLine(source({ running: true }), NOW)).toBe('Syncing now…');
    expect(sourceStatusLine(source({ nextAt: new Date(NOW).toISOString() }), NOW)).toBe('Not synced yet · next sync due');
    const run = { id: 'r', trigger: 'schedule' as const, startedAt: new Date().toISOString(), status: 'ok' as const, counts: EMPTY_COUNTS, errors: [] };
    expect(sourceStatusLine(source({ lastRun: run, nextAt: new Date(NOW + 30 * 60_000).toISOString() }), NOW)).toBe('Succeeded just now · next in 30 min');
    expect(sourceStatusLine(source({ lastRun: run, schedule: 'manual' }), NOW)).toBe('Succeeded just now');
  });
  it('a paused source gives its reason and no next time', () => {
    expect(sourceStatusLine(source({ paused: true, pausedReason: 'The knowledge base was removed', nextAt: new Date(NOW).toISOString() }), NOW)).toBe('Paused: The knowledge base was removed');
  });
});

describe('the dialog', () => {
  const dialog = readFileSync(join(__dirname, '../src/components/agents/knowledge-dialog.tsx'), 'utf8');
  const panel = readFileSync(join(__dirname, '../src/components/agents/knowledge-sources.tsx'), 'utf8');
  it('shows the Sources panel under the documents, and the count on the Indexed from line', () => {
    expect(dialog).toContain('<SourcesPanel agentId={agentId} toolId={tool.id}');
    expect(dialog).toMatch(/sourceCount > 0/);
  });
  it('offers every enabled kind and pre-selects deleting the chunks when removing (D4)', () => {
    expect(ENABLED_SOURCE_KINDS).toEqual(['folder', 's3', 'crawl', 'googleDrive']);
    expect(panel).toContain('useState(true)');
    expect(panel).toMatch(/deleteChunks, setDeleteChunks\] = useState\(true\)/);
  });
});
