/**
 * gRPC face of the registry (landflow.plugin.v1.RegistryService), so plugins
 * can announce themselves without speaking HTTP. Listens on
 * LANDFLOW_REGISTRY_GRPC_PORT (default 7070; "off" disables).
 */
import {
  announceFromMsg,
  announceResponseToMsg,
  grpc,
  loadLandflowProto,
  withdrawFromMsg,
} from '@landflow/protocol/grpc';
import { announceRequestSchema } from '@landflow/protocol';
import { logger, recordHeartbeat } from '../telemetry';
import { registry } from './registry';

export async function startRegistryGrpcServer(): Promise<grpc.Server | undefined> {
  const setting = process.env.LANDFLOW_REGISTRY_GRPC_PORT ?? '7070';
  if (setting === 'off') return undefined;
  const proto = loadLandflowProto();
  const server = new grpc.Server();
  server.addService(proto.RegistryService.service, {
    async Announce(call: grpc.ServerUnaryCall<Parameters<typeof announceFromMsg>[0], unknown>, callback: grpc.sendUnaryData<unknown>) {
      const parsed = announceRequestSchema.safeParse(announceFromMsg(call.request));
      if (!parsed.success) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      recordHeartbeat(parsed.data.pluginId);
      try {
        callback(null, announceResponseToMsg(await registry.announce(parsed.data)));
      } catch (error) {
        callback({ code: grpc.status.UNAVAILABLE, message: (error as Error).message });
      }
    },
    Withdraw(call: grpc.ServerUnaryCall<Parameters<typeof withdrawFromMsg>[0], unknown>, callback: grpc.sendUnaryData<unknown>) {
      callback(null, { ok: registry.withdraw(withdrawFromMsg(call.request).endpoint) });
    },
  });
  return new Promise((resolve) => {
    server.bindAsync(`0.0.0.0:${setting}`, grpc.ServerCredentials.createInsecure(), (error) => {
      if (error) {
        logger.warn('gRPC registry not started', { 'server.port': setting, error });
        resolve(undefined);
      } else {
        logger.info('gRPC registry listening', { 'server.port': setting });
        resolve(server);
      }
    });
  });
}
