/**
 * AI usage of plugin nodes that call a model themselves (docs/observability.md). Such a node reports each call with
 * `ctx.model(...)`, which travels in `ExecuteResponse.records` as a `model` record. The registry wraps every resolved node
 * type with `withAiUsage`, which hands those records to the same usage scope the built-in model nodes use
 * (`beforeModelCall` / `afterModelCall`): the call is priced, stored in `ai_usage` (Insights, the caps per credential and
 * user, the per-run and per-day caps of Workflow settings) and a call that goes over a cap stops the run with the same
 * UsageCapError. A node that declares `meterAiUsage` is also refused up front once a cap is reached.
 *
 * The credential comes from the request: the runner tags the credential objects it resolves (./credential-id.ts).
 */
import type { ExecuteRequest, NodeRecord } from '@landflow/protocol';
import type { ResolvedNodeType } from '@landflow/engine';
import { hostMetrics } from '../telemetry/metrics';
import { credentialIdOf } from './credential-id';
import { afterModelCall, beforeModelCall, isUsageCapError } from './scope';

type ModelRecord = Extract<NodeRecord, { type: 'model' }>;

const credentialOf = (request: ExecuteRequest): string | undefined => {
  for (const data of Object.values(request.credentials ?? {})) {
    const id = credentialIdOf(data);
    if (id) return id;
  }
  return undefined;
};

export function withAiUsage(resolved: ResolvedNodeType): ResolvedNodeType {
  const metered = resolved.descriptor.meterAiUsage === true;
  return {
    ...resolved,
    execute: async (request, extras) => {
      const credentialId = credentialOf(request);
      if (metered) {
        try {
          beforeModelCall({ provider: resolved.pluginId, model: resolved.type, operation: 'chat', ...(credentialId && { credentialId }) });
        } catch (error) {
          if (isUsageCapError(error)) hostMetrics().aiCapsReached.add(1, { 'gen_ai.system': resolved.pluginId, 'gen_ai.request.model': resolved.type, 'landflow.ai.cap.when': 'before' });
          throw error;
        }
      }
      const response = await resolved.execute(request, extras);
      const instruments = hostMetrics();
      let capped: unknown;
      // Every reported call is counted, even when an earlier one went over a cap; the run then stops with that cap's error.
      for (const call of response.records ?? []) {
        if (call.type !== 'model') continue;
        const model = call as ModelRecord;
        const base = { 'gen_ai.system': model.provider, 'gen_ai.request.model': model.model };
        if (model.inputTokens) instruments.aiTokens.add(model.inputTokens, { ...base, 'gen_ai.token.type': 'input' });
        if (model.outputTokens) instruments.aiTokens.add(model.outputTokens, { ...base, 'gen_ai.token.type': 'output' });
        try {
          afterModelCall({
            provider: model.provider,
            model: model.model,
            operation: 'chat',
            inputTokens: model.inputTokens,
            outputTokens: model.outputTokens,
            cacheReadTokens: model.cacheReadTokens,
            cacheWriteTokens: model.cacheWriteTokens,
            ...(credentialId && { credentialId }),
          });
        } catch (error) {
          if (!isUsageCapError(error)) throw error;
          instruments.aiCapsReached.add(1, { ...base, 'landflow.ai.cap.when': 'after' });
          capped ??= error;
        }
      }
      if (capped) throw capped;
      return response;
    },
  };
}
