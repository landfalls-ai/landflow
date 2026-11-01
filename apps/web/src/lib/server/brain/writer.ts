/**
 * The model's part (docs/second-brain.md#principles, "rules find, the model explains"): findings that need judgment get it
 * here, one model call each, on the brain's model (LANDFLOW_BRAIN_MODEL, default the builder model; `off` skips this
 * step). Without a model, or when a call fails, the finding keeps its deterministic text and stays advice.
 *
 * - `fix`: the after-run assistant's fix for the failing node (lib/server/assistant/suggest.ts), from the latest failing
 *   run: its error and item counts, plus clipped items only when the project lets the brain read run contents.
 * - `slow`: two or three concrete tips for the slow node, added to the reason.
 * - `persona`: Always and Never rules from what people said, as the agent change.
 * - `draft`: a draft workflow from the requests, by the flow builder ("Describe a workflow").
 */
import type { LanguageModel, Workflow } from '@landflow/engine';
import type { PortDigest, RunDigest } from '../../shared/assistant-ops';
import { clip } from '../../shared/assistant-ops';
import { agentStore } from '../agents/store';
import { assistantModel, DEFAULT_ASSISTANT_MODEL, modelLabel } from '../assistant/model';
import { nodeDocs, availableTypes } from '../assistant/research';
import { suggestAfterRun } from '../assistant/suggest';
import { buildFlow, type FlowDraft } from '../flow-builder';
import { getProjectSettings } from '../governance/scopes';
import { homeProjectId } from '../projects/store';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import type { Enrichment, Finding } from './detectors';

/** LANDFLOW_BRAIN_MODEL: `off`, a model name (`provider/model` or an Ollama model), or the builder model. */
export function brainModelName(): string | undefined {
  const name = process.env.LANDFLOW_BRAIN_MODEL?.trim();
  if (name?.toLowerCase() === 'off') return undefined;
  return name || DEFAULT_ASSISTANT_MODEL;
}

export function brainModel(override?: LanguageModel): LanguageModel | undefined {
  if (override) return override;
  const name = brainModelName();
  return name ? assistantModel(name) : undefined;
}

function jsonOf(text: string): Record<string, unknown> | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return match ? (JSON.parse(match[0]) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown, max = 3) =>
  (Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 3)
    .map((v) => v.trim().slice(0, 200))
    .slice(0, max);

async function ask(model: LanguageModel, prompt: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const turn = await model.generate({ system: 'You help improve automation workflows. Reply with JSON only.', messages: [{ role: 'user', content: prompt }], tools: [], responseFormat: 'json', ...(signal && { signal }) });
  return jsonOf(turn.text ?? '');
}

/** The latest failing run of a node, as the assistant reads runs: counts always, items only with the project's opt-in. */
function failingRun(workflow: Workflow, nodeId: string, executionId: string | undefined, message: string): RunDigest {
  const record = executionId ? store.getExecution(executionId) : undefined;
  const run = record?.runData[nodeId]?.findLast((r) => r.error) ?? record?.runData[nodeId]?.at(-1);
  const payloads = getProjectSettings(homeProjectId('workflow', workflow.id)).brainPayloads === true;
  const port = (items: unknown[] | undefined): PortDigest => ({ count: items?.length ?? 0, sample: payloads ? (items ?? []).slice(0, 3).map((i) => clip((i as { json?: unknown }).json)) : [] });
  return {
    status: 'error',
    durationMs: run?.durationMs ?? 0,
    error: run?.error ?? { message },
    inputs: (run?.inputs ?? [[]]).map((items) => port(items)),
    outputs: (run?.outputs ?? []).map((items) => port(items)),
  };
}

/** A flow builder draft as a workflow to create (`id` is replaced when it is applied). */
export function draftWorkflow(draft: FlowDraft): Workflow {
  const ids = new Map(draft.nodes.map((n, i) => [n.key, `n${i + 1}`]));
  return {
    id: 'draft',
    name: draft.name,
    active: false,
    nodes: draft.nodes.map((n) => ({ id: ids.get(n.key)!, name: n.name, type: n.type, typeVersion: 1, position: [n.x, n.y], parameters: n.parameters ?? {} })),
    connections: draft.edges
      .filter(([from, to]) => ids.has(from) && ids.has(to))
      .map(([from, to, index, type], i) => ({ id: `c${i + 1}`, type, source: ids.get(from)!, sourceIndex: index ?? 0, target: ids.get(to)!, targetIndex: 0 })),
  };
}

async function enrichOne(finding: Finding, enrich: Enrichment, model: LanguageModel, signal?: AbortSignal): Promise<Finding> {
  const p = finding.proposal;
  switch (enrich.kind) {
    case 'fix': {
      const workflow = store.getWorkflow(enrich.workflowId);
      if (!workflow) return finding;
      const result = await suggestAfterRun({ workflow, nodeId: enrich.nodeId, run: failingRun(workflow, enrich.nodeId, enrich.executionId, enrich.message), model, signal });
      const fix = result.suggestions.find((s) => s.ops.length) ?? result.suggestions[0];
      if (!fix) return finding;
      return {
        ...finding,
        proposal: {
          ...p,
          why: `${p.why} Suggested fix: ${fix.title}. ${fix.detail}`.slice(0, 2_000),
          ops: fix.ops,
          ...(fix.warnings?.length && { warnings: fix.warnings }),
          model: result.model,
          confidence: Math.min(p.confidence, Math.max(0.3, fix.confidence)),
        },
      };
    }
    case 'slow': {
      const workflow = store.getWorkflow(enrich.workflowId);
      const node = workflow?.nodes.find((n) => n.id === enrich.nodeId);
      const info = node && availableTypes().find((t) => t.type === node.type);
      if (!node || !info) return finding;
      const reply = await ask(model, `This workflow node is slow (${p.why}).\nNode “${node.name}”, type ${node.type}.\n${nodeDocs(info, node.parameters)}\n\nGive 2 or 3 short, concrete ways to make it faster, using this node's own options where it has them. JSON: {"tips": ["…"]}`, signal);
      const tips = strings(reply?.tips);
      return tips.length ? { ...finding, proposal: { ...p, why: `${p.why} Ideas: ${tips.join(' ')}`.slice(0, 2_000), model: modelLabel(model) } } : finding;
    }
    case 'persona': {
      const agent = agentStore.get(enrich.agentId);
      if (!agent) return finding;
      const reply = await ask(
        model,
        `People rated answers of the agent “${agent.name}” (${agent.persona?.role ?? agent.description ?? 'an assistant'}) as bad, and said:\n${enrich.comments.map((c) => `- ${c}`).join('\n')}\n\nIts current rules: always ${JSON.stringify(agent.persona?.always ?? [])}, never ${JSON.stringify(agent.persona?.never ?? [])}.\nWrite at most two new short rules that would prevent these complaints. JSON: {"always": ["…"], "never": ["…"]}`,
        signal,
      );
      const always = strings(reply?.always, 2);
      const never = strings(reply?.never, 2);
      if (!always.length && !never.length) return finding;
      const rules = [...always.map((r) => `always “${r}”`), ...never.map((r) => `never “${r}”`)].join(', ');
      return { ...finding, proposal: { ...p, why: `${p.why} Suggested rules: ${rules}.`.slice(0, 2_000), agentChange: { ...(always.length && { always }), ...(never.length && { never }) }, model: modelLabel(model) } };
    }
    case 'tool': {
      const reply = await ask(
        model,
        `Agents on a Landflow instance needed to ${enrich.capabilities.map((c) => `“${c}”`).join(', ')} with ${enrich.system}, and no node plugin does it. Sketch the node plugin to build: one to three action nodes an agent can call, each with what it does, its main parameters and the credential it needs. JSON: {"nodes": [{"name": "Get alerts", "does": "…", "parameters": ["…"], "credential": "…"}]}`,
        signal,
      );
      const nodes = Array.isArray(reply?.nodes) ? (reply.nodes as Array<Record<string, unknown>>).slice(0, 3) : [];
      const sketch = nodes
        .map((n) => {
          const parameters = strings(n.parameters, 6);
          return typeof n.name === 'string' && typeof n.does === 'string'
            ? `${n.name}: ${n.does}${parameters.length ? ` (parameters: ${parameters.join(', ')})` : ''}${typeof n.credential === 'string' && n.credential ? `, with a ${n.credential} credential` : ''}.`
            : '';
        })
        .filter(Boolean);
      return sketch.length ? { ...finding, proposal: { ...p, why: `${p.why} A plugin for ${enrich.system} could have: ${sketch.join(' ')}`.slice(0, 2_000), model: modelLabel(model) } } : finding;
    }
    case 'draft': {
      const name = brainModelName();
      if (!name || name.includes('/')) return finding;
      const draft = await buildFlow(enrich.prompt, name);
      if (!draft.nodes.length) return finding;
      return { ...finding, proposal: { ...p, draft: draftWorkflow(draft), why: `${p.why} Applying creates a draft workflow “${draft.name}” to start from.`.slice(0, 2_000), model: draft.model } };
    }
  }
}

/** Enrich the findings that ask for it. Each call is on its own: one failing leaves the others. */
export async function enrichFindings(findings: Finding[], options: { model?: LanguageModel; signal?: AbortSignal } = {}): Promise<Finding[]> {
  const model = brainModel(options.model);
  if (!model) return findings;
  const out: Finding[] = [];
  for (const finding of findings) {
    if (!finding.enrich || options.signal?.aborted) {
      out.push(finding);
      continue;
    }
    try {
      out.push(await enrichOne(finding, finding.enrich, model, options.signal));
    } catch (error) {
      logger.warn('the brain could not enrich a finding', { error, 'landflow.brain.detector': finding.proposal.detector });
      out.push(finding);
    }
  }
  return out;
}
