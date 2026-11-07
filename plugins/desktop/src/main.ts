/**
 * Desktop: a Landflow plugin that lets a flow or an agent see and use a disposable virtual desktop (docs/specs/18-desktop-agent-node.md).
 *
 *   pnpm --filter @landflow/plugin-desktop start
 *
 * Serves HTTP on :7117 (MCP face at /mcp) and gRPC on :7217, then announces both to the host. Needs the local Docker engine
 * (`docker` on PATH, or LANDFLOW_DESKTOP_DOCKER_BIN) and the image landflow/desktop-sandbox:dev
 * (`docker buildx build --load -t landflow/desktop-sandbox:dev services/desktop-sandbox`).
 *
 * Environment: LANDFLOW_DESKTOP_DOCKER_CONTEXT (e.g. orbstack), LANDFLOW_DESKTOP_IMAGE, LANDFLOW_DESKTOP_APPS and
 * LANDFLOW_DESKTOP_ALLOWED_HOSTS (the operator's ceilings), LANDFLOW_DESKTOP_MAX_STEPS, LANDFLOW_DESKTOP_MAX_MINUTES,
 * LANDFLOW_DESKTOP_MEMORY, LANDFLOW_DESKTOP_CPUS. Brokers and MCP settings are as in the other plugins (docs/transports.md).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Desktop } from './nodes/desktop';
import { DockerDriver } from './sandbox';

const driver = new DockerDriver();

export const plugin = definePlugin({
  info: {
    id: 'desktop',
    name: 'Desktop',
    version: '0.1.0',
    description: 'See and use a disposable virtual desktop (screenshot, click, type, key, scroll) in a locked-down container',
    icon: 'file:desktop.svg',
    color: '#4338ca',
    author: 'Landflow',
  },
  nodes: [new Desktop(driver)],
  iconDir: new URL('../icons/', import.meta.url),
});

/** Each live desktop is a container with a browser in it: a few calls at once. */
export const DEFAULT_MAX_CONCURRENCY = 4;

if (import.meta.url === `file://${process.argv[1]}`) {
  // The janitor: sandboxes past their deadline (a crashed run, a killed plugin) are removed, at start and every minute.
  // It touches only containers and networks labelled landflow.desktop=1.
  const sweep = () => driver.sweep().catch(() => 0);
  await sweep();
  setInterval(sweep, 60_000).unref();
  await serve(plugin, {
    http: 7117,
    grpc: 7217,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
