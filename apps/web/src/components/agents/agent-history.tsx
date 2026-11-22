'use client';
/**
 * An agent's version history (docs/agents.md#version-history-and-restore): the published versions in the kit's history
 * sheet, any two of which can be compared field by field (instructions, tools, model…), and an earlier one restored into
 * the draft. The compare reads both configs from `GET /api/agents/:id/versions/:version` and diffs them in the browser
 * (lib/shared/agent-diff.ts); credentials show by name.
 */
import { useMemo } from 'react';
import { api } from '@/lib/client/api';
import { usedByLine, type AgentVersionUse } from '@/lib/shared/agent-versions';
import { diffAgentConfigs } from '@/lib/shared/agent-diff';
import type { AgentConfig, AgentVersion } from '@/lib/shared/agents';
import { Button } from '../ui/button';
import { HistorySheet, type HistoryCompare, type HistoryEntry } from '../ui/history-sheet';

interface VersionAnswer {
  version: number;
  config: AgentConfig;
}

/** The published versions as history entries, newest first: the live one, then the kept ones, each with the workflows that pin it. */
export function agentHistoryEntries(published: AgentVersion | undefined, history: AgentVersion[], uses: AgentVersionUse[]): HistoryEntry[] {
  const all = published ? [published, ...history.filter((v) => v.version !== published.version)] : history;
  return all.map((v) => {
    const use = uses.find((u) => u.version === v.version);
    const pinned = use?.usedBy.length ? usedByLine(use).replace(/^v\d+ · /, '') : undefined;
    const live = published?.version === v.version;
    return { id: String(v.version), label: `v${v.version}`, at: v.publishedAt, ...(use?.publishedByName && { by: use.publishedByName }), ...(live || pinned ? { note: [live && 'Live', pinned].filter(Boolean).join(' · ') } : {}) };
  });
}

export function AgentHistory({
  agentId,
  open,
  onClose,
  published,
  history,
  uses,
  canRestore,
  onRestore,
}: {
  agentId: string;
  open: boolean;
  onClose: () => void;
  published: AgentVersion | undefined;
  history: AgentVersion[];
  uses: AgentVersionUse[];
  /** Whether a version is not already what the draft holds. */
  canRestore: (version: AgentVersion) => boolean;
  onRestore: (version: number) => void;
}) {
  const entries = useMemo(() => agentHistoryEntries(published, history, uses), [published, history, uses]);
  const compare = async (older: string, newer: string): Promise<HistoryCompare> => {
    const [a, b] = await Promise.all([api<VersionAnswer>(`/api/agents/${agentId}/versions/${older}`), api<VersionAnswer>(`/api/agents/${agentId}/versions/${newer}`)]);
    return diffAgentConfigs(a.config, b.config);
  };
  return (
    <HistorySheet
      open={open}
      onClose={onClose}
      title="Version history"
      entries={entries}
      compare={compare}
      actions={(entry) => {
        const kept = history.find((v) => String(v.version) === entry.id);
        if (!kept || published?.version === kept.version) return null;
        return (
          <Button
            size="sm"
            variant="ghost"
            disabled={!canRestore(kept)}
            onClick={() => {
              onClose();
              onRestore(kept.version);
            }}
          >
            Restore
          </Button>
        );
      }}
    />
  );
}
