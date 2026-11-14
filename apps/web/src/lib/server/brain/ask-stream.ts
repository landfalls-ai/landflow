/**
 * The streamed form of Ask (docs/second-brain.md#the-brain-page): the same gathering as `askBrain`, told as events. First
 * what it found (`found`, one step for each thing it read), then the model's words as they come (`text.delta`), then the
 * checked `text` and `done` with its sources, model, time, tokens and cost. Metered like the other chats (surface `brain`).
 */
import { nanoid } from 'nanoid';
import type { AskEvent, AskTurn } from '../../shared/brain-wiki';
import { assistantScope, isUsageCapError, runInUsageScope } from '../ai-usage';
import type { Database } from '../db';
import { database } from '../db';
import { logger } from '../telemetry/logger';
import { entityKey } from './entities';
import { ASK_SYSTEM, askPrompt, finishAnswer, gatherAsk, WikiError, type AskOptions } from './wiki';
import { brainModel } from './writer';
import type { UsageScope } from '../usage/query';
import type { LanguageModel } from '@landflow/engine';

export interface AskStreamInput extends Pick<AskOptions, 'vectorHits' | 'about' | 'signal'> {
  question: string;
  scope: UsageScope | undefined;
  history?: AskTurn[];
  model?: LanguageModel;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** Ask the brain and tell it as events. Never throws: a failure is an `error` event. */
export async function askBrainStream(actor: { id: string; email?: string } | undefined, input: AskStreamInput, emit: (event: AskEvent) => void, db: Database = database()): Promise<void> {
  const scope = assistantScope({ surface: 'brain', ...(actor?.id && { userId: actor.id }) });
  return runInUsageScope(scope, async () => {
    const started = Date.now();
    let step = 0;
    const phases: Partial<Record<'pages' | 'facts' | 'work', number>> = {};
    let g;
    try {
      g = gatherAsk(input.question, input.scope, input, db, (phase, ms) => (phases[phase] = ms));
    } catch (caught) {
      emit({ type: 'error', kind: caught instanceof WikiError ? 'invalid' : 'internal', message: message(caught) });
      return;
    }
    const { pages, facts, work } = g;
    emit({ type: 'found', pages: pages.map((e) => ({ id: entityKey(e), name: e.name })), facts: facts.length, work: work.length });
    const read = (name: 'read_pages' | 'search_facts' | 'read_work', label: string, ms: number | undefined, detail?: string) => {
      step++;
      emit({ type: 'step.start', step, label });
      emit({ type: 'tool', name, label, ok: true, id: `t_${nanoid(8)}`, step, durationMs: ms ?? 0, ...(detail && { detail }) });
    };
    read('read_pages', `Read ${plural(pages.length, 'page', 'pages')}`, phases.pages, pages.slice(0, 8).map((e) => e.name).join(', ') || undefined);
    read('search_facts', `Searched ${plural(facts.length, 'fact', 'facts')}`, phases.facts);
    read('read_work', `Read ${plural(work.length, 'work item', 'work items')}`, phases.work, work.slice(0, 3).map((w) => w.title).filter(Boolean).join('; ') || undefined);

    const model = brainModel(input.model);
    const done = (extra: Partial<Extract<AskEvent, { type: 'done' }>> = {}) =>
      emit({ type: 'done', links: [], sources: work, cited: [], local: model?.provider === 'ollama', durationMs: Date.now() - started, steps: step, inputTokens: 0, outputTokens: 0, ...(model && { model: `${model.provider}/${model.model}` }), ...extra });
    if (!model) {
      done({ note: 'No model is set for the brain (LANDFLOW_BRAIN_MODEL), so here is what it found.' });
      return;
    }
    if (!pages.length && !facts.length && !work.length) {
      emit({ type: 'text', text: 'The brain has nothing about that yet.' });
      done();
      return;
    }
    step++;
    emit({ type: 'step.start', step, label: 'Writing the answer' });
    const writing = step;
    const modelStarted = Date.now();
    try {
      const turn = await model.generate({
        system: ASK_SYSTEM,
        messages: [{ role: 'user', content: askPrompt(g, 'text', db) }],
        tools: [],
        responseFormat: 'text',
        onToken: (delta) => emit({ type: 'text.delta', step: writing, text: delta }),
        ...(input.signal && { signal: input.signal }),
      });
      emit({ type: 'tool', name: 'read_work', label: 'Wrote the answer', ok: true, id: `t_${nanoid(8)}`, step: writing, durationMs: Date.now() - modelStarted });
      const finished = finishAnswer(turn.text ?? '', g);
      if (!finished) {
        emit({ type: 'error', kind: 'model', message: 'The model wrote nothing' });
        return;
      }
      emit({ type: 'text', text: finished.text });
      const metered = scope.tree.calls > 0;
      done({
        links: finished.links,
        cited: finished.cited,
        inputTokens: metered ? scope.tree.inputTokens : (turn.usage?.inputTokens ?? 0),
        outputTokens: metered ? scope.tree.outputTokens : (turn.usage?.outputTokens ?? 0),
        ...(metered && { costUsd: Math.round(scope.tree.cost * 1e8) / 1e8 }),
      });
    } catch (caught) {
      if (input.signal?.aborted) return;
      logger.warn('brain wiki: ask failed', { error: message(caught) });
      emit({ type: 'error', kind: isUsageCapError(caught) ? 'cap' : 'model', message: isUsageCapError(caught) ? message(caught) : `The model failed: ${message(caught)}` });
    }
  });
}
