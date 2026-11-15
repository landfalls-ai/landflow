/**
 * Project context in the mod (docs/landflow-brain-mod.md#project-context): pure rules for the "Where this work fits"
 * session section, the `/brain project` reply and cleaning what the server answers. The mod never imports Landflow; the
 * shape it reads (`GET /api/projects/context`) is declared here and every field is checked.
 */
import { sectionText } from './practices'

/** The most characters of the session section (the server's compact block is far smaller; this cuts again if a server sends more). */
export const PROJECT_BUDGET_MOD = 1500
export const SECTION_PROJECT = 'landflow-brain:project'
/** At most this many other project names are listed. */
const ALSO_MAX = 5

/** What `GET /api/projects/context` answers, the parts the mod reads. */
export interface ProjectContextAnswer {
  projects?: unknown
  context?: unknown
}

export interface ProjectContext {
  /** Every project that lists the repository, the first one's block first. */
  projects: Array<{ id: string; name: string }>
  /** The first project's block, cleaned; '' when the project has none. */
  text: string
}

const line = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** The query string of the read: the repository and the compact size. */
export function projectQuery(repo: string): string {
  const params = new URLSearchParams()
  params.set('repo', repo)
  params.set('size', 'compact')
  return params.toString()
}

/** The answer as data: unknown fields ignored, a bad answer or no project gives undefined. Never throws. */
export function parseProjectContext(raw: unknown, budget = PROJECT_BUDGET_MOD): ProjectContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const answer = raw as ProjectContextAnswer
  if (!Array.isArray(answer.projects)) return undefined
  const projects = answer.projects
    .map(item => {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      return { id: line(p.id, 100), name: line(p.name, 80) }
    })
    .filter(p => p.id && p.name)
    .slice(0, 20)
  if (!projects.length) return undefined
  const context = answer.context && typeof answer.context === 'object' ? (answer.context as Record<string, unknown>) : undefined
  const text = sectionText({ text: context?.text }, budget) ?? ''
  return { projects, text }
}

/** The names after the first project, as one line; nothing when it is the only one. */
export function alsoListed(found: ProjectContext): string | undefined {
  const names = found.projects.slice(1, 1 + ALSO_MAX).map(p => p.name)
  if (!names.length) return undefined
  const more = found.projects.length - 1 - names.length
  return `Also listed in: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** The session section: the block the server wrote (it carries its own footer), then the other project names. Nothing when there is no block. */
export function projectSection(found: ProjectContext | undefined): string | undefined {
  if (!found || !found.text) return undefined
  const also = alsoListed(found)
  return also ? `${found.text}\n${also}` : found.text
}

/** `/brain project`: which project this repository maps to, or why none. */
export function projectReply(repo: string | undefined, found: ProjectContext | undefined): string {
  if (!repo) return 'This repository is not listed in the Repositories option of landflow-brain, so no project is looked up for it.'
  if (!found) return `No project lists ${repo}.`
  const first = found.projects[0]
  const lines = [`${repo} is listed by the project “${first.name}”.`]
  lines.push(found.text || 'That project has no mission, goal or brief yet.')
  const also = alsoListed(found)
  if (also) lines.push(also)
  return lines.join('\n')
}
