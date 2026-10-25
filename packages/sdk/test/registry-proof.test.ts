/** Registry proofs (docs/protocol.md §13): the HTTP and gRPC servers answer the host's GetManifest challenge. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS } from '@landflow/protocol';
import { grpc, loadLandflowProto } from '@landflow/protocol/grpc';
import { answerRegistryChallenge, defineNode, definePlugin, MAX_REGISTRY_CHALLENGE_LENGTH, REGISTRY_CHALLENGE_HEADER, REGISTRY_PROOF_HEADER, registryProof, verifyRegistryProof } from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';

const GRPC_PORT = 47371;
// The same vector is checked by the Go and Python SDKs.
const VECTOR = 'd6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e';

const node = defineNode({
  description: { name: 'noop', displayName: 'Noop', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  execute: (ctx) => ctx.getInputData().map((item) => ({ json: item.json })),
});
const plugin = definePlugin({ info: { id: 'test-plugin', name: 'Test', version: '1' }, nodes: [node] });

let server: grpc.Server;
let client: grpc.Client;
beforeAll(async () => {
  server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
  client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
});
afterAll(() => {
  client.close();
  server.forceShutdown();
});
afterEach(() => {
  delete process.env.LANDFLOW_REGISTRY_SECRET;
});

/** GetManifest over gRPC, returning the response's initial metadata. */
function grpcManifestHeaders(challenge?: string): Promise<grpc.Metadata> {
  return new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata();
    if (challenge) metadata.set(REGISTRY_CHALLENGE_HEADER, challenge);
    let headers = new grpc.Metadata();
    const call = (client as unknown as Record<string, Function>).GetManifest({}, metadata, { deadline: Date.now() + 3000 }, (error: Error | null) =>
      error ? reject(error) : resolve(headers),
    ) as grpc.ClientUnaryCall;
    call.on('metadata', (received: grpc.Metadata) => (headers = received));
  });
}

describe('registry proofs', () => {
  it('computes the shared vector and verifies in constant time', () => {
    expect(registryProof('registry-s3cret', 'test-plugin', 'challenge-123')).toBe(VECTOR);
    expect(verifyRegistryProof('registry-s3cret', 'test-plugin', 'challenge-123', VECTOR)).toBe(true);
    expect(verifyRegistryProof('other', 'test-plugin', 'challenge-123', VECTOR)).toBe(false);
    expect(verifyRegistryProof('registry-s3cret', 'test-plugin', 'challenge-123', 'zz')).toBe(false);
    expect(verifyRegistryProof('registry-s3cret', 'test-plugin', 'challenge-123', undefined)).toBe(false);
    expect(answerRegistryChallenge('test-plugin', 'x'.repeat(MAX_REGISTRY_CHALLENGE_LENGTH + 1), 's')).toEqual({});
    expect(answerRegistryChallenge('test-plugin', 'challenge-123', undefined)).toEqual({});
  });

  it('answers over HTTP only with LANDFLOW_REGISTRY_SECRET set and a challenge sent', async () => {
    const handle = createFetchHandler(plugin);
    const proof = async (challenge?: string) =>
      (await handle(new Request(`http://plugin${HTTP_PATHS.manifest}`, { headers: challenge ? { [REGISTRY_CHALLENGE_HEADER]: challenge } : {} }))).headers.get(REGISTRY_PROOF_HEADER);
    expect(await proof('challenge-123')).toBeNull();
    process.env.LANDFLOW_REGISTRY_SECRET = 'registry-s3cret';
    expect(await proof('challenge-123')).toBe(VECTOR);
    expect(await proof()).toBeNull();
  });

  it('answers over gRPC in the response metadata', async () => {
    expect((await grpcManifestHeaders('challenge-123')).get(REGISTRY_PROOF_HEADER)).toEqual([]);
    process.env.LANDFLOW_REGISTRY_SECRET = 'registry-s3cret';
    expect((await grpcManifestHeaders('challenge-123')).get(REGISTRY_PROOF_HEADER)).toEqual([VECTOR]);
    expect((await grpcManifestHeaders()).get(REGISTRY_PROOF_HEADER)).toEqual([]);
  });
});
