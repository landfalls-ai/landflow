// @vitest-environment happy-dom
/** useCredentialScope ignores stale answers; usePublishedCredentialsDiffer says when triggers use another credential than the draft. */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }[]>();
const answers = new Map<string, unknown>();
const calls: string[] = [];
vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: (path: string) => {
    calls.push(path);
    if (answers.has(path)) return Promise.resolve(answers.get(path));
    return new Promise((resolve, reject) => pending.set(path, [...(pending.get(path) ?? []), { resolve, reject }]));
  },
}));

const { useCredentialScope } = await import('@/components/projects/use-projects');
const { usePublishedCredentialsDiffer, clearPublishedCredentialsCache } = await import('@/components/editor/use-published-credentials');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  pending.clear();
  answers.clear();
  calls.length = 0;
  clearPublishedCredentialsCache();
});
afterEach(() => act(() => root.unmount()));

describe('useCredentialScope', () => {
  it('drops a late answer from an earlier request (a retry, or the previous workflow)', async () => {
    let seen: ReturnType<typeof useCredentialScope> | undefined;
    const Probe = ({ id }: { id: string }) => {
      seen = useCredentialScope(id);
      return null;
    };
    const url = '/api/credentials?workflowId=wf_1';
    await act(async () => root.render(createElement(Probe, { id: 'wf_1' })));
    expect(pending.get(url)).toHaveLength(1);
    // A retry while the first request is still out.
    let second: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      second = seen!.reload();
    });
    expect(pending.get(url)).toHaveLength(2);
    await act(async () => {
      pending.get(url)![1].resolve({ credentials: [{ id: 'new' }], projectId: 'p2' });
      await second;
    });
    await act(async () => pending.get(url)![0].resolve({ credentials: [{ id: 'old' }], projectId: 'p1' }));
    expect([...seen!.scope!.ids]).toEqual(['new']);
    expect(seen!.scope!.projectId).toBe('p2');
  });

  it('a failed late request does not turn a known scope into a failure', async () => {
    let seen: ReturnType<typeof useCredentialScope> | undefined;
    const Probe = () => {
      seen = useCredentialScope('wf_1');
      return null;
    };
    const url = '/api/credentials?workflowId=wf_1';
    await act(async () => root.render(createElement(Probe)));
    let second: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      second = seen!.reload();
    });
    await act(async () => {
      pending.get(url)![1].resolve({ credentials: [{ id: 'a' }] });
      await second;
    });
    await act(async () => pending.get(url)![0].reject(new Error('late')));
    expect(seen!.failed).toBe(false);
    expect(seen!.scope).toBeDefined();
  });
});

describe('usePublishedCredentialsDiffer', () => {
  const versionUrl = '/api/workflows/wf_1/versions/v7';
  const publishedWith = (credentials?: Record<string, { id: string; name: string }>) => answers.set(versionUrl, { version: { workflow: { nodes: [{ id: 'n1', credentials }] } } });
  const run = async (input: Parameters<typeof usePublishedCredentialsDiffer>[0]) => {
    let result = false;
    const Probe = () => {
      result = usePublishedCredentialsDiffer(input);
      return null;
    };
    await act(async () => root.render(createElement(Probe)));
    return result;
  };
  const mine = { httpHeaderAuth: { id: 'h1' } };

  it('never says "publish" for a workflow that was never published (no published version)', async () => {
    expect(await run({ workflowId: 'wf_1', versionId: undefined, nodeId: 'n1', credentials: mine })).toBe(false);
    expect(pending.size + answers.size).toBe(0);
  });
  it('says it when the published version has another credential, or none', async () => {
    publishedWith({ httpHeaderAuth: { id: 'other', name: 'x' } });
    expect(await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'n1', credentials: mine })).toBe(true);
    clearPublishedCredentialsCache();
    publishedWith(undefined);
    expect(await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'n1', credentials: mine })).toBe(true);
  });
  it('says nothing when the published version uses the same credential, or lacks the node', async () => {
    publishedWith({ httpHeaderAuth: { id: 'h1', name: 'Echo header' } });
    expect(await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'n1', credentials: mine })).toBe(false);
    expect(await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'new-node', credentials: mine })).toBe(false);
  });
  it('fetches a published version once, whichever nodes are opened and however often', async () => {
    publishedWith({ httpHeaderAuth: { id: 'h1', name: 'Echo header' } });
    await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'n1', credentials: mine });
    await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'n2', credentials: mine });
    await run({ workflowId: 'wf_1', versionId: 'v7', nodeId: 'n1', credentials: mine });
    expect(calls.filter((c) => c === versionUrl)).toHaveLength(1);
  });
});
