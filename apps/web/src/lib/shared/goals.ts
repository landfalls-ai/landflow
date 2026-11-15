/**
 * Goals and project briefs (docs/projects-and-goals.md), shared by the server (lib/server/goals, lib/server/projects) and
 * the client. No runtime imports and no zod (the browser loads it). Written by the plan for Paperclip wave 7: PC01 and PC02
 * add this file byte for byte; change it only in a later wave.
 */
export const GOAL_LEVELS = ['company', 'project'] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];
export const GOAL_LEVEL_LABELS: Record<GoalLevel, string> = { company: 'Company', project: 'Project' };

export const GOAL_STATUSES = ['planned', 'active', 'achieved', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = { planned: 'Planned', active: 'Active', achieved: 'Achieved', cancelled: 'Cancelled' };

export const PROJECT_STATUSES = ['planned', 'active', 'paused', 'done'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = { planned: 'Planned', active: 'Active', paused: 'Paused', done: 'Done' };

/** Sizes the API refuses above (characters, counts). `depth`: a root goal is depth 1. */
export const GOAL_LIMITS = { title: 200, why: 2000, depth: 4, goalsPerProject: 10, projectsPerGoal: 50, initiatives: 50, list: 500 } as const;
export const BRIEF_LIMITS = { brief: 1500, constraints: 1000, doneWhen: 600, glossary: 800, companyName: 120, mission: 500 } as const;

export interface Goal {
  /** `goal_<nanoid(10)>` */
  id: string;
  title: string;
  /** Why it matters: the description. */
  why?: string;
  level: GoalLevel;
  status: GoalStatus;
  /** The person who owns it (a user id). */
  ownerId?: string;
  /** YYYY-MM-DD */
  targetDate?: string;
  parentId?: string;
  /** A project goal's home project (its admins edit it); none for a company goal. */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface GoalView extends Goal {
  ownerName?: string;
  /** The projects that serve it (those the viewer can see). */
  projects: Array<{ id: string; name: string }>;
  /** Brain initiatives linked to it (entity id and name). */
  initiatives: Array<{ id: string; name: string }>;
  /** The viewer may edit it (company goals: instance owners and admins; project goals: the project's admins). */
  canEdit: boolean;
}

export interface GoalNode extends GoalView {
  children: GoalNode[];
}

/** GET /api/goals */
export interface GoalsResponse {
  /** Settings → Company. */
  mission?: string;
  goals: GoalNode[];
  /** The viewer may create company goals. */
  canCreateCompanyGoals: boolean;
}

/** GET /api/goals/:id */
export interface GoalDetailResponse {
  goal: GoalView;
  /** Its parents and itself, root first. */
  chain: Array<Pick<Goal, 'id' | 'title' | 'level' | 'status'>>;
}

/** A project's brief: the fields PATCH /api/projects/:id takes under `brief` (null clears one). */
export interface ProjectBrief {
  brief?: string;
  constraints?: string;
  doneWhen?: string;
  /** "Words we use". */
  glossary?: string;
  status?: ProjectStatus;
  /** YYYY-MM-DD */
  targetDate?: string;
  leadId?: string;
  decisionOwnerId?: string;
}

/** The brief as GET /api/projects/:id returns it (`project.brief`). */
export interface ProjectBriefView extends ProjectBrief {
  leadName?: string;
  decisionOwnerName?: string;
  /** The goals it serves, in order: the first planned or active one is its primary goal. */
  goals: Array<Pick<Goal, 'id' | 'title' | 'level' | 'status'>>;
  /** The viewer may edit the brief and its goals (the project's admins). */
  canEdit: boolean;
}

/** Settings → Company (GET /api/settings → `company`). */
export interface CompanyProfile {
  name?: string;
  mission?: string;
}
