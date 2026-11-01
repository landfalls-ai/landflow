/**
 * The “what I do” lines of a member card (docs/agent-teams.md#member-cards): the persona's own, cleaned, else the first
 * sentences of its mission and instructions; and never part of the system prompt.
 */
import { describe, expect, it } from 'vitest';
import { cleanPersona, personaPrompt, whatIDoLines } from '@/lib/shared/persona';

describe('whatIDoLines', () => {
  it('uses the persona’s own lines, trimmed, at most three, at most 120 characters', () => {
    const long = `${'word '.repeat(40)}end`;
    const lines = whatIDoLines({ persona: { whatIDo: ['  Reviews pull requests ', '', 'Reviews pull requests', 'Flags risks', long, 'Fourth'] }, instructions: 'Ignored.' });
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(['Reviews pull requests', 'Flags risks']);
    expect(lines[2].length).toBeLessThanOrEqual(120);
    expect(lines[2].endsWith('…')).toBe(true);
  });

  it('derives up to three lines from the mission, then the instructions', () => {
    const lines = whatIDoLines({
      persona: { mission: 'Turns notes into clean Markdown. Keeps the author’s meaning! Checks links?' },
      instructions: '# Steps\n- Fetch the draft\n1. Fix the headings',
    });
    expect(lines).toEqual(['Turns notes into clean Markdown', 'Keeps the author’s meaning!', 'Checks links?']);
    expect(whatIDoLines({ persona: { mission: 'Triage.' }, instructions: '# How\n- Read the ticket\n- Label it' })).toEqual(['Triage', 'How', 'Read the ticket']);
  });

  it('is empty when there is nothing to go on', () => {
    expect(whatIDoLines({})).toEqual([]);
    expect(whatIDoLines({ persona: { whatIDo: [' ', ''] }, instructions: '' })).toEqual([]);
  });

  it('is cleaned with the persona but never reaches the prompt', () => {
    expect(cleanPersona({ role: 'Editor', whatIDo: [' a ', '', 'b', 'c', 'd'] })).toEqual({ role: 'Editor', whatIDo: ['a', 'b', 'c'] });
    expect(cleanPersona({ whatIDo: ['', ' '] })).toBeUndefined();
    const base = { name: 'A', description: 'd', instructions: 'Do it.', skills: [], persona: { role: 'Editor' } };
    const withLines = { ...base, persona: { ...base.persona, whatIDo: ['Edits drafts'] } };
    expect(personaPrompt(withLines as never)).toBe(personaPrompt(base as never));
  });
});
