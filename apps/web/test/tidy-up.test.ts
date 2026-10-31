/**
 * Tidy up (the editor store's `tidyUp`): columns as wide as their widest node, a chain kept level with its parent,
 * siblings spread around it, and sub-nodes spread under their parent far enough apart for their names.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-tidy-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { useEditor } = await import('@/components/editor/store');

const node = (id: string, x: number, y: number) => ({ id, name: id, type: 'core.set', typeVersion: 1, position: [x, y] as [number, number], parameters: {} });
const main = (source: string, target: string, sourceIndex = 0) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex, target, targetIndex: 0 });
const tool = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'ai_tool' as const, source, sourceIndex: 0, target, targetIndex: 0 });

// A branch whose first output runs on in a chain (with three tools under its first node) and loops back to the branch.
const flow: Workflow = {
  id: 'wf_tidy',
  name: 'Tidy',
  nodes: [node('start', 500, 400), node('branch', 20, 900), node('yes', 0, 0), node('next', 70, 70), node('last', 3, 3), node('no', 9, 9), node('t1', 0, 0), node('t2', 0, 0), node('t3', 0, 0)],
  connections: [main('start', 'branch'), main('branch', 'yes', 0), main('branch', 'no', 1), main('yes', 'next'), main('next', 'last'), main('last', 'branch'), tool('t1', 'yes'), tool('t2', 'yes'), tool('t3', 'yes')],
};

const pos = (id: string) => useEditor.getState().nodes.find((n) => n.id === id)!.position;

describe('tidy up', () => {
  it('keeps a chain level, spreads siblings around their parent and sub-nodes under theirs', () => {
    useEditor.getState().load(flow, []);
    useEditor.getState().tidyUp();
    // A square tile's column stays 280px wide.
    expect([pos('start').x, pos('branch').x, pos('yes').x, pos('next').x, pos('last').x]).toEqual([0, 280, 560, 840, 1120]);
    expect(pos('branch').y).toBe(pos('start').y);
    expect(pos('yes').y).toBe(pos('branch').y - 85);
    expect(pos('no').y).toBe(pos('branch').y + 85);
    // The chain after the first output stays on its line instead of dropping back to the middle.
    expect(pos('next').y).toBe(pos('yes').y);
    expect(pos('last').y).toBe(pos('yes').y);
    // Three tools, 170px apart, centred under their 88px parent, 200px down.
    expect([pos('t1').x, pos('t2').x, pos('t3').x]).toEqual([pos('yes').x + 44 - 202, pos('yes').x + 44 - 32, pos('yes').x + 44 + 138]);
    expect(pos('t2').y).toBe(pos('yes').y + 200);
  });

  it('lays out a flow that is all one loop from its first node', () => {
    useEditor.getState().load({ ...flow, connections: [main('start', 'branch'), main('branch', 'start')] }, []);
    useEditor.getState().tidyUp();
    expect(pos('branch').x).toBe(pos('start').x + 280);
  });
});
