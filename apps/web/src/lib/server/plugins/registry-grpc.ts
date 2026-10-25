/**
 * gRPC face of the registry (landflow.plugin.v1.RegistryService), so plugins
 * can announce themselves without speaking HTTP. Listens on
 * LANDFLOW_REGISTRY_GRPC_PORT (default 7070; "off" disables). With
 * LANDFLOW_REGISTRY_SECRET set, calls must carry it as the
 * `x-landflow-registry-secret` metadata (like the HTTP registry's header).
 */
import {
  announceFromMsg,
  announceResponseToMsg,
  grpc,
  loadLandflowProto,
  withdrawFromMsg,
} from '@landflow/protocol/grpc';
import { announceRequestSchema } from '@landflow/protocol';
import { sameSecret } from '../auth/passwords';
import { logger, recordHeartbeat } from '../telemetry';
import { registry } from './registry';

/** LANDFLOW_REGISTRY_SECRET, when set, must come with every registry call. */
function secretOk(metadata: grpc.Metadata): boolean {
  const secret = process.env.LANDFLOW_REGISTRY_SECRET;
  if (!secret) return true;
  const given = metadata.get('x-landflow-registry-secret')[0];
  return sameSecret(typeof given === 'string' ? given : given?.toString(), secret);
}

const UNAUTHENTICATED = { code: grpc.status.UNAUTHENTICATED, message: 'Send the registry secret (LANDFLOW_REGISTRY_SECRET) as x-landflow-registry-secret metadata' };

export async function startRegistryGrpcServer(): Promise<grpc.Server | undefined> {
  const setting = process.env.LANDFLOW_REGISTRY_GRPC_PORT ?? '7070';
  if (setting === 'off') return undefined;
  const proto = loadLandflowProto();
  const server = new grpc.Server();
  server.addService(proto.RegistryService.service, {
    async Announce(call: grpc.ServerUnaryCall<Parameters<typeof announceFromMsg>[0], unknown>, callback: grpc.sendUnaryData<unknown>) {
      if (!secretOk(call.metadata)) return callback(UNAUTHENTICATED);
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
      if (!secretOk(call.metadata)) return callback(UNAUTHENTICATED);
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
