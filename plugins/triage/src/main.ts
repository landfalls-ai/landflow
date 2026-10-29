/**
 * Alert Triage: deterministic nodes and the safety policy for deciding whether an alert deserves a war room.
 *
 *   pnpm --filter @landflow/plugin-triage start
 *
 * Serves HTTP on :7109 (with the MCP face at /mcp) and gRPC on :7209, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment (docs/transports.md):
 * `LANDFLOW_TRANSPORTS=http,grpc,nats` with `LANDFLOW_NATS_URL=…` adds a NATS face, and so on.
 * `LANDFLOW_MAX_CONCURRENCY` overrides the concurrency limit.
 *
 * MCP: on by default. In dev everything binds to loopback (`LANDFLOW_HOST`, default 127.0.0.1, or 0.0.0.0 when
 * `LANDFLOW_ADVERTISE_HOST` is set as in a container), where the face needs no token; on any other host set
 * `LANDFLOW_MCP_TOKEN` (or `LANDFLOW_MCP=off`).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { AiTriage } from './composites/ai-triage';
import { ExtractIocs } from './nodes/extract-iocs';
import { NormalizeAlert } from './nodes/normalize-alert';
import { ParseEmail } from './nodes/parse-email';
import { TriageDecision } from './nodes/triage-decision';
import { TriageRules } from './nodes/triage-rules';

export const plugin = definePlugin({
  info: {
    id: 'triage',
    name: 'Alert Triage',
    version: '0.1.0',
    description: 'Normalise alerts, extract IOCs, parse phishing e-mail, apply approved triage rules and a fail-open decision gate',
    icon: 'file:triage.svg',
    color: '#0d9488',
    author: 'Landflow',
  },
  nodes: [NormalizeAlert, ExtractIocs, ParseEmail, TriageRules, TriageDecision],
  composites: [AiTriage],
  // `file:` icons (plugin and nodes) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

/** Calls running node code at once (env LANDFLOW_MAX_CONCURRENCY overrides): CPU-bound parsing, no I/O. */
export const DEFAULT_MAX_CONCURRENCY = 8;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7109,
    grpc: 7209,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
