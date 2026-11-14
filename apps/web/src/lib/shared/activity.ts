/**
 * The activity trace's data (docs/assistant.md#chat-surfaces): what an AI did while it answered, one step at a time.
 * Pure, so the same words come out on every surface and in tests.
 */
export type ActivityKind = 'read' | 'search' | 'tool' | 'think' | 'model' | 'write' | 'run';

export interface ActivityStep {
  id: string;
  label: string;
  kind: ActivityKind;
  status: 'running' | 'ok' | 'failed';
  durationMs?: number;
  /** A line or two of what happened, 300 characters at most. */
  detail?: string;
}

/** "0.4 s", "14.5 s", "2 min 5 s". */
export function formatSeconds(ms: number): string {
  const t = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (t < 59_950) return `${(Math.round(t / 100) / 10).toFixed(1)} s`;
  const total = Math.round(t / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec ? `${min} min ${sec} s` : `${min} min`;
}

/** "10 steps · 14.5 s", "1 step · 0.8 s"; the time is left out when unknown. */
export function summarizeSteps(steps: ActivityStep[], durationMs?: number): string {
  const n = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  return durationMs === undefined ? n : `${n} · ${formatSeconds(durationMs)}`;
}
