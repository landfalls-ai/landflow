/**
 * The shape of a connection on the canvases (components/canvas/edge-path.ts): forward connections curve, and a loop back
 * to an earlier node runs out to the right, along a lane under the nodes and into its input from the left.
 */
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { edgePath, isBackward } from '@/components/canvas/edge-path';

const ends = (sourceX: number, sourceY: number, targetX: number, targetY: number) => ({ sourceX, sourceY, targetX, targetY, sourcePosition: Position.Right, targetPosition: Position.Left });

describe('edge paths', () => {
  it('curves a forward connection and puts its label in the middle', () => {
    const [path, labelX, labelY] = edgePath(ends(100, 50, 300, 150), false);
    expect(path).toMatch(/^M ?100,50 ?C/);
    expect([labelX, labelY]).toEqual([200, 100]);
  });

  it('routes a loop under the lane it is given, with its label on the lane', () => {
    const loop = ends(900, 300, 200, 200);
    expect(isBackward(loop, false)).toBe(true);
    const [path, labelX, labelY] = edgePath(loop, false, 520);
    expect([labelX, labelY]).toEqual([550, 520]);
    // Two square-cornered runs, never a curve back through the nodes.
    expect(path).not.toContain('C');
    const ys = [...path.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => Number(m[2]));
    expect(Math.max(...ys)).toBe(520);
    // It leaves the output to the right and comes into the input from the left.
    expect(path.startsWith('M900 300') || path.startsWith('M 900,300') || path.startsWith('M900,300')).toBe(true);
    expect(path.trim().endsWith('200,200') || path.trim().endsWith('200 200')).toBe(true);
  });

  it('keeps a sub-node connection curved whichever way it runs', () => {
    expect(isBackward(ends(900, 300, 200, 200), true)).toBe(false);
    expect(edgePath(ends(900, 300, 200, 200), true)[0]).toContain('C');
  });
});
