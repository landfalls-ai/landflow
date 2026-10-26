/**
 * "Expose to agents" per plugin (docs/transports.md "The bundled MCP gateway"): whether the plugin's tools are served at
 * /api/mcp/plugins/<id> and registered as a gateway target. On by default for every plugin (core included); only the
 * plugins switched off have a row in `plugin_mcp_exposure` (migration 1720), shared by mains and workers in queue mode.
 * A change is published on the registry bus as `plugin.updated`, so the gateway sync and the `core` endpoint's
 * `tools/list_changed` react like they do to a manifest change.
 */
import type { RegistryEvent } from '../../shared/types';
import { bus } from '../bus';
import { database, type Database } from '../db';
import { onTablesChanged } from '../db/replication';
import { singleton } from '../singleton';

interface Row {
  plugin_id: string;
  exposed: number;
}

export interface ExposureStoreOptions {
  db?: () => Database;
  /** Where a change is announced (default: the registry bus). */
  publish?: (event: RegistryEvent) => void;
}

export class McpExposureStore {
  private cache?: Set<string>;
  private readonly db: () => Database;
  private readonly publish: (event: RegistryEvent) => void;

  constructor(options: ExposureStoreOptions = {}) {
    this.db = options.db ?? database;
    this.publish = options.publish ?? ((event) => bus.publish({ channel: 'registry', event }));
    onTablesChanged((change) => {
      if (change.tables.has('plugin_mcp_exposure')) this.invalidate();
    });
  }

  /** The plugins switched off. */
  private hidden(): Set<string> {
    if (!this.cache) {
      this.cache = new Set(
        this.db()
          .all<Row>('SELECT plugin_id, exposed FROM plugin_mcp_exposure')
          .filter((row) => Number(row.exposed) === 0)
          .map((row) => row.plugin_id),
      );
    }
    return this.cache;
  }

  /** Forget the cached rows (the next read goes to the table). */
  invalidate(): void {
    this.cache = undefined;
  }

  /** Whether the plugin's tools are offered to agents (true without a row). */
  isExposed(pluginId: string): boolean {
    return !this.hidden().has(pluginId);
  }

  /** Switch a plugin's exposure; the default (on) removes the row. Announces the change when it is one. */
  set(pluginId: string, exposed: boolean, options: { updatedBy?: string; pluginName?: string } = {}): boolean {
    const before = this.isExposed(pluginId);
    if (exposed) this.db().delete('plugin_mcp_exposure', { plugin_id: pluginId });
    else this.db().upsert('plugin_mcp_exposure', { plugin_id: pluginId, exposed: 0, updated_at: new Date().toISOString(), updated_by: options.updatedBy ?? null });
    this.invalidate();
    if (before !== exposed) {
      this.publish({ type: 'plugin.updated', pluginId, message: `${options.pluginName ?? pluginId} ${exposed ? 'exposed to agents' : 'hidden from agents'}` });
    }
    return exposed;
  }
}

export const mcpExposure = singleton('mcp-exposure', () => new McpExposureStore());
