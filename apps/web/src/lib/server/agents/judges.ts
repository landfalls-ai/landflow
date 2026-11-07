/**
 * Judges for an agent's guardrails: the services that answer "should this text be flagged?" in place of the agent's
 * chat model. A provider turns a rule's `judge` setting and its credential into a `Judge` (../guardrails); the
 * engine and `applyGuardrail` know nothing about any one service. To add one (a classifier on AWS, a hosted
 * moderation API): register it here, add its credential type, and list it in `JUDGE_PROVIDERS` (shared/agents.ts) so
 * the builder offers it.
 */
import type { AgentJudge } from '../../shared/agents';
import { credentials } from '../credentials/vault';
import type { Judge } from '../guardrails';
import { strandsConnection, systemOneJudge, typesafeConnection } from '../nodes/systemone';

export interface JudgeProvider {
  /** The credential type the provider reads (`core.<name>`). */
  credentialType: string;
  /** The judge, from the rule's setting and the credential's data (secrets resolved). */
  build(judge: AgentJudge, data: Record<string, unknown>, credentialId?: string): Judge;
}

// Both speak the System One API (../nodes/systemone): Jev hosted by TypeSafe, Strands Decider served from your own machine.
const providers = new Map<string, JudgeProvider>([
  ['typesafe', { credentialType: 'core.typesafeApi', build: (_judge, data, id) => systemOneJudge(typesafeConnection(data, id)) }],
  ['strands', { credentialType: 'core.strandsDeciderApi', build: (_judge, data, id) => systemOneJudge(strandsConnection(data, id)) }],
]);

export function registerJudgeProvider(name: string, provider: JudgeProvider): void {
  providers.set(name, provider);
}

/** The judge a rule asks for. Throws (so the guardrail fails closed) when the provider is unknown or has no credential. */
export async function buildJudge(spec: AgentJudge): Promise<Judge> {
  const provider = providers.get(spec.provider);
  if (!provider) throw new Error(`Unknown judge "${spec.provider}"`);
  if (!spec.credential) throw new Error(`Choose a credential for the ${spec.provider} judge`);
  return provider.build(spec, await credentials.dataWithSecrets(spec.credential, provider.credentialType), spec.credential.id);
}
