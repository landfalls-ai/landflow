/**
 * Transport Bench: a plugin with one node, Echo, that returns its input unchanged, so a call costs the transport and
 * nothing else. Started by `deploy/scripts/transport-bench.py`, never installed with the app.
 *
 *   LANDFLOW_HTTP_PORT=7620 LANDFLOW_GRPC_PORT=7621 LANDFLOW_TRANSPORTS=http,grpc,kafka LANDFLOW_KAFKA_URL=kafka://127.0.0.1:59092 \
 *     LANDFLOW_TRANSPORT_SECRET=… pnpm --filter @landflow/plugin-transport-bench start
 *
 * Broker faces come from `LANDFLOW_TRANSPORTS` and `LANDFLOW_<KIND>_URL` (plus the driver's own `LANDFLOW_<KIND>_<FIELD>`).
 */
import { definePlugin, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';

class Echo implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'echo',
    displayName: 'Echo',
    description: 'Return the input items unchanged',
    version: 1,
    kind: 'action',
    categories: ['Developer'],
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [],
  };

  async execute(ctx: IExecuteContext) {
    return ctx.getInputData();
  }
}

export const plugin = definePlugin({
  info: { id: 'transport-bench', name: 'Transport Bench', version: '0.1.0', description: 'Echo node for benchmarking transports', author: 'Landflow' },
  nodes: [new Echo()],
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, { http: 7620, grpc: 7621 });
}
