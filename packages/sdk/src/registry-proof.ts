/**
 * Registry proofs (docs/protocol.md §13). A host that finds plugins itself (Kubernetes discovery) gets no announce
 * on which to check LANDFLOW_REGISTRY_SECRET, so it sends a random challenge with GetManifest (HTTP header or gRPC
 * metadata `x-landflow-registry-challenge`) and the plugin answers with `x-landflow-registry-proof`: an HMAC of the
 * challenge and its plugin id, keyed with the secret. The secret itself never travels. The HTTP and gRPC servers here
 * answer automatically when LANDFLOW_REGISTRY_SECRET is set; the Go and Python SDKs do the same.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const REGISTRY_CHALLENGE_HEADER = 'x-landflow-registry-challenge';
export const REGISTRY_PROOF_HEADER = 'x-landflow-registry-proof';
/** Longer challenges are ignored (hosts send 43 characters: 32 random bytes, base64url). */
export const MAX_REGISTRY_CHALLENGE_LENGTH = 256;

/** Hex HMAC-SHA256 of `landflow-registry-proof/v1\n<pluginId>\n<challenge>`, keyed with the registry secret. */
export function registryProof(secret: string, pluginId: string, challenge: string): string {
  return createHmac('sha256', secret).update(`landflow-registry-proof/v1\n${pluginId}\n${challenge}`).digest('hex');
}

/** The proof header answering `challenge`, when this process has LANDFLOW_REGISTRY_SECRET and was challenged; else none. */
export function answerRegistryChallenge(pluginId: string, challenge: string | null | undefined, secret = process.env.LANDFLOW_REGISTRY_SECRET): Record<string, string> {
  if (!secret || !challenge || challenge.length > MAX_REGISTRY_CHALLENGE_LENGTH) return {};
  return { [REGISTRY_PROOF_HEADER]: registryProof(secret, pluginId, challenge) };
}

/** Host side: does `proof` answer `challenge` for `pluginId` under `secret`? Constant-time. */
export function verifyRegistryProof(secret: string, pluginId: string, challenge: string, proof: string | undefined): boolean {
  if (!proof || !/^[0-9a-f]{64}$/i.test(proof)) return false;
  return timingSafeEqual(Buffer.from(registryProof(secret, pluginId, challenge), 'hex'), Buffer.from(proof, 'hex'));
}
