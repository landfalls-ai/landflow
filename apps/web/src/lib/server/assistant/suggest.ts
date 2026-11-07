/**
 * After-run suggestions: once a node has run in the editor, one model call
 * looks at the node, its docs and its data and proposes up to three fixes,
 * parameter tweaks, data-quality notes or next nodes, each with the edit
 * operations that apply it. Nodes with nothing to say (a manual trigger that
 * worked) are skipped without a model call.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { LanguageModel } from '@landflow/engine';
import type { AssistantOp, RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { PARAMETER_FORMATS } from '../flow-builder';
import { parseJsonReply } from '../nodes/structured';
import { recordSuggestions, traceAssistant } from '../telemetry/assistant';
import { assistantModel, modelLabel } from './model';
import { registryLookup, validateOps } from './ops';
import { availableTypes, catalogIndex, nodeContext, workflowOutline } from './research';

export type SuggestionKind = 'fix' | 'param' | 'data' | 'next';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  detail: string;
  confidence: number;
  /** Validated against the workflow; empty for advice with no safe change. */
  ops: AssistantOp[];
  /** Changes the model proposed that could not apply, with reasons. */
  dropped?: string[];
  /** What applying it would leave dangling, e.g. a new node with no input. */
  warnings?: string[];
}

export interface SuggestResult {
  suggestions: Suggestion[];
  model: string;
  durationMs: number;
  /** Why no model was asked, when none was. */
  skipped?: string;
}

const MAX_SUGGESTIONS = 3;

/** Node types that, when they succeed, have nothing worth a model call. */
const TRIVIAL = new Set(['core.manualTrigger', 'core.noOp', 'core.wait', 'core.stopAndError']);

const SYSTEM = `You review one node of a Landflow workflow (an n8n-like automation tool) right after it ran in the editor, and suggest at most ${MAX_SUGGESTIONS} concrete improvements. Reply with JSON only:
{"suggestions":[{"kind":"fix|param|data|next","title":"…","detail":"…","confidence":0.8,"ops":[…]}]}

Kinds:
- fix: the node failed. Explain the cause from the error and the input, and fix it (usually setParameters).
- param: the node worked, but a parameter looks wrong for this data or could be better.
- data: the input or output has a problem (empty or missing fields, wrong types, duplicates, an object compared as a whole, no items). Name the field.
- next: a node from the catalog that would naturally process this output next.

ops are the changes the user applies with one click. Refer to existing nodes by their name:
- {"op":"setParameters","node":"<name>","parameters":{…}} merges into the node's parameters
- {"op":"addNode","ref":"new1","type":"<type id from the catalog>","name":"Short name","parameters":{…},"after":"<name>","output":0} adds a node wired after another
- {"op":"addNode",…,"before":"<name>"} inserts a node in front of another (whatever fed it feeds the new node), e.g. to prepare its input
- {"op":"connect","from":"<name or ref>","to":"<name or ref>","output":0,"type":"main"}
- {"op":"disconnect","from":"<name>","to":"<name>"}, {"op":"removeNode","node":"<name>"}, {"op":"renameNode","node":"<name>","name":"<new name>"}

Rules:
- Ground every suggestion in the run data shown. Never invent fields that are not in the samples.
- If the node failed, the first suggestion is a fix whose ops make it work on the input shown (for example, read a field the items actually have).
- Only parameter names from the node docs. Expressions read the current item with "{{ $json.field }}" and other nodes with "{{ $('Node name').item.json.field }}".
- title: imperative, under 60 characters. detail: one or two sentences naming the concrete field or value.
- confidence: 0 to 1, how sure you are it helps.
- Advice without a safe change gets "ops": [].
- If the node looks right, reply {"suggestions":[]}. Fewer, better suggestions beat filler.

${PARAMETER_FORMATS}`;

const SuggestionSchema = z.object({
  kind: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase().trim() : v), z.enum(['fix', 'param', 'data', 'next']).catch('param')),
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(1200).catch(''),
  confidence: z.coerce.number().catch(0.5),
  ops: z.array(z.unknown()).catch([]),
});
const ReplySchema = z.object({ suggestions: z.array(z.unknown()).catch([]) });

export interface SuggestInput {
  workflow: Workflow;
  nodeId: string;
  run: RunDigest;
  /** A model name (see assistantModel) or a LanguageModel (tests). */
  model?: string | LanguageModel;
  types?: NodeTypeInfo[];
  signal?: AbortSignal;
}

/** Turn the model's reply into validated suggestions; ops that don't apply make a suggestion advice-only. */
export function readSuggestions(reply: string, workflow: Workflow, types: NodeTypeInfo[]): Suggestion[] {
  const parsed = ReplySchema.safeParse(parseJsonReply(reply));
  if (!parsed.success) throw new Error('The model reply has no suggestions list');
  const lookup = registryLookup(types);
  const suggestions: Suggestion[] = [];
  for (const raw of parsed.data.suggestions) {
    const entry = SuggestionSchema.safeParse(raw);
    if (!entry.success) continue;
    const { kind, title, detail, confidence, ops: rawOps } = entry.data;
    const validated = validateOps(workflow, rawOps, lookup);
    // A half-applicable change could leave the flow broken: all of it or none of it.
    const complete = validated.ops.length > 0 && !validated.dropped.length;
    const notes = [...validated.dropped, ...validated.ignored];
    suggestions.push({
      id: `sg_${nanoid(8)}`,
      kind,
      title: title.slice(0, 120),
      detail,
      confidence: Math.min(1, Math.max(0, confidence > 1 ? confidence / 100 : confidence)),
      ops: complete ? validated.ops : [],
      ...(notes.length && { dropped: notes }),
      ...(complete && (validated.warnings.length || validated.cautions.length) && { warnings: [...validated.warnings, ...validated.cautions] }),
    });
  }
  // A failed node's fix first, then by confidence; the same change twice (a fix restated as a tweak) once.
  const seen = new Set<string>();
  return suggestions
    .sort((a, b) => Number(b.kind === 'fix') - Number(a.kind === 'fix') || b.confidence - a.confidence)
    // Advice is worth showing for failures and data problems; a tweak or next step without a change is filler.
    .filter((s) => s.ops.length > 0 || s.kind === 'fix' || s.kind === 'data')
    .filter((s) => {
      const key = JSON.stringify(s.ops);
      if (!s.ops.length || !seen.has(key)) return seen.add(key);
      return false;
    })
    .slice(0, MAX_SUGGESTIONS);
}

export async function suggestAfterRun(input: SuggestInput): Promise<SuggestResult> {
  const { workflow, nodeId, run } = input;
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`No node ${nodeId} in the workflow`);
  const types = input.types ?? availableTypes();
  const model = assistantModel(input.model);
  const started = Date.now();
  const attributes = { 'landflow.node.type': node.type, 'landflow.workflow.id': workflow.id, 'gen_ai.request.model': model.model };

  return traceAssistant('suggest', attributes, async (span, setOutcome) => {
    if (TRIVIAL.has(node.type) && run.status === 'success') {
      setOutcome('skipped');
      return { suggestions: [], model: modelLabel(model), durationMs: Date.now() - started, skipped: `${node.type} has nothing to tune` };
    }
    const prompt = [
      workflowOutline(workflow),
      `\nNode under review:\n${nodeContext(workflow, nodeId, run, types)}`,
      `\nNode catalog (type ids for "next" suggestions):\n${catalogIndex(types)}`,
    ].join('\n');
    const turn = await model.generate({
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      responseFormat: 'json',
      ...(input.signal && { signal: input.signal }),
    });
    const suggestions = readSuggestions(turn.text, workflow, types);
    span.setAttribute('landflow.assistant.suggestions', suggestions.length);
    recordSuggestions(suggestions.map((s) => s.kind));
    return { suggestions, model: modelLabel(model), durationMs: Date.now() - started };
  });
}
