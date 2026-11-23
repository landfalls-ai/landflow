/**
 * Memory Extract (docs/second-brain.md#memory-extract, C28): turns text into atomic, self-contained facts with dates resolved
 * against a reference date, one output item per fact, each labelled against what the chosen memory already holds (`new`,
 * `updates <id>`, `duplicate`). With Write to Memory on it writes through the façade: a new fact with `memory.add`, an update
 * with `memory.add({ replaces })` (a new version, the old one kept). It reads and writes only what Memory Add may: a write goes
 * to the flow's own project, and a team's notebook is compared with but never written (notes are a team run's to write).
 * The model is the one on its Chat Model input, through the host's seam (usage metered, caps apply); the text is untrusted, so
 * it reaches the model fenced and a reply can only point at memories the host listed.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { MemoryAddInput, MemoryItem } from '../../shared/memory';
import { MEMORY_EVIDENCE_MAX } from '../../shared/memory';
import { StaticFactError } from '../brain/facts';
import { HttpError } from '../errors';
import { checkTime, type ResolvedTime } from '../memory/dates';
import { extractFacts, labelFacts, type ExtractedFact, type Label } from '../memory/extract';
import { connectedModel, FALLBACK_PORT, FALLBACK_PROPERTY } from './fallback';
import { containerOf, containerProperties, guarded, loadOptions, whoIs } from './memory';

const OPS = ['extract'];
/** C28-D6: the longest text one item may hold, and the most facts kept from it. */
const MAX_TEXT_CHARS = 50_000;
const MAX_FACTS = 200;
/** What a neighbour of a fact can be updated or matched as: a person's memory, or anything a provider holds. */
const COMPARABLE_KINDS = new Set(['memory', 'intended']);
const comparable = (item: MemoryItem) => item.source === 'provider' || item.source === 'note' || COMPARABLE_KINDS.has(item.kind);

/** The reference date of an item: its date, or now; an unreadable one fails the item naming it. */
function referenceOf(value: unknown): Date {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!raw) return new Date();
  // A date with a clock and an offset (2026-11-20T23:30:00-08:00) keeps the calendar day it names, not the UTC day it falls on.
  const day = /^\d{4}-\d{2}-\d{2}(?=$|[T ])/.exec(raw);
  const when = new Date(day ? `${day[0]}T00:00:00Z` : raw);
  if (Number.isNaN(when.getTime())) throw new NodeOperationError(`The reference date “${raw}” is not a date`, { description: 'Use a date such as 2026-11-20, or leave it empty for now.' });
  return when;
}

const validAt = (time: ResolvedTime): string | undefined => (time.iso ? time.iso : time.range ? `${time.range.from}/${time.range.to}` : undefined);

export const memoryExtractNode = defineNode({
  description: {
    name: 'memoryExtract',
    displayName: 'Memory Extract',
    description: 'Turn text into dated, one-claim facts with a chat model, and say which are new, update a known fact or repeat one',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:brain',
    color: '#8b5cf6',
    subtitle: '{{text}}',
    keywords: ['memory', 'extract', 'facts', 'remember', 'notes', 'meeting', 'dates', 'profile'],
    // A model call per part and a write to memory: a person puts it in a flow, a model does not call it (C28-D7).
    usableAsTool: false,
    inputs: [{ type: 'main' }, { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 }, FALLBACK_PORT],
    outputs: [{ type: 'main' }],
    properties: [
      { name: 'operation', displayName: 'Operation', type: 'options', default: 'extract', options: [{ name: 'Extract Facts', value: 'extract', description: 'One item for each fact in the text' }] },
      { name: 'text', displayName: 'Text', type: 'string', default: '{{ $json.text }}', required: true, typeOptions: { rows: 3 }, description: 'The notes, document or conversation. Over 50,000 characters is refused; every 8,000 is one model call', displayOptions: { show: { operation: OPS } } },
      { name: 'referenceDate', displayName: 'Reference Date', type: 'string', default: '{{ $json.date }}', placeholder: '2026-11-20', description: 'When the text was written: “last Monday” and “next quarter” are worked out from it. Empty is now', displayOptions: { show: { operation: OPS } } },
      ...containerProperties(OPS),
      { name: 'documentId', displayName: 'Document ID', type: 'string', default: '', description: 'Kept with each written fact as its source, with this run and node', displayOptions: { show: { operation: OPS } } },
      { name: 'compare', displayName: 'Compare With Memory', type: 'boolean', default: true, description: 'Look up the nearest memories for each fact and label it new, an update, or a duplicate', displayOptions: { show: { operation: OPS } } },
      { name: 'write', displayName: 'Write to Memory', type: 'boolean', default: false, description: 'Remember the new facts, and replace the memories the updates correct (as new versions, the old ones kept). Off only labels', displayOptions: { show: { operation: OPS } } },
      FALLBACK_PROPERTY,
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { operation: OPS } },
        values: [
          { name: 'writeStatic', displayName: 'Write Static Facts', type: 'boolean', default: false, description: 'Off: every fact is written as a normal (dynamic) memory, even one the model calls static, so text it read cannot make a memory only a person may change. On: a fact the model calls static is written as static' },
          { name: 'maxFacts', displayName: 'Max Facts', type: 'number', default: MAX_FACTS, typeOptions: { minValue: 1, maxValue: MAX_FACTS }, description: 'Keep at most this many facts from one item' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const { memory } = await import('../memory');
    const model = await connectedModel(ctx, 'Memory Extract');
    const who = await whoIs(ctx.getWorkflowId(), ctx.getExecutionId());
    const out: NodeItem[] = [];
    for (let i = 0; i < ctx.getInputData().length; i++) {
      const read = (name: string, fallback?: unknown) => ctx.getNodeParameter(name, i, fallback);
      try {
        const text = String(read('text', '') ?? '').trim();
        if (!text) throw new NodeOperationError('Text is empty', { description: 'Set “Text”, for example to {{ $json.text }}.' });
        if (text.length > MAX_TEXT_CHARS) throw new NodeOperationError(`The text is ${text.length} characters; the most is ${MAX_TEXT_CHARS}`, { description: 'Split it first, for example with a Code or Split In Batches step.' });
        const reference = referenceOf(read('referenceDate', ''));
        const write = read('write', false) === true;
        const compare = read('compare', true) !== false;
        const container = containerOf(read, who, write ? 'write' : 'read');
        // A team's notebook is written by a team run only: say so now, before any model is paid for.
        if (write && container.kind === 'team') throw new NodeOperationError('A team’s notebook cannot be written here: notes are written by a team run', { description: 'Turn off Write to Memory to compare with it only, or write to this flow’s project.' });
        const documentId = String(read('documentId', '') ?? '').trim();
        const options = (read('options', {}) ?? {}) as { maxFacts?: number; writeStatic?: boolean };
        const writeStatic = options.writeStatic === true;
        const cap = Math.max(1, Math.min(MAX_FACTS, Math.floor(Number(options.maxFacts ?? MAX_FACTS)) || MAX_FACTS));

        let found: ExtractedFact[] = await extractFacts(model, text, reference, ctx.signal);
        if (found.length > cap) {
          ctx.logger.warn(`item ${i}: ${found.length} facts found; keeping the first ${cap}`);
          found = found.slice(0, cap);
        }

        // The nearest memories of each fact (a team's notebook is compared with, never written), then one labelling pass.
        const neighbours = new Map<number, MemoryItem[]>();
        if (compare && found.length) {
          for (const [index, f] of found.entries()) {
            ctx.signal?.throwIfAborted();
            const near = await guarded(i, () => memory.search(container, f.statement, { mode: 'hybrid', limit: 5 }, who.caller));
            const items = near.items.filter(comparable);
            if (items.length) neighbours.set(index, items);
          }
        }
        const labels: Label[] = await labelFacts(model, found, neighbours, ctx.signal);

        for (const [index, f] of found.entries()) {
          const time = f.time ? checkTime(f.time, reference) : undefined;
          const at = time && validAt(time);
          const label = labels[index];
          const json: JsonObject = {
            statement: f.statement,
            subject: f.subject,
            kind: f.kind,
            ...(at && { validAt: at }),
            ...(f.time?.text && { timeText: f.time.text }),
            ...(time?.unresolved && { unresolved: true }),
            confidence: f.confidence,
            sourceSpan: f.sourceSpan,
            label: label.label,
            ...(label.matchId && { matchId: label.matchId }),
          };
          if (write) {
            if (label.label === 'duplicate') json.written = false;
            else {
              // Where the fact came from (C28-D10): ids and a 200-character span, never the whole text.
              const evidence: NonNullable<MemoryAddInput['evidence']> = [
                { label: 'execution', value: ctx.getExecutionId(), href: `/runs/${ctx.getExecutionId()}` },
                { label: 'node', value: ctx.getNode().name },
                ...(documentId ? [{ label: 'document', value: documentId }] : []),
                ...(at ? [{ label: 'validAt', value: at }] : []),
                ...(f.sourceSpan ? [{ label: 'source', value: f.sourceSpan.slice(0, 200) }] : []),
              ].slice(0, MEMORY_EVIDENCE_MAX);
              // Only a memory Landflow wrote is replaced; a person's is kept as it is, and the fact is written beside it as new.
              const matched = label.matchId ? neighbours.get(index)?.find((n) => n.id === label.matchId) : undefined;
              const replaces = label.label === 'updates' && label.matchId && matched?.origin === 'landflow' ? label.matchId : undefined;
              const input: MemoryAddInput = { text: f.statement, kind: 'memory', confidence: f.confidence, evidence, ...(writeStatic && f.kind === 'static' && label.label === 'new' && { static: true }), ...(replaces && { replaces }) };
              if (label.label === 'updates' && !replaces) Object.assign(json, { replaced: false, writeNote: 'It updates a memory a person wrote: written as a new memory, the person’s kept' });
              try {
                const saved = await memory.add(container, input, who.caller);
                Object.assign(json, { written: true, memoryId: saved.id, ...(replaces && { replaced: true }), ...(saved.version && { version: saved.version }) });
              } catch (error) {
                // A static memory is changed by a person only: say so on this fact, and keep going with the others.
                if (!(error instanceof StaticFactError)) throw error;
                Object.assign(json, { written: false, writeNote: 'The memory it updates is static: only a person changes it' });
              }
            }
          }
          out.push({ json, pairedItem: { item: i } });
        }
      } catch (error) {
        if (error instanceof NodeOperationError && error.itemIndex === undefined) throw new NodeOperationError(error.message, { itemIndex: i, ...(error.description && { description: error.description }) });
        if (error instanceof HttpError) throw new NodeOperationError(error.message, { itemIndex: i });
        throw error;
      }
    }
    return [out];
  },
  methods: { loadOptions },
});
