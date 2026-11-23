/** C34: the Decide node's outputs follow its options; editing them moves, drops or keeps each connection by the output's name. */
import { describe, expect, it } from 'vitest';
import { decideRouting, expandPorts, parseManifest, remapExpandedConnections } from '../src';

const q = (options: string, type = 'choice') => ({ question: [{ name: 'topic', type, instructions: 'q', options }] });
const params = (options: string, more: Record<string, unknown> = {}) => ({ questions: q(options), routeBy: 'topic', ...more });
const edge = (sourceIndex: number) => ({ sourceIndex });

describe('remapExpandedConnections', () => {
  const old = params('billing\ntechnical\nother'); // billing, technical, other, Unsure

  it('keeps an edge on its output when an option is added at the end or in front', () => {
    expect(remapExpandedConnections(old, params('billing\ntechnical\nother\nsales'), [edge(0), edge(1), edge(2), edge(3)])).toEqual([edge(0), edge(1), edge(2), edge(4)]);
    // A new first option pushes every other output one place along; the edges follow their names.
    expect(remapExpandedConnections(old, params('sales\nbilling\ntechnical\nother'), [edge(0), edge(1), edge(2)])).toEqual([edge(1), edge(2), edge(3)]);
  });

  it('drops the edge of a removed option and moves the rest up', () => {
    expect(remapExpandedConnections(old, params('billing\nother'), [edge(0), edge(1), edge(2), edge(3)])).toEqual([edge(0), edge(1), edge(2)]);
  });

  it('follows a rename in place (one option changed name, the others did not)', () => {
    expect(remapExpandedConnections(old, params('billing\ntech\nother'), [edge(0), edge(1), edge(2)])).toEqual([edge(0), edge(1), edge(2)]);
  });

  it('keeps the Unsure edge on Unsure', () => {
    expect(remapExpandedConnections(old, params('a\nb'), [edge(3)])).toEqual([edge(2)]);
  });

  it('matches Yes and No by name when Route By switches, and drops what has no name', () => {
    const yesNo = { questions: { question: [{ name: 'urgent', type: 'yesno', instructions: 'q' }, ...q('billing\nother').question] }, routeBy: 'urgent' };
    expect(remapExpandedConnections(old, yesNo, [edge(0), edge(1), edge(2), edge(3)])).toEqual([]);
    expect(remapExpandedConnections(yesNo, yesNo, [edge(0), edge(1)])).toEqual([edge(0), edge(1)]);
    const back = remapExpandedConnections(yesNo, { ...yesNo, routeBy: '' }, [edge(0), edge(1)]);
    expect(back).toEqual([]);
  });

  it('leaves a single Decided output alone while nothing routes', () => {
    expect(remapExpandedConnections(params('a\nb', { routeBy: '' }), params('a\nb\nc', { routeBy: '' }), [edge(0)])).toEqual([edge(0)]);
  });

  it('does not touch other fields of the connection', () => {
    expect(remapExpandedConnections(old, params('technical\nbilling\nother'), [{ sourceIndex: 0, id: 'e1', target: 'x' }])).toEqual([{ sourceIndex: 1, id: 'e1', target: 'x' }]);
  });
});

describe('the expand rule', () => {
  it('expands the Decide port and refuses nothing else', () => {
    expect(expandPorts([{ type: 'main', expand: 'decide' }], params('a\nb')).map((p) => p.displayName)).toEqual(['a', 'b', 'Unsure']);
    expect(decideRouting(params('a\nb')).labels).toEqual(['a', 'b', 'Unsure']);
  });

  it('is refused in a plugin manifest: only the host\'s own nodes may use it', () => {
    const manifest = (outputs: unknown[]) => ({
      protocol: 'landflow.plugin/v1',
      plugin: { id: 'p', name: 'P', version: '1.0.0', language: 'typescript' },
      nodes: [{ name: 'n', displayName: 'N', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs, properties: [] }],
    });
    expect(parseManifest(manifest([{ type: 'main' }])).ok).toBe(true);
    const refused = parseManifest(manifest([{ type: 'main', expand: 'decide' }]));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/expand/);
  });
});
