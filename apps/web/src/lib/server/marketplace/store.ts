/**
 * Added marketplaces with their cached catalogs, installed plugins with exactly what each install
 * created (so uninstall removes only that), and the skill library. One JSON file each under
 * LANDFLOW_DATA_DIR: marketplaces.json, skill-library.json.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { InstalledPlugin, LibrarySkill, MarketplaceLocation } from '../../shared/marketplace';
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

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function atomicWrite(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

class MarketplaceStore {
  readonly dir = join(store.dir, 'marketplace');
  private readonly path = join(store.dir, 'marketplaces.json');
  private readonly libraryPath = join(store.dir, 'skill-library.json');
  private data: MarketplaceFile;
  private library: LibrarySkill[];

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    this.data = readJson<MarketplaceFile>(this.path) ?? { version: 1, marketplaces: [], installed: [] };
    this.library = readJson<{ skills: LibrarySkill[] }>(this.libraryPath)?.skills ?? [];
    // The Anthropic official marketplace is always listed (fetched only when opened).
    const preset = PRESETS[0];
    if (!this.data.marketplaces.some((m) => m.id === preset.id)) {
      this.data.marketplaces.unshift({ id: preset.id, input: preset.input, location: preset.location, preset: true, addedAt: new Date().toISOString() });
      this.persist();
    }
  }

  private persist() {
    atomicWrite(this.path, this.data);
  }

  marketplaces(): StoredMarketplace[] {
    return this.data.marketplaces;
  }

  marketplace(id: string): StoredMarketplace | undefined {
    return this.data.marketplaces.find((m) => m.id === id);
  }

  addMarketplace(input: string, location: MarketplaceLocation, id = `mk_${nanoid(8)}`): StoredMarketplace {
    const marketplace: StoredMarketplace = { id, input, location, ...(PRESETS.some((p) => p.id === id) && { preset: true }), addedAt: new Date().toISOString() };
    this.data.marketplaces.push(marketplace);
    this.persist();
    return marketplace;
  }

  updateMarketplace(id: string, patch: Partial<StoredMarketplace>): StoredMarketplace | undefined {
    const index = this.data.marketplaces.findIndex((m) => m.id === id);
    if (index < 0) return undefined;
    this.data.marketplaces[index] = { ...this.data.marketplaces[index], ...patch };
    this.persist();
    return this.data.marketplaces[index];
  }

  removeMarketplace(id: string): boolean {
    const before = this.data.marketplaces.length;
    this.data.marketplaces = this.data.marketplaces.filter((m) => m.id !== id);
    if (this.data.marketplaces.length === before) return false;
    this.persist();
    return true;
  }

  installed(): InstalledPlugin[] {
    return this.data.installed;
  }

  installedOne(id: string): InstalledPlugin | undefined {
    return this.data.installed.find((p) => p.id === id);
  }

  saveInstalled(plugin: InstalledPlugin) {
    this.data.installed = [...this.data.installed.filter((p) => p.id !== plugin.id), plugin];
    this.persist();
  }

  removeInstalled(id: string) {
    this.data.installed = this.data.installed.filter((p) => p.id !== id);
    this.persist();
  }

  skills(): LibrarySkill[] {
    return this.library;
  }

  addSkills(skills: LibrarySkill[]) {
    this.library = [...this.library, ...skills];
    atomicWrite(this.libraryPath, { skills: this.library });
  }

  removeSkills(ids: string[]) {
    const drop = new Set(ids);
    this.library = this.library.filter((s) => !drop.has(s.id));
    atomicWrite(this.libraryPath, { skills: this.library });
  }
}

export const marketplaceStore = singleton('marketplace-store', () => new MarketplaceStore());
