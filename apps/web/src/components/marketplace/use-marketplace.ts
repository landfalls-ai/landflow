'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { ExploreResult, InstalledPlugin, LibrarySkill, MarketplaceSummary } from '@/lib/shared/marketplace';

export interface Preset {
  id: string;
  input: string;
  label: string;
  description: string;
  added: boolean;
}

/** Marketplaces, presets and installed plugins: GET /api/marketplaces. */
export function useMarketplaces() {
  const [data, setData] = useState<{ marketplaces: MarketplaceSummary[]; presets: Preset[]; installed: InstalledPlugin[] }>();
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setData(await api('/api/marketplaces'));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...data, error, reload };
}

/** Every added marketplace at once (GET /api/marketplaces/explore); `version` reloads it after an install or refresh. */
export function useExplore(version: number) {
  const [explore, setExplore] = useState<ExploreResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setLoading(true);
    api<ExploreResult>('/api/marketplaces/explore')
      .then((r) => {
        if (!live) return;
        setExplore(r);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [version]);
  return { explore, loading, error };
}

export function useSkillLibrary(version: number) {
  const [skills, setSkills] = useState<LibrarySkill[]>();
  useEffect(() => {
    void api<{ skills: LibrarySkill[] }>('/api/skills').then((r) => setSkills(r.skills));
  }, [version]);
  return skills;
}

export const UNSUPPORTED_LABEL: Record<string, string> = {
  commands: 'Slash commands',
  hooks: 'Hooks',
  mcpServers: 'MCP servers',
  lspServers: 'LSP servers',
  outputStyles: 'Output styles',
  bin: 'Executables',
  monitors: 'Monitors',
  workflows: 'Claude Code workflows',
};
