/**
 * What an agent saw in one run (docs/run-trace.md#what-it-saw): the `saw` attribute the agent's span gets once per run,
 * the sections the Run Trace and the agent's sessions show, and the practices row another package draws inside them.
 * No runtime imports and no zod (the browser loads it). Written by the plan for wave 8: PC08 owns it; PR09 adds this file
 * byte for byte; change it only in a later wave.
 */
import type { ContextMode, RunPractice } from './project-context';

/** The persona summary: role, mission and what-I-do from cleanPersona, never the instructions, each at most 300 characters. */
export interface SawPersona {
  role?: string;
  mission?: string;
  whatIDo?: string;
}

export const SAW_PERSONA_MAX = 300;

/** `attrs.saw` on an agent's span (the step's span, or the request's span for a team member): recorded once per run, never on a resume. */
export interface SawAttrs {
  /** The agent's project context mode for this run (`off`: the project block was not given; practices may still be). */
  mode: ContextMode;
  /** The text the system prompt got: the "Where this work fits" block, then the practices block (wave 8), '' when nothing. */
  text: string;
  projectId?: string;
  projectName?: string;
  goalId?: string;
  goalTitle?: string;
  /** The run's pinned time (ISO). */
  at: string;
  persona: SawPersona;
  /** The approved practices the run was given (handle and version only), [] when none. */
  practices: RunPractice[];
}

/** The line prefixes of the project block (lib/server/project-context/build.ts), in the order they appear. */
export const SAW_LINE_PREFIXES = {
  mission: 'Company mission:',
  goal: 'Goal (',
  subGoal: '└ Goal (',
  compactGoal: 'Goal:',
  why: 'Why:',
  brief: 'Project brief:',
  words: 'Words we use:',
  status: 'Project status:',
  run: 'This run:',
} as const;

/**
 * The block split for display. Everything from the line that equals PRACTICES_HEADING (lib/shared/practices.ts) on is
 * `practices` (its lines as they are); nothing before it is.
 */
export interface SawSections {
  mission?: string;
  /** The goal lines, root first, without their tree marks. */
  goals: string[];
  why?: string;
  brief: string[];
  words?: string;
  status?: string;
  run?: string;
  practices: string[];
}

/**
 * Props of the practices row (PR09, components/run-trace/saw-practices.tsx, export `SawPracticesRow`) that the integrator
 * mounts inside the "What it saw" section (PC08, components/run-trace/what-it-saw.tsx) where PC08 left the marked slot.
 * It draws nothing when `practices` is empty.
 */
export interface SawPracticesRowProps {
  practices: RunPractice[];
  /** The run, when there is one: the row then says, per practice, whether the run cited it and how its checks went. */
  executionId?: string;
}
