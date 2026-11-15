/**
 * The gateway's health and models for the AI page (docs/llm-gateway.md). Cached for 30 seconds per process. Everyone
 * signed in gets the health and the models; owners and admins also get where the gateway is and what it last did.
 * Never a key: the check uses Landflow's own virtual key, never the admin key.
 */
import { isInstanceAdmin } from '../projects/access';
import type { Actor } from '../projects/access';
import { singleton } from '../singleton';
import type { GatewayStatus } from '../../shared/llm-gateway';
import { callerClient, gatewayConnection, gatewaySettings, ingestStatus, lastSyncReport, type GatewayConnection } from './settings';
import { LiteLlmError } from './client';

const CACHE_MS = 30_000;

interface Checked {
  at: number;
  /** The connection this was checked against, so a changed gateway is not served from the cache. */
  key: string;
  health: GatewayStatus['health'];
  error?: string;
  models: GatewayStatus['models'];
}

const cache = () => singleton('llm-gateway-status', () => ({ value: undefined as Checked | undefined }));

/** Forget the cached check (tests, and after Settings saves a gateway). */
export function resetGatewayStatus() {
  cache().value = undefined;
}

const errorText = (error: unknown): string => (error instanceof LiteLlmError || error instanceof Error ? error.message : 'The gateway did not answer');

async function check(connection: GatewayConnection): Promise<Checked> {
  const key = `${connection.baseUrl}|${connection.apiKey ?? ''}`;
  const held = cache().value;
  if (held && held.key === key && Date.now() - held.at < CACHE_MS) return held;
  const client = callerClient(connection)!;
  let checked: Checked;
  try {
    const health = await client.health();
    if (!health.live) {
      checked = { at: Date.now(), key, health: 'down', error: health.error ?? 'The gateway did not answer', models: [] };
    } else {
      const models = await client.models().catch(() => []);
      checked = { at: Date.now(), key, health: health.ready ? 'ok' : 'degraded', ...(!health.ready && health.error && { error: health.error }), models: models.map((m) => ({ id: m.id, ...(m.owned_by && { ownedBy: m.owned_by }) })) };
    }
  } catch (error) {
    checked = { at: Date.now(), key, health: 'down', error: errorText(error), models: [] };
  }
  cache().value = checked;
  return checked;
}

export async function gatewayStatus(actor: Actor): Promise<GatewayStatus> {
  const connection = await gatewayConnection();
  if (!connection) return { configured: false, health: 'unknown', checkedAt: new Date().toISOString(), models: [] };
  const checked = await check(connection);
  const settings = gatewaySettings();
  const sync = lastSyncReport();
  return {
    configured: true,
    source: connection.source,
    health: checked.health,
    checkedAt: new Date(checked.at).toISOString(),
    ...(checked.error && { error: checked.error }),
    models: checked.models,
    ...(isInstanceAdmin(actor) && {
      admin: {
        baseUrl: connection.baseUrl,
        uiUrl: connection.uiUrl,
        ...(connection.credentialId && { credentialId: connection.credentialId }),
        ...(connection.clusterUrl && { clusterUrl: connection.clusterUrl }),
        portalHeaders: settings.portalHeaders,
        ingest: ingestStatus(),
        ...(sync && { sync }),
      },
    }),
  };
}
