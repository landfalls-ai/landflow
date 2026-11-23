/**
 * dot-agent-deck: a Landflow plugin that starts a unit of work in the person's deck (https://github.com/dot-agent-deck)
 * and reports its completion to the run.
 *
 *   pnpm plugin:deck      # from a terminal pane INSIDE the deck: the deck's CLI refuses anywhere else
 *
 * Serves HTTP on :7122 only (no gRPC and no MCP face), then announces it to the host (`LANDFLOW_REGISTRY_URL`,
 * default http://127.0.0.1:3000). Opt-in: not part of `dev:all`, no image, no cluster component. Environment:
 * `LANDFLOW_TRANSPORT_SECRET` (the same value as the host's; required) guards the HTTP face, `LANDFLOW_DECK_BIN` names the binary, `LANDFLOW_DECK_ALLOW_COMMAND=1` lets a flow choose a unit's command. Traces go to
 * the usual `OTEL_EXPORTER_OTLP_*` endpoint (docs/observability.md).
 */
import { definePlugin, getTelemetry } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { checkDeck, inPane } from './deck-cli';
import { Deck } from './nodes/deck';

export const plugin = definePlugin({
  info: {
    id: 'deck',
    name: 'dot-agent-deck',
    version: '0.1.0',
    description: 'Start a unit of work in your dot-agent-deck from a flow and hear when it finishes',
    icon: 'file:deck.svg',
    color: '#4f46e5',
    author: 'Landflow',
  },
  nodes: [new Deck()],
  iconDir: new URL('../icons/', import.meta.url),
});

/** A unit is one pane of work, so only a few dispatches at once. */
export const DEFAULT_MAX_CONCURRENCY = 2;

if (import.meta.url === `file://${process.argv[1]}`) {
  // The plugin still announces without the deck or a pane; its node then fails with a message naming the fix.
  const log = getTelemetry().logger;
  const deck = await checkDeck();
  if (!deck.ok) log.warn('dot-agent-deck is not usable: Dispatch will fail until it is', { reason: deck.reason });
  if (!inPane()) log.warn('not running inside a deck pane (DOT_AGENT_DECK_PANE_ID is unset): Dispatch will fail until the plugin is started from one');
  if (process.env.LANDFLOW_GRPC_PORT) {
    log.warn('LANDFLOW_GRPC_PORT is ignored: the deck plugin serves HTTP only, because its gRPC face would be unguarded');
    delete process.env.LANDFLOW_GRPC_PORT;
  }
  await serve(plugin, {
    http: 7122,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    // A plugin that starts real work on this machine: HTTP only (no gRPC face: it has no guard and can listen beyond loopback
    // when LANDFLOW_ADVERTISE_HOST is set; the host uses the HTTP face), no MCP face, and the HTTP face refuses browsers and callers without the
    // token derived from LANDFLOW_TRANSPORT_SECRET (the host sends it). serve() refuses to start without that secret.
    mcp: false,
    guardHttp: true,
  });
}
