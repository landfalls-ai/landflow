'use client';
/**
 * Whether a node's credential choice in the draft differs from the one triggers run: the published version's. Fetches that
 * version's nodes once per published version id (a published version never changes), shared by every node panel. The panel's "keep using the published version" note shows only when this is true,
 * so a workflow that was never published (saving is enough) or whose credentials already match gets no note.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { WorkflowVersion } from '@/lib/shared/types';
import { credentialsDiffer } from '../credentials/use-credentials';

type Refs = Record<string, { id: string }> | undefined;
type PublishedNodes = Map<string, Refs>;

/** Published version id → its nodes' credentials. Versions are immutable, so an answer never goes stale. */
const versions = new Map<string, Promise<PublishedNodes>>();

function publishedNodes(workflowId: string, versionId: string): Promise<PublishedNodes> {
  const cacheKey = `${workflowId}/${versionId}`;
  let pending = versions.get(cacheKey);
  if (!pending) {
    pending = api<{ version: WorkflowVersion }>(`/api/workflows/${workflowId}/versions/${versionId}`).then(
      ({ version }) => new Map(version.workflow.nodes.map((n) => [n.id, n.credentials as Refs])),
    );
    // A failed fetch isn't cached: the next panel opening asks again.
    pending.catch(() => versions.delete(cacheKey));
    versions.set(cacheKey, pending);
  }
  return pending;
}

/** For tests: forget every cached published version. */
export function clearPublishedCredentialsCache(): void {
  versions.clear();
}

export function usePublishedCredentialsDiffer(input: { workflowId: string | undefined; versionId: string | undefined; nodeId: string | undefined; credentials: Refs }): boolean {
  const { workflowId, versionId, nodeId, credentials } = input;
  const [published, setPublished] = useState<{ key: string; nodeCredentials: Refs; present: boolean }>();
  const key = `${workflowId}/${versionId}/${nodeId}`;
  useEffect(() => {
    if (!workflowId || !versionId || !nodeId) return;
    let cancelled = false;
    void publishedNodes(workflowId, versionId)
      .then((nodes) => {
        if (!cancelled) setPublished({ key, nodeCredentials: nodes.get(nodeId), present: nodes.has(nodeId) });
      })
      .catch(() => {
        if (!cancelled) setPublished(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, versionId, nodeId, key]);
  // A node the published version doesn't have isn't run by triggers at all: nothing to say.
  return Boolean(versionId && published?.key === key && published.present && credentialsDiffer(credentials, published.nodeCredentials));
}
