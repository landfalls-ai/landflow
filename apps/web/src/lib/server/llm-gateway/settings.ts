/**
 * Where the instance's LLM gateway is (docs/llm-gateway.md): Settings → AI → LLM gateway (settings key `llm_gateway`)
 * names a saved Anthropic API or OpenAI API credential whose Gateway is LiteLLM; without one, the LANDFLOW_LLM_GATEWAY_*
 * variables do. The credential's `apiKey` is the virtual key Landflow's own calls use. The master or proxy-admin key the
 * spend import, the budgets sync and runtime keys need comes ONLY from the server: LANDFLOW_LLM_GATEWAY_ADMIN_KEY, sent
 * only to LANDFLOW_LLM_GATEWAY_URL. Never from a credential: a member who can edit a credential could repoint its URL and
 * receive the master key, or feed the import made-up spend (wave 5's lesson).
 *
 * Also the small JSON states the wave keeps in `settings`: the spend import's status and the last sync report.
 *
 * Contract file of the LiteLLM wave (LL): every package of the wave adds it byte for byte. Change it only through the
 * integrator.
 */
import { z } from 'zod';
import type { JsonObject } from '@landflow/sdk';
import { DEFAULT_LLM_GATEWAY_SETTINGS, type IngestStatus, type LlmGatewaySettings, type LlmGatewaySettingsView, type SyncReport } from '../../shared/llm-gateway';
import { envString } from '../config';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { LiteLlmClient, type Fetcher } from './client';

export const LLM_GATEWAY_KEY = 'llm_gateway';
export const INGEST_STATUS_KEY = 'llm_gateway_ingest';
export const SYNC_REPORT_KEY = 'llm_gateway_sync';

/** The credential types that can carry `gateway: 'litellm'`. */
export const GATEWAY_CREDENTIAL_TYPES = ['core.anthropicApi', 'core.openAiApi'] as const;

const url = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value === '' || /^https?:\/\/[^\s]+$/i.test(value), 'Use an http(s) URL')
  .optional();

export const llmGatewaySettingsSchema = z.object({
  credentialId: z.string().trim().max(200).optional(),
  clusterUrl: url,
  uiUrl: url,
  portalHeaders: z.boolean().optional(),
  ingest: z.boolean().optional(),
  sync: z.boolean().optional(),
  headroomPercent: z.number().min(0).max(100).optional(),
});

function readJson(key: string, db: Database): unknown {
  try {
    const raw = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown, db: Database) {
  db.upsert('settings', { key, value: JSON.stringify(value) });
}

const blankToUndefined = (value: string | undefined) => (value && value.trim() ? value.trim().replace(/\/+$/, '') : undefined);

/** The saved settings over the defaults. */
export function gatewaySettings(db: Database = database()): LlmGatewaySettings {
  const parsed = llmGatewaySettingsSchema.safeParse(readJson(LLM_GATEWAY_KEY, db) ?? {});
  const saved = parsed.success ? parsed.data : {};
  return {
    ...DEFAULT_LLM_GATEWAY_SETTINGS,
    ...Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined && value !== '')),
    ...(blankToUndefined(saved.clusterUrl) && { clusterUrl: blankToUndefined(saved.clusterUrl) }),
    ...(blankToUndefined(saved.uiUrl) && { uiUrl: blankToUndefined(saved.uiUrl) }),
  } as LlmGatewaySettings;
}

/** Merge `input` into the saved settings (an empty string clears a URL or the credential) and store them. */
export function saveGatewaySettings(input: unknown, db: Database = database()): LlmGatewaySettings {
  const change = llmGatewaySettingsSchema.parse(input);
  const current = gatewaySettings(db);
  const next: LlmGatewaySettings = { ...current };
  for (const [key, value] of Object.entries(change) as Array<[keyof LlmGatewaySettings, unknown]>) {
    if (value === undefined) continue;
    if (value === '') delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : value;
  }
  writeJson(LLM_GATEWAY_KEY, next, db);
  return gatewaySettings(db);
}

/** The proxy's root: no trailing slash and no `/v1` (an OpenAI API credential's Base URL ends in /v1). */
export const gatewayRoot = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');

/** Whether a resolved Anthropic API or OpenAI API credential is a LiteLLM gateway. */
export const isGatewayCredential = (data: JsonObject | Record<string, unknown> | undefined): boolean => data?.gateway === 'litellm';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Everything needed to reach the instance's gateway. Server-side only: it holds keys. */
export interface GatewayConnection {
  /** The proxy's root (no /v1). */
  baseUrl: string;
  /** The virtual key Landflow's own calls use. */
  apiKey?: string;
  /** The master or proxy-admin key (spend import, sync, runtime keys): LANDFLOW_LLM_GATEWAY_ADMIN_KEY only. */
  adminKey?: string;
  /** Where the admin key goes: LANDFLOW_LLM_GATEWAY_URL only, never a credential's URL. */
  adminBaseUrl?: string;
  credentialId?: string;
  credentialType?: string;
  /** How kagent's agents reach it. */
  clusterUrl?: string;
  uiUrl: string;
  source: 'credential' | 'environment';
}

/**
 * The instance's gateway: the credential Settings names (when it still exists and is a LiteLLM gateway), else the
 * LANDFLOW_LLM_GATEWAY_* variables; undefined when there is neither.
 */
export async function gatewayConnection(db: Database = database()): Promise<GatewayConnection | undefined> {
  const settings = gatewaySettings(db);
  const envCluster = blankToUndefined(envString('LANDFLOW_LLM_GATEWAY_CLUSTER_URL'));
  const envUi = blankToUndefined(envString('LANDFLOW_LLM_GATEWAY_UI_URL'));
  const envAdmin = envString('LANDFLOW_LLM_GATEWAY_ADMIN_KEY');
  const envUrlForAdmin = envString('LANDFLOW_LLM_GATEWAY_URL');
  const admin = envAdmin && envUrlForAdmin ? { adminKey: envAdmin, adminBaseUrl: gatewayRoot(envUrlForAdmin) } : {};
  if (settings.credentialId) {
    const summary = credentials.list().find((c) => c.id === settings.credentialId);
    if (summary && (GATEWAY_CREDENTIAL_TYPES as readonly string[]).includes(summary.type)) {
      const data = await credentials.dataWithSecrets({ id: summary.id, name: summary.name }, summary.type);
      const base = text(data.baseUrl);
      if (isGatewayCredential(data) && base) {
        const baseUrl = gatewayRoot(base);
        const apiKey = text(data.apiKey);
        const clusterUrl = settings.clusterUrl ?? envCluster;
        return {
          baseUrl,
          ...(apiKey && { apiKey }),
          ...admin,
          credentialId: summary.id,
          credentialType: summary.type,
          ...(clusterUrl && { clusterUrl: gatewayRoot(clusterUrl) }),
          uiUrl: settings.uiUrl ?? envUi ?? `${baseUrl}/ui`,
          source: 'credential',
        };
      }
    }
  }
  const envUrl = envString('LANDFLOW_LLM_GATEWAY_URL');
  if (!envUrl) return undefined;
  const baseUrl = gatewayRoot(envUrl);
  const apiKey = envString('LANDFLOW_LLM_GATEWAY_KEY');
  const clusterUrl = settings.clusterUrl ?? envCluster;
  return {
    baseUrl,
    ...(apiKey && { apiKey }),
    ...admin,
    ...(clusterUrl && { clusterUrl: gatewayRoot(clusterUrl) }),
    uiUrl: settings.uiUrl ?? envUi ?? `${baseUrl}/ui`,
    source: 'environment',
  };
}

/** A client with the admin key (management endpoints), or undefined when there is no admin key. */
export function adminClient(connection: GatewayConnection | undefined, fetcher?: Fetcher): LiteLlmClient | undefined {
  if (!connection?.adminKey || !connection.adminBaseUrl) return undefined;
  return new LiteLlmClient({ baseUrl: connection.adminBaseUrl, key: connection.adminKey, ...(fetcher && { fetcher }) });
}

/** A client with Landflow's own virtual key (models, health). Never the admin key: it may go to a credential's URL. */
export function callerClient(connection: GatewayConnection | undefined, fetcher?: Fetcher): LiteLlmClient | undefined {
  if (!connection) return undefined;
  const key = connection.apiKey;
  return new LiteLlmClient({ baseUrl: connection.baseUrl, ...(key && { key }), ...(fetcher && { fetcher }) });
}

/** The settings page's view: the settings, what the environment sets (no keys), and the credentials that can be the gateway. */
export function gatewaySettingsView(db: Database = database()): LlmGatewaySettingsView {
  const candidates = credentials
    .list()
    .filter((c) => (GATEWAY_CREDENTIAL_TYPES as readonly string[]).includes(c.type))
    .flatMap((c) => {
      const detail = credentials.get(c.id);
      if (!detail || detail.data.gateway !== 'litellm') return [];
      return [{ id: c.id, name: c.name, type: c.type, hasAdminKey: false }];
    });
  const envUrl = envString('LANDFLOW_LLM_GATEWAY_URL');
  const envCluster = envString('LANDFLOW_LLM_GATEWAY_CLUSTER_URL');
  const envUi = envString('LANDFLOW_LLM_GATEWAY_UI_URL');
  return {
    settings: gatewaySettings(db),
    environment: {
      ...(envUrl && { url: gatewayRoot(envUrl) }),
      ...(envCluster && { clusterUrl: gatewayRoot(envCluster) }),
      ...(envUi && { uiUrl: envUi }),
      hasKey: Boolean(envString('LANDFLOW_LLM_GATEWAY_KEY')),
      hasAdminKey: Boolean(envString('LANDFLOW_LLM_GATEWAY_ADMIN_KEY')),
    },
    candidates,
  };
}

const EMPTY_INGEST: IngestStatus = { enabled: false, imported: 0, skipped: 0, totalImported: 0 };

export function ingestStatus(db: Database = database()): IngestStatus {
  const saved = readJson(INGEST_STATUS_KEY, db);
  return saved && typeof saved === 'object' ? { ...EMPTY_INGEST, ...(saved as Partial<IngestStatus>) } : { ...EMPTY_INGEST };
}

export function saveIngestStatus(status: IngestStatus, db: Database = database()) {
  writeJson(INGEST_STATUS_KEY, status, db);
}

export function lastSyncReport(db: Database = database()): SyncReport | undefined {
  const saved = readJson(SYNC_REPORT_KEY, db);
  return saved && typeof saved === 'object' && typeof (saved as SyncReport).at === 'string' ? (saved as SyncReport) : undefined;
}

export function saveSyncReport(report: SyncReport, db: Database = database()) {
  writeJson(SYNC_REPORT_KEY, report, db);
}
