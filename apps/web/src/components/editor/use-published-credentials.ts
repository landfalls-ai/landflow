'use client';
/**
 * Whether a node's credential choice in the draft differs from the one triggers run: the published version's. Fetches that
 * version once per published version. The panel's "keep using the published version" note shows only when this is true,
 * so a workflow that was never published (saving is enough) or whose credentials already match gets no note.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { WorkflowVersion } from '@/lib/shared/types';
import { credentialsDiffer } from '../credentials/use-credentials';

type Refs = Record<string, { id: string }> | undefined;

export function usePublishedCredentialsDiffer(input: { workflowId: string | undefined; versionId: string | undefined; nodeId: string | undefined; credentials: Refs }): boolean {
  const { workflowId, versionId, nodeId, credentials } = input;
  const [published, setPublished] = useState<{ key: string; nodeCredentials: Refs; present: boolean }>();
  const key = `${workflowId}/${versionId}/${nodeId}`;
  useEffect(() => {
    if (!workflowId || !versionId || !nodeId) return;
    let cancelled = false;
    void api<{ version: WorkflowVersion }>(`/api/workflows/${workflowId}/versions/${versionId}`)
      .then(({ version }) => {
        const node = version.workflow.nodes.find((n) => n.id === nodeId);
        if (!cancelled) setPublished({ key, nodeCredentials: node?.credentials, present: Boolean(node) });
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
