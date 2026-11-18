/**
 * Wave ag5 fix pass 2, item 1: `fixRemovals` reads what a fix does from the result of its ops (`applyOps` on a copy, node ids
 * before and after), not from the names its ops use: a name matches without case and a rename can come before a removal.
 */
import { describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AssistantOp } from '@/lib/shared/assistant-ops';
import { fixRemovals } from '@/components/editor/fix-session';

const node = (id: string, name: string, type = 'core.code') => ({ id, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters: {} });
const wf = (): Workflow => ({
  id: 'w', name: 'w',
  nodes: [node('a', 'Start', 'core.manualTrigger'), node('p', 'Send Email', 'messaging.emailSend'), node('h', 'Helper'), node('q', 'Notify')],
  connections: [
    { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'p', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'p', sourceIndex: 0, target: 'q', targetIndex: 0 },
  ],
});
const lookup = () => undefined;
const own = { own: new Set(['h']) };

describe('fixRemovals', () => {
  it('a removal that names a step in another case is still the removal of the person’s step', () => {
    const out = fixRemovals([{ op: 'removeNode', node: 'send email' }], wf(), lookup, own);
    expect(out.reasons).toEqual(['removes “Send Email”']);
    expect(out.lines).toEqual([]);
  });

  it('renaming the person’s step and then removing it by the new name still waits', () => {
    const ops: AssistantOp[] = [{ op: 'renameNode', node: 'Send Email', name: 'Zed' }, { op: 'removeNode', node: 'Zed' }];
    expect(fixRemovals(ops, wf(), lookup, own).reasons).toEqual(['removes “Send Email”']);
  });

  it('swapping names with the session’s own step does not turn the person’s step into it', () => {
    const ops: AssistantOp[] = [{ op: 'renameNode', node: 'Helper', name: 'Tmp' }, { op: 'renameNode', node: 'Send Email', name: 'Helper' }, { op: 'removeNode', node: 'Helper' }];
    const out = fixRemovals(ops, wf(), lookup, own);
    expect(out.reasons).toEqual(['removes “Send Email”']);
    expect(out.lines).toEqual([]);
  });

  it('the session’s own step and a duplicate go without a click, each named with its reason; a turn-off and a lost input wait', () => {
    const allowed = { own: new Set(['h']), duplicates: new Map([['p', 'Short writer']]) };
    const out = fixRemovals([{ op: 'removeNode', node: 'helper' }, { op: 'removeNode', node: 'Send Email' }], wf(), lookup, allowed);
    expect(out.reasons).toEqual([]);
    expect(out.lines).toEqual(['Removed “Send Email”: “Short writer” does it itself', 'Removed “Helper”: this session added it']);
    expect(fixRemovals([{ op: 'setNodeSettings', node: 'notify', settings: { disabled: true } }], wf(), lookup, allowed).reasons).toEqual(['turns off “Notify”']);
    expect(fixRemovals([{ op: 'disconnect', from: 'send email', to: 'NOTIFY' }], wf(), lookup, allowed).reasons).toEqual(['leaves “Notify” without its input']);
  });

  it('a disconnect is judged from the result: a rename before it does not hide the lost input', () => {
    const ops: AssistantOp[] = [{ op: 'renameNode', node: 'Notify', name: 'Zed' }, { op: 'disconnect', from: 'Send Email', to: 'Zed' }];
    expect(fixRemovals(ops, wf(), lookup, own).reasons).toEqual(['leaves “Zed” without its input']);
  });

  it('removing the session’s own Helper, the only input of the person’s Notify, waits', () => {
    const w = wf();
    w.connections = [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'h', targetIndex: 0 }, { id: 'e3', type: 'main', source: 'h', sourceIndex: 0, target: 'q', targetIndex: 0 }];
    const out = fixRemovals([{ op: 'removeNode', node: 'Helper' }], w, lookup, own);
    expect(out.reasons).toEqual(['leaves “Notify” without its input']);
  });

  it('disconnecting and reconnecting the session’s own Helper does not wait', () => {
    const w = wf();
    w.connections = [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'h', targetIndex: 0 }];
    const ops: AssistantOp[] = [{ op: 'disconnect', from: 'Start', to: 'Helper' }, { op: 'connect', from: 'Start', to: 'Helper' }];
    expect(fixRemovals(ops, w, lookup, own).reasons).toEqual([]);
  });

  it('proposals apply in turn: one adds a “Send Email”, the next removes that name, and the person’s step still waits', () => {
    const p1: AssistantOp[] = [{ op: 'addNode', ref: 'Send Email', type: 'core.code' } as AssistantOp];
    const p2: AssistantOp[] = [{ op: 'removeNode', node: 'Send Email' }];
    const out = fixRemovals([p1, p2], wf(), lookup, own);
    expect(out.reasons.join()).toContain('removes “Send Email”');
  });
});
