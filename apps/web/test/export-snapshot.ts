/** Builds the files the byte-identity check compares (shared by the fixture generator and project-export.test.ts). */
import type { AgentConfig } from '@/lib/shared/agents';

/** A fixed agent config (no ids from the store), a team of two Landflow agents. Ids are fixed through the store stub below. */
export const FIXED = {
  alpha: { name: 'Alpha Lead', instructions: 'Lead the work', description: 'Leads, "quoted": text.', color: '#3b82f6', skills: [{ id: 'sk_a', name: 'Shared skill', whenToUse: 'Use it', instructions: '1. do\n2. done', allowedTools: ['Read'], references: [{ name: 'r.md', content: '# R' }] }] },
  beta: { name: 'Beta Dev', instructions: 'Write code', skills: [{ id: 'sk_b', name: 'Shared skill', whenToUse: 'Use it', instructions: '1. do\n2. done' }, { id: 'sk_c', name: 'Own skill', whenToUse: 'Use it too', instructions: 'Be careful' }] },
} as unknown as Record<string, Partial<AgentConfig>>;
