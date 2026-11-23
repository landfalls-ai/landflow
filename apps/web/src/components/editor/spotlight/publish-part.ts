/** AG21: where a publish card stands (kept on the reply's `publishOffer` part; ./publish-card.tsx draws it, `lib/shared/agent-versions.ts` words it). */
import type { PinBlock } from '@/lib/shared/agent-versions';
import type { GateVerdict } from '@/lib/shared/agent-eval';

export type PublishCardState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  /** The test run: `passed` (status success), or `waiting` for a person's answer first, or `failed` (status error). */
  | { phase: 'tested'; executionId: string; result: 'passed' | 'waiting' | 'failed'; line?: string; error?: string }
  | { phase: 'publishing'; executionId?: string }
  /** Refused because an agent's draft differs: the agents and their changes. */
  | { phase: 'blocked'; blocks: PinBlock[] }
  | { phase: 'published'; versionNumber?: number; line?: string }
  | { phase: 'failed'; error: string; executionId?: string; held?: GateVerdict }; // AG24: a held eval gate: its verdict, with the score
