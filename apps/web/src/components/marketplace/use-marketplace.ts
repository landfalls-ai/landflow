'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { Catalog, InstalledPlugin, LibrarySkill, MarketplaceSummary } from '@/lib/shared/marketplace';

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

/** One marketplace's catalog; the server fetches it on first open. */
export function useCatalog(id: string | undefined) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (refresh = false) => {
      if (!id) return;
      setLoading(true);
      setError(undefined);
      try {
        if (refresh) await api(`/api/marketplaces/${id}/refresh`, { method: 'POST' });
        setCatalog(await api<Catalog>(`/api/marketplaces/${id}`));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [id],
  );
  useEffect(() => {
    setCatalog(undefined);
    void load();
  }, [load]);
  return { catalog: catalog?.marketplace.id === id ? catalog : undefined, loading, error, load };
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
