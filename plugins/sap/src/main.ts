/**
 * SAP: a Landflow plugin for SAP S/4HANA Cloud over OData. An SAP OData node (get, list, create, update, delete with CSRF and ETag
 * handled), five presets (Business Partner, Sales Order, Purchase Order, Product, Supplier Invoice), a poll trigger and an event
 * trigger (a webhook that reads CloudEvents). Usable as an agent tool: reads by default, writes only when the node allows them.
 *
 *   pnpm --filter @landflow/plugin-sap start
 *
 * Serves HTTP on :7116 (MCP face at /mcp) and gRPC on :7216, then announces both to the host. No real SAP system is ever called by a
 * test: they run against `test/fake-s4.ts`.
 *
 * Environment: `LANDFLOW_SAP_ALLOWED_HOSTS` limits which hosts the plugin calls (comma separated; `.suffix` matches subdomains; a host
 * named exactly may use http, which is how a local fake is allowed); `LANDFLOW_SAP_METADATA_TTL_SECONDS` is the `$metadata` cache time
 * (default 3600). Brokers and MCP settings are as in the other plugins (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { CREDENTIAL_TYPES } from './credentials';
import { sapEvent } from './nodes/sap-event';
import { presetNodes, sapOData } from './nodes/sap-odata';
import { sapTrigger } from './nodes/sap-trigger';

export const plugin = definePlugin({
  info: {
    id: 'sap',
    name: 'SAP',
    version: '0.1.0',
    description: 'Read and change SAP S/4HANA Cloud data (OData), poll or receive events, as flow steps or agent tools',
    icon: 'file:sap.svg',
    color: '#0a6ed1',
    author: 'Landflow',
  },
  nodes: [sapOData, ...presetNodes, sapTrigger, sapEvent],
  credentialTypes: CREDENTIAL_TYPES,
  iconDir: new URL('../icons/', import.meta.url),
});

export const DEFAULT_MAX_CONCURRENCY = 4;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7116,
    grpc: 7216,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
