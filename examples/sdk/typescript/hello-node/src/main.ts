/**
 * Serve the plugin and announce it to the Landflow host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000).
 *
 *   LANDFLOW_REGISTRY_URL=off tsx src/main.ts     # stand-alone, no host
 *
 * HTTP on :7191 (the MCP face is at /mcp), gRPC on :7291. LANDFLOW_HTTP_PORT and LANDFLOW_GRPC_PORT override the ports.
 */
import { serve } from '@landflow/sdk/serve';
import { plugin } from './plugin';

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7191,
    grpc: 7291,
    // Loopback in dev (the MCP face then needs no token); in a container LANDFLOW_ADVERTISE_HOST is set and every face listens on 0.0.0.0.
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: 8,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
