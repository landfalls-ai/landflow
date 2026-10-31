import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { GetAlerts } from './nodes/get-alerts';
import { GetAlertDetails } from './nodes/get-alert-details';
import { AcknowledgeAlert } from './nodes/acknowledge-alert';
import { GrafanaCredential } from './credentials';

export const plugin = definePlugin({
  info: {
    id: 'grafana',
    name: 'Grafana',
    version: '0.1.0',
    description: 'Plugin for interacting with Grafana Alertmanager API',
    icon: 'file:grafana.svg',
    color: '#f43f5e',
    author: 'Landflow',
  },
  nodes: [new GetAlerts(), new GetAlertDetails(), new AcknowledgeAlert()],
  credentials: [GrafanaCredential],
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7105,
    grpc: 7205,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: 8,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}