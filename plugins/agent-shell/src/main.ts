import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { AgentShell } from './nodes/agent-shell';

export const plugin = definePlugin({
  info: {
    id: 'agent-shell',
    name: 'Agent Shell',
    version: '0.1.0',
    description: 'A simulated bash over an in-memory filesystem for agents: no host files, no network (just-bash)',
    icon: 'file:agent-shell.svg',
    color: '#334155',
    author: 'Landflow',
  },
  nodes: [new AgentShell()],
  iconDir: new URL('../icons/', import.meta.url),
});

/** The shell runs in this process (single-threaded JavaScript), so a few calls at once is plenty. */
export const DEFAULT_MAX_CONCURRENCY = 4;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7114,
    grpc: 7214,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
