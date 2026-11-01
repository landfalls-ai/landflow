/**
 * An agent's persona: the system prompt its persona parts, instructions, skills, name and description make. The runtime adds
 * the memory notes and the time of each run (../server/agents/runtime.ts); kagent gets the rest as its AgentTemplate's
 * systemPrompt (../server/kagent/manifests.ts), so an agent deployed there runs the same persona it runs here; the Persona tab
 * shows it while it's edited. No runtime imports: the client uses it too.
 */
import type { AgentConfig, AgentPersona, AnswerLength } from './agents';

export const PERSONA_TONES = ['Precise', 'Brief', 'Friendly', 'Formal', 'Warm', 'Direct', 'Patient', 'Calm', 'Thorough', 'Neutral', 'Empathetic', 'Playful'];

export const ANSWER_LENGTHS: Array<{ value: AnswerLength; label: string; prompt: string }> = [
  { value: 'sentence', label: 'One sentence', prompt: 'Answer in one sentence when you can.' },
  { value: 'paragraph', label: 'A short paragraph', prompt: 'Keep answers to a short paragraph.' },
  { value: 'detailed', label: 'As detailed as needed', prompt: 'Answer in as much detail as the question needs.' },
];

const text = (s?: string) => s?.trim() || undefined;
const list = (items?: string[]) => {
  const kept = [...new Set((items ?? []).map((s) => s.trim()).filter(Boolean))];
  return kept.length ? kept : undefined;
};

export const WHAT_I_DO_MAX = 3;
export const WHAT_I_DO_LENGTH = 120;

const clip = (s: string) => (s.length <= WHAT_I_DO_LENGTH ? s : `${s.slice(0, WHAT_I_DO_LENGTH - 1).replace(/\s+\S*$/, '')}…`);
/** Short lines for a card: strings, trimmed, no blanks or repeats, at most three of at most 120 characters. */
const lines = (items?: unknown) => {
  const kept = [...new Set((Array.isArray(items) ? items : []).filter((s): s is string => typeof s === 'string').map((s) => clip(s.trim())).filter(Boolean))].slice(0, WHAT_I_DO_MAX);
  return kept.length ? kept : undefined;
};

/**
 * The “what I do” lines of a member card: the persona's own, else up to three taken from the start of its mission, then its
 * instructions (first sentences, list marks dropped, trimmed). Only for display: personaPrompt() never reads them.
 */
export function whatIDoLines(agent: { persona?: AgentPersona; instructions?: string }): string[] {
  const own = lines(agent.persona?.whatIDo);
  if (own) return own;
  // A lead-in ("For every request:") says nothing on its own, and a tool's name in brackets ("(ask_writer)") is for the model.
  const sentences = (source?: string) =>
    (source ?? '')
      .split(/\n+|(?<=[.!?])\s+/)
      .filter((s) => !/:\s*$/.test(s))
      .map((s) => s.replace(/^\s*(?:#+|[-*•]|\d+[.)])\s*/, '').replace(/\s*\([a-z0-9_]+\)/g, '').replace(/[.:;,\s]+$/, '').trim())
      .filter((s) => s.length > 2);
  return lines([...sentences(agent.persona?.mission), ...sentences(agent.instructions)]) ?? [];
}

/** The persona without blank parts (an example stays while either side is written), or undefined when nothing is filled in. */
export function cleanPersona(persona?: AgentPersona): AgentPersona | undefined {
  if (!persona) return undefined;
  const examples = (persona.examples ?? []).map((e) => ({ user: e.user.trim(), assistant: e.assistant.trim() })).filter((e) => e.user || e.assistant);
  const clean: AgentPersona = {
    role: text(persona.role),
    audience: text(persona.audience),
    mission: text(persona.mission),
    tones: list(persona.tones),
    length: ANSWER_LENGTHS.some((l) => l.value === persona.length) ? persona.length : undefined,
    language: text(persona.language),
    signoff: text(persona.signoff),
    whatIDo: lines(persona.whatIDo),
    always: list(persona.always),
    never: list(persona.never),
    examples: examples.length ? examples : undefined,
  };
  const kept = Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined)) as AgentPersona;
  return Object.keys(kept).length ? kept : undefined;
}

/** The agent says something about itself, a persona or instructions: what publishing and the test chat need. */
export const hasPrompt = (config: Pick<AgentConfig, 'persona' | 'instructions'>) => Boolean(config.instructions.trim() || cleanPersona(config.persona));

const sentence = (s: string) => (/[.!?…:]$/.test(s) ? s : `${s}.`);

function personaSections(persona: AgentPersona): string[] {
  const sections: string[] = [];
  const who = [
    persona.role && `Role: ${sentence(persona.role)}`,
    persona.audience && `Who you help: ${sentence(persona.audience)}`,
    persona.mission && `What you do: ${sentence(persona.mission)}`,
  ].filter(Boolean);
  if (who.length) sections.push(['## Who you are', ...who].join('\n'));
  const voice = [
    persona.tones && `Tone: ${persona.tones.join(', ')}.`,
    persona.length && ANSWER_LENGTHS.find((l) => l.value === persona.length)?.prompt,
    persona.language && `Answer in ${sentence(persona.language)}`,
    persona.signoff && `End every answer with this line: ${persona.signoff}`,
  ].filter(Boolean);
  if (voice.length) sections.push(['## How you talk', ...voice].join('\n'));
  const rules = [
    ...(persona.always ? ['Always:', ...persona.always.map((r) => `- ${r}`)] : []),
    ...(persona.never ? ['Never:', ...persona.never.map((r) => `- ${r}`)] : []),
  ];
  if (rules.length) sections.push(['## Rules', ...rules].join('\n'));
  const examples = (persona.examples ?? []).filter((e) => e.user && e.assistant);
  if (examples.length)
    sections.push([examples.length === 1 ? '## Example' : '## Examples', ...examples.map((e) => `User: ${e.user}\nYou: ${e.assistant}`)].join('\n\n'));
  return sections;
}

export function personaPrompt(config: AgentConfig, run: { memory?: string; now?: Date } = {}): string {
  const persona = cleanPersona(config.persona);
  const instructions = config.instructions.trim();
  // Without persona parts the prompt opens with the instructions as it always did, so agents written before stay the same.
  const parts = persona
    ? [...personaSections(persona), ...(instructions ? [`## Instructions\n${instructions}`] : [])]
    : [instructions || 'You are a helpful assistant.'];
  if (config.skills.length) {
    parts.push(
      [
        '## Skills',
        'Skills are step-by-step instructions for specific tasks. When a task matches a skill, call load_skill first and follow it.',
        ...config.skills.map((s) => `- ${s.name}: ${s.whenToUse}`),
      ].join('\n'),
    );
  }
  if (run.memory) parts.push(run.memory);
  const intro = `You are “${config.name}”${config.description ? `: ${config.description.trim()}` : ''}`;
  // A description that already ends a sentence doesn't get a second full stop.
  parts.push(`${/[.!?]$/.test(intro) ? intro : `${intro}.`}${run.now ? ` Current date and time: ${run.now.toISOString()}.` : ''}`);
  return parts.join('\n\n');
}
