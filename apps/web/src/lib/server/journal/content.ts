/**
 * How much of an event's content the journal keeps (`traceContent`, docs/run-trace.md): `full` keeps it whole but cuts an
 * event to 32 KB, `summaries` cuts every text to 400 characters, `off` keeps names, statuses and errors only.
 */
import { JOURNAL_EVENT_MAX_BYTES, JOURNAL_SUMMARY_CHARS, type JournalEvent, type TraceContent } from '../../shared/run-trace';

export const CUT = '…[cut]';

/** `LANDFLOW_TRACE_CONTENT` (full, summaries, off); `full` when unset or unknown. */
export function defaultContent(): TraceContent {
  const value = process.env.LANDFLOW_TRACE_CONTENT?.trim().toLowerCase();
  return value === 'summaries' || value === 'off' ? value : 'full';
}

/** A workflow's setting, else the instance's. */
export const contentOf = (setting: TraceContent | undefined): TraceContent => (setting === 'full' || setting === 'summaries' || setting === 'off' ? setting : defaultContent());

const cutText = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}${CUT}` : text);

/** Every string inside `value` cut to `chars` characters. */
function cutStrings(value: unknown, chars: number): unknown {
  if (typeof value === 'string') return cutText(value, chars);
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, chars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, chars)]));
  return value;
}

const bytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event));

/** Where a string sits, to shorten it in place. */
interface Slot {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  length: number;
}

function slots(value: unknown, found: Slot[] = []): Slot[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') found.push({ holder: value, key: index, length: item.length });
      else slots(item, found);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') found.push({ holder: value as Record<string, unknown>, key, length: item.length });
      else slots(item, found);
    }
  }
  return found;
}

/** Shorten the longest strings of an event (marking each with `…[cut]`) until it serializes to at most `max` bytes. */
function fit<T>(event: T, max: number): T {
  let over = bytes(event) - max;
  for (let round = 0; over > 0 && round < 500; round++) {
    const longest = slots(event).sort((a, b) => b.length - a.length)[0];
    if (!longest || longest.length <= CUT.length + 8) break;
    const holder = longest.holder as Record<string | number, string>;
    // Cut by the excess (bytes can be several characters wide, so go on until it fits), never below a few characters.
    const keep = Math.max(8, longest.length - over - CUT.length - 16);
    holder[longest.key] = `${holder[longest.key].slice(0, keep)}${CUT}`;
    over = bytes(event) - max;
  }
  return event;
}

/** The event with the content `mode` keeps, within 32 KB. A copy: the caller's event is untouched. */
export function applyContent(event: JournalEvent, mode: TraceContent): JournalEvent {
  let copy: JournalEvent;
  try {
    copy = JSON.parse(JSON.stringify(event)) as JournalEvent;
  } catch {
    // Not serializable (a cycle): keep what names the event.
    copy = { ...event } as JournalEvent;
  }
  const short = JOURNAL_SUMMARY_CHARS;
  const e = copy as unknown as Record<string, unknown> & { type: JournalEvent['type'] };
  if (mode === 'off') {
    delete e.input;
    delete e.output;
    if (e.type === 'message') e.text = '';
    if (e.type === 'artifact') {
      const artifact = e.artifact as Record<string, unknown>;
      delete artifact.text;
      delete artifact.data;
    }
    if (e.type === 'check') delete (e.check as Record<string, unknown>).evidence;
    // What is left (names, statuses, errors, notes, check messages) is cut short.
    for (const key of ['name', 'error', 'note', 'state']) if (typeof e[key] === 'string') e[key] = cutText(e[key] as string, short);
    if (e.type === 'check') {
      const check = e.check as Record<string, unknown>;
      for (const key of ['message', 'subject']) if (typeof check[key] === 'string') check[key] = cutText(check[key] as string, short);
    }
    if (e.type === 'artifact') {
      const artifact = e.artifact as Record<string, unknown>;
      if (typeof artifact.name === 'string') artifact.name = cutText(artifact.name, short);
    }
    return copy;
  }
  if (mode === 'summaries') {
    for (const key of ['input', 'output']) if (e[key] !== undefined) e[key] = cutStrings(e[key], short);
    if (typeof e.text === 'string') e.text = cutText(e.text, short);
    if (e.type === 'artifact') {
      const artifact = e.artifact as Record<string, unknown>;
      if (typeof artifact.text === 'string') artifact.text = cutText(artifact.text, short);
      if (artifact.data !== undefined) artifact.data = cutStrings(artifact.data, short);
    }
    if (e.type === 'check') {
      const check = e.check as Record<string, unknown>;
      if (check.evidence !== undefined) check.evidence = cutStrings(check.evidence, short);
    }
    for (const key of ['error', 'note']) if (typeof e[key] === 'string') e[key] = cutText(e[key] as string, short);
  }
  fit(copy, JOURNAL_EVENT_MAX_BYTES);
  // Content that is not made of long strings (a huge list of numbers) is replaced whole.
  if (bytes(copy) > JOURNAL_EVENT_MAX_BYTES) for (const key of ['input', 'output']) if (e[key] !== undefined) e[key] = CUT;
  return copy;
}
