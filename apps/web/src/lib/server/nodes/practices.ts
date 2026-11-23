/**
 * Draft Practice (`core.practiceDraft`, docs/practices.md): save a practice as a draft for a person to approve on /brain →
 * Practices. It only drafts: nothing a flow, an agent or a model writes is approved here. A draft that cites a repository
 * is `learned` (tainted); a citation is marked verified only when this flow's own `files` (what a GitHub step of the run
 * read at the cited commit) hold the excerpt, and only in a flow an owner or admin saved (`instanceFlowRefusal`), never
 * in a tool call (an agent's text is not a source). The store is reached through the practices port.
 */
import { defineNode, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { HttpError } from '../errors';
import { PRACTICE_LEVELS, PRACTICE_LEVEL_LABELS, PRACTICE_STRENGTHS, PRACTICE_STRENGTH_LABELS, type PracticeCheck, type PracticeCitation, type PracticeDraftInput, type PracticeLevel, type PracticeStrength } from '../../shared/practices';
import { practicesPort, type PracticeDraftOrigin } from '../practices/port';
import { instanceFlowRefusal } from './briefing';

const main = [{ type: 'main' as const }];

const TOOL_DESCRIPTION =
  'Save a practice (a rule your company follows, with where it was read) as a DRAFT. It only drafts: a person approves it on /brain → Practices before anyone follows it. Arguments: `handle` (area/name, such as helm/chart-location), `title`, `level` (org or project), `projectId` (for project), `strength` (required or recommended), `topics`, `repositories`, `paths` (globs), `summary` (300 characters at most), `body` (Markdown rules), `checks`, `citations` ({ repo, sha, path, lines, excerpt }), and `practiceId` to propose a new version of one. Citations are never verified from a tool call.';

/** A parameter that is JSON text or already a value (an expression's result). Undefined when empty. */
function jsonOf(value: unknown, what: string): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

const listOf = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return items.map((v) => String(v).trim()).filter(Boolean);
};

const arrayOf = <T>(value: unknown, what: string): T[] => {
  const parsed = jsonOf(value, what);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error(`${what} must be a list`);
  return parsed as T[];
};

type FileText = { repo: string; sha: string; path: string; content: string };

function filesOf(value: unknown): FileText[] {
  return arrayOf<Record<string, unknown>>(value, 'Files')
    .filter((f) => f && typeof f === 'object' && typeof f.repo === 'string' && typeof f.sha === 'string' && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ repo: String(f.repo), sha: String(f.sha), path: String(f.path), content: String(f.content) }));
}

const one = (item: NodeItem, i: number, fields: JsonObject): NodeItem => ({ json: fields, pairedItem: { item: i } });

/** Whether this flow may verify citations, and why not when it may not. */
async function verificationOf(ctx: IExecuteContext): Promise<string | undefined> {
  if (ctx.getMode() === 'tool') return 'A tool call never verifies a citation: an agent’s text is not a source';
  return instanceFlowRefusal(ctx);
}

export const practiceDraftNode = defineNode({
  description: {
    name: 'practiceDraft',
    displayName: 'Draft Practice',
    description: 'Save a practice as a draft for a person to approve on Brain → Practices. It never approves.',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:file-check',
    color: '#0ea5e9',
    subtitle: '{{handle}}',
    keywords: ['practice', 'rule', 'standard', 'convention', 'learn', 'draft', 'policy', 'brain'],
    usableAsTool: true,
    toolDescription: TOOL_DESCRIPTION,
    inputs: main,
    outputs: main,
    properties: [
      { name: 'handle', displayName: 'Handle', type: 'string', default: '', required: true, placeholder: 'helm/chart-location', description: 'Two or three lowercase parts, area/name' },
      { name: 'title', displayName: 'Title', type: 'string', default: '', required: true },
      {
        name: 'level',
        displayName: 'Level',
        type: 'options',
        default: 'org',
        noDataExpression: true,
        options: PRACTICE_LEVELS.map((value) => ({ name: PRACTICE_LEVEL_LABELS[value], value })),
      },
      { name: 'projectId', displayName: 'Project', type: 'string', default: '', description: 'The project’s id. Only a flow in that project may draft there.', displayOptions: { show: { level: ['project'] } } },
      {
        name: 'strength',
        displayName: 'Strength',
        type: 'options',
        default: 'recommended',
        options: PRACTICE_STRENGTHS.map((value) => ({ name: PRACTICE_STRENGTH_LABELS[value], value })),
      },
      { name: 'topics', displayName: 'Topics', type: 'string', default: '', placeholder: 'helm, devops', description: 'Comma-separated' },
      { name: 'repositories', displayName: 'Repositories', type: 'string', default: '', placeholder: 'your-org/your-repo', description: 'Comma-separated owner/name. Empty: every repository.' },
      { name: 'paths', displayName: 'Paths', type: 'string', default: '', placeholder: 'deploy/**', description: 'Comma-separated globs the rule covers. Empty: every path.' },
      { name: 'summary', displayName: 'Summary', type: 'string', default: '', required: true, description: 'One line, 300 characters at most: what agents get' },
      { name: 'body', displayName: 'Body', type: 'string', default: '', typeOptions: { rows: 6 }, description: 'The rules in Markdown, 4,000 characters at most' },
      { name: 'checks', displayName: 'Checks (JSON)', type: 'json', default: '[]', description: 'A list of machine checks: { kind: pathExists | pathAbsent | fileMatches, glob, … }' },
      { name: 'citations', displayName: 'Citations (JSON)', type: 'json', default: '[]', description: 'A list of { repo, sha, path, lines: [from, to], excerpt }. Marked verified only when Files holds the excerpt, in a flow an owner or admin saved.' },
      { name: 'files', displayName: 'Files', type: 'json', default: '', description: 'The { repo, sha, path, content } a GitHub step of this run read, as an expression. Empty: no citation is verified.' },
      { name: 'practiceId', displayName: 'Practice ID', type: 'string', default: '', description: 'Propose a new version of this practice (its handle, level and project stay)' },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const port = practicesPort();
    const refusal = await verificationOf(ctx);
    const workflowId = ctx.getWorkflowId();
    const executionId = ctx.getExecutionId();
    const agentId = workflowId?.startsWith('agent:') ? workflowId.slice('agent:'.length) : undefined;
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const input = items[i] ?? { json: {} };
      try {
        if (!port) throw new Error('Practices are not loaded');
        const param = (name: string, fallback: unknown = '') => ctx.getNodeParameter(name, i, fallback) as unknown;
        const level = String(param('level', 'org')) as PracticeLevel;
        const projectId = String(param('projectId') ?? '').trim();
        const practiceId = String(param('practiceId') ?? '').trim();
        const citations = arrayOf<Omit<PracticeCitation, 'verified'>>(param('citations', '[]'), 'Citations');
        const draft: PracticeDraftInput = {
          ...(practiceId && { practiceId }),
          handle: String(param('handle') ?? '').trim(),
          title: String(param('title') ?? '').trim(),
          level,
          ...(level === 'project' && projectId && { projectId }),
          strength: String(param('strength', 'recommended')) as PracticeStrength,
          topics: listOf(param('topics')),
          repos: listOf(param('repositories')),
          paths: listOf(param('paths')),
          summary: String(param('summary') ?? '').trim(),
          body: String(param('body') ?? ''),
          checks: arrayOf<PracticeCheck>(param('checks', '[]'), 'Checks'),
          citations,
        };
        const files = refusal ? [] : filesOf(param('files'));
        const origin: PracticeDraftOrigin = {
          source: citations.length ? 'learned' : 'agent',
          ...(workflowId && !agentId && { workflowId }),
          ...(agentId && { agentId }),
          ...(executionId && { executionId }),
          ...(files.length && { files }),
        };
        const { practice, version } = port.draft(draft, origin);
        out.push(
          one(input, i, {
            practiceId: practice.id,
            handle: practice.handle,
            version: version.version,
            tainted: version.tainted,
            citations: version.citations as unknown as JsonObject[],
            verified: version.citations.filter((c) => c.verified).length,
            verification: refusal ? 'skipped' : 'checked',
            ...(refusal && { reason: refusal }),
            url: `/brain/practices/${practice.id}`,
          }),
        );
      } catch (caught) {
        const status = caught instanceof HttpError ? caught.status : undefined;
        out.push(one(input, i, { error: (caught as Error).message, ...(status && { status }), drafted: false }));
      }
    }
    return [out];
  },
});
