/**
 * The registry secret for plugins the host finds itself (Kubernetes discovery). Announcing plugins send
 * LANDFLOW_REGISTRY_SECRET with every announce; a discovered plugin announces nothing, so with the secret set the host
 * challenges it on GetManifest and accepts the manifest only with a proof that the plugin holds the same secret
 * (docs/protocol.md §13; the SDKs answer in registry-proof.ts / registry_proof.go / registry_proof.py).
 */
import { randomBytes } from 'node:crypto';
import type { PluginManifest } from '@landflow/protocol';
import { verifyRegistryProof } from '@landflow/sdk';
import type { PluginClient } from './clients';

/** The manifest, proven when LANDFLOW_REGISTRY_SECRET is set (without it, the plain manifest). Throws on a missing or wrong proof. */
export async function provenManifest(client: PluginClient, secret = process.env.LANDFLOW_REGISTRY_SECRET): Promise<PluginManifest> {
  if (!secret) return client.manifest();
  if (!client.manifestWithProof) throw new Error(`${client.endpoint} cannot be challenged for the registry secret`);
  const challenge = randomBytes(32).toString('base64url');
  const { manifest, proof } = await client.manifestWithProof(challenge);
  if (!proof) throw new Error(`${client.endpoint} did not prove the registry secret: set LANDFLOW_REGISTRY_SECRET on the plugin (an SDK with registry proofs answers by itself)`);
  if (!verifyRegistryProof(secret, manifest.plugin.id, challenge, proof)) throw new Error(`${client.endpoint} sent a wrong registry proof: its LANDFLOW_REGISTRY_SECRET differs from the host's`);
  return manifest;
}
