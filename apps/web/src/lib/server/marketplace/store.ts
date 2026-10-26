/**
 * Added marketplaces with their cached catalogs, installed plugins with exactly what each install
 * created (so uninstall removes only that), and the skill library. One JSON file each under
 * LANDFLOW_DATA_DIR: marketplaces.json, skill-library.json (in queue mode their `config_files` rows, ../config-store.ts).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { InstalledPlugin, LibrarySkill, MarketplaceLocation } from '../../shared/marketplace';
import { ConfigFile } from '../config-store';
import { singleton } from '../singleton';
import { store } from '../store';
import type { MarketplaceEntry } from './plugin';

export interface StoredMarketplace {
  id: string;
  input: string;
  location: MarketplaceLocation;
  preset?: boolean;
  name?: string;
  description?: string;
  owner?: string;
  /** metadata.pluginRoot */
  pluginRoot?: string;
  entries?: MarketplaceEntry[];
  fetchedAt?: string;
  error?: string;
  addedAt: string;
}

interface MarketplaceFile {
  version: 1;
  marketplaces: StoredMarketplace[];
  installed: InstalledPlugin[];
}

export const PRESETS: Array<{ id: string; input: string; label: string; description: string; location: MarketplaceLocation }> = [
  {
    id: 'mk_anthropic_official',
    input: 'anthropics/claude-plugins-official',
    label: 'Anthropic official',
    description: 'Anthropic’s directory of Claude Code plugins',
    location: { kind: 'github', owner: 'anthropics', repo: 'claude-plugins-official' },
  },
  {
    id: 'mk_anthropic_skills',
    input: 'anthropics/skills',
    label: 'Anthropic Agent Skills',
    description: 'Anthropic’s example and document skills',
    location: { kind: 'github', owner: 'anthropics', repo: 'skills' },
  },
];

class MarketplaceStore {
  readonly dir = join(store.dir, 'marketplace');
  /** marketplaces.json and skill-library.json, or their `config_files` rows in queue mode (../config-store.ts). */
  private readonly file = new ConfigFile<MarketplaceFile>('marketplaces.json', { dir: () => store.dir });
  private readonly libraryFile = new ConfigFile<{ skills: LibrarySkill[] }>('skill-library.json', { dir: () => store.dir });

  constructor() {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Read on use (Postgres mode opens the database after this module loads; other processes may have changed it). */
  private get data(): MarketplaceFile {
    const saved = this.file.read();
    const data: MarketplaceFile = saved && Array.isArray(saved.marketplaces) ? { ...saved, version: 1, installed: saved.installed ?? [] } : { version: 1, marketplaces: [], installed: [] };
    // The Anthropic official marketplace is always listed (fetched only when opened).
    const preset = PRESETS[0];
    if (!data.marketplaces.some((m) => m.id === preset.id)) {
      data.marketplaces.unshift({ id: preset.id, input: preset.input, location: preset.location, preset: true, addedAt: new Date().toISOString() });
      this.persist(data);
    }
    return data;
  }

  private persist(data: MarketplaceFile) {
    this.file.write(data);
  }

  private get library(): LibrarySkill[] {
    return this.libraryFile.read()?.skills ?? [];
  }

  marketplaces(): StoredMarketplace[] {
    return this.data.marketplaces;
  }

  marketplace(id: string): StoredMarketplace | undefined {
    return this.data.marketplaces.find((m) => m.id === id);
  }

  addMarketplace(input: string, location: MarketplaceLocation, id = `mk_${nanoid(8)}`): StoredMarketplace {
    const marketplace: StoredMarketplace = { id, input, location, ...(PRESETS.some((p) => p.id === id) && { preset: true }), addedAt: new Date().toISOString() };
    const data = this.data;
    this.persist({ ...data, marketplaces: [...data.marketplaces, marketplace] });
    return marketplace;
  }

  updateMarketplace(id: string, patch: Partial<StoredMarketplace>): StoredMarketplace | undefined {
    const data = this.data;
    const index = data.marketplaces.findIndex((m) => m.id === id);
    if (index < 0) return undefined;
    const marketplaces = [...data.marketplaces];
    marketplaces[index] = { ...marketplaces[index], ...patch };
    this.persist({ ...data, marketplaces });
    return marketplaces[index];
  }

  removeMarketplace(id: string): boolean {
    const data = this.data;
    const marketplaces = data.marketplaces.filter((m) => m.id !== id);
    if (marketplaces.length === data.marketplaces.length) return false;
    this.persist({ ...data, marketplaces });
    return true;
  }

  installed(): InstalledPlugin[] {
    return this.data.installed;
  }

  installedOne(id: string): InstalledPlugin | undefined {
    return this.data.installed.find((p) => p.id === id);
  }

  saveInstalled(plugin: InstalledPlugin) {
    const data = this.data;
    this.persist({ ...data, installed: [...data.installed.filter((p) => p.id !== plugin.id), plugin] });
  }

  removeInstalled(id: string) {
    const data = this.data;
    this.persist({ ...data, installed: data.installed.filter((p) => p.id !== id) });
  }

  skills(): LibrarySkill[] {
    return this.library;
  }

  addSkills(skills: LibrarySkill[]) {
    this.libraryFile.write({ skills: [...this.library, ...skills] });
  }

  removeSkills(ids: string[]) {
    const drop = new Set(ids);
    this.libraryFile.write({ skills: this.library.filter((s) => !drop.has(s.id)) });
  }
}

export const marketplaceStore = singleton('marketplace-store', () => new MarketplaceStore());
