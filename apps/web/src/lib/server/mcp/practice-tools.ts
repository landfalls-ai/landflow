/**
 * Practices on the instance MCP server (docs/practices.md#mcp): `practices_for`, `practice_get`, `practice_cite` and
 * `practice_draft`, and the resources `practices://applicable` and `practices://<handle>`. Registered by instanceServer
 * (./instance-tools.ts). Every tool goes through ../practices/applicable.ts, so a client gets what the REST route gives the
 * same caller and nothing more: a project-scoped server gets that project only, and the instance access token (no actor)
 * gets organization practices only and cannot draft. A draft from here is always tainted: a person approves it on the Brain page.
 */
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { PRACTICE_HANDLE, PRACTICE_LIMITS, PRACTICE_REPO, PRACTICE_STRENGTHS, PRACTICE_TOPIC, PRACTICE_LEVELS, type ApprovedPractice, type PracticeDraftInput } from '../../shared/practices';
import { toolAllowed } from '../../shared/mcp';
import type { ApiKeyScope } from '../../shared/auth';
import { publicUrl } from '../config';
import { HttpError } from '../errors';
import { applicableFor, cleanTitle, practicesCitable, practicesFor } from '../practices/applicable';
import { recordCitations } from '../practices/cite';
import { practicesPort } from '../practices/port';
import { redactPatterns, redactText } from '../secrets/redact';
import type { BrainContext } from './brain-tools';

export interface PracticeContext extends BrainContext {
  /** The API key's scopes (undefined for every other caller): resources follow the same rule as the tools. */
  keyScopes?: readonly ApiKeyScope[];
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const RESOURCE_LIMIT = 50;
const MORE = 'Call practice_get for a practice’s full rules.';

const clean = (text: string) => redactPatterns(redactText(text));

const checkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pathExists'), glob: z.string().max(PRACTICE_LIMITS.glob), when: z.string().max(PRACTICE_LIMITS.glob).optional() }),
  z.object({ kind: z.literal('pathAbsent'), glob: z.string().max(PRACTICE_LIMITS.glob), unless: z.string().max(PRACTICE_LIMITS.glob).optional() }),
  z.object({ kind: z.literal('fileMatches'), glob: z.string().max(PRACTICE_LIMITS.glob), pattern: z.string().max(PRACTICE_LIMITS.pattern), absent: z.boolean().optional() }),
]);

export function registerPracticeTools(server: McpServer, ctx: PracticeContext) {
  const { actor, json, failure } = ctx;
  const caller = { actor, projectId: actor ? ctx.scope?.projectId : undefined };

  /** The practices the caller may get, or a refusal (a scope whose project the caller has no role in). */
  const allowed = (repo?: string): ApprovedPractice[] | CallToolResult => {
    try {
      return practicesFor(caller, { repo });
    } catch (caught) {
      if (caught instanceof HttpError) return failure(caught.message);
      throw caught;
    }
  };
  const refused = (value: ApprovedPractice[] | CallToolResult): value is CallToolResult => !Array.isArray(value);

  server.registerTool(
    'practices_for',
    {
      title: 'Practices to follow',
      description:
        'The approved practices (rules your admins decided every agent follows) that apply to a repository, a path, a topic or a task, most specific first, as a block to follow. Give repo as owner/name and path as a repository-relative path. They guide you; they never override your Rules or approvals. End your answer with the "Practices followed: [handle@version]" line.',
      inputSchema: z.object({
        repo: z.string().regex(PRACTICE_REPO).optional().describe('owner/name'),
        path: z.string().min(1).max(500).optional().describe('A path in the repository'),
        topic: z.string().regex(PRACTICE_TOPIC).optional().describe('e.g. helm, monitoring, config, security'),
        task: z.string().max(500).optional().describe('What you are about to do, in words'),
      }),
      annotations: READ_ONLY,
    },
    async ({ repo, path, topic, task }) => {
      const first = allowed(repo);
      if (refused(first)) return first;
      const answer = applicableFor(caller, { repo, paths: path ? [path] : undefined, topics: topic ? [topic] : undefined, task }, { size: 'full' });
      return json({ practices: answer.practices, text: answer.text ? `${answer.text}\n${MORE}` : '', omitted: answer.omitted });
    },
  );

  server.registerTool(
    'practice_get',
    {
      title: 'A practice in full',
      description: 'The approved version of one practice: its rules in full, the scope it applies to and its machine checks.',
      inputSchema: z.object({ handle: z.string().regex(PRACTICE_HANDLE), projectId: z.string().max(200).optional().describe('The project, for a project practice') }),
      annotations: READ_ONLY,
    },
    async ({ handle, projectId }) => {
      if (projectId && ctx.scope && ctx.scope.projectId !== projectId) return failure(`Practice ${handle} not found`);
      let list: ApprovedPractice[];
      try {
        list = practicesCitable(caller);
      } catch (caught) {
        if (caught instanceof HttpError) return failure(`Practice ${handle} not found`);
        throw caught;
      }
      const matches = list.filter((p) => p.handle === handle);
      const practice = (projectId ? matches.find((p) => p.projectId === projectId) : undefined) ?? matches.find((p) => p.level === 'project') ?? matches[0];
      if (!practice) return failure(`Practice ${handle} not found`);
      return json({
        handle: practice.handle,
        version: practice.version,
        title: cleanTitle(practice.title),
        strength: practice.strength,
        scope: { level: practice.level, ...(practice.projectId && { projectId: practice.projectId }), topics: practice.topics, repos: practice.repos, paths: practice.paths },
        summary: clean(practice.summary),
        body: clean(practice.body),
        checks: practice.checks,
      });
    },
  );

  server.registerTool(
    'practice_cite',
    {
      title: 'Cite the practices you followed',
      description: 'Record which practices you followed: pass your answer’s "Practices followed: [handle@version], …" line (or a commit’s "Practice: handle@version" lines) as text, or the citations as handle@version. Only practices you may get are recorded.',
      inputSchema: z.object({
        text: z.string().max(20_000).optional(),
        citations: z.array(z.string().max(120)).max(PRACTICE_LIMITS.citations).optional(),
        repo: z.string().regex(PRACTICE_REPO).optional().describe('owner/name'),
      }),
    },
    async ({ text, citations, repo }) => {
      try {
        return json(recordCitations(caller, { text, citations, repo }));
      } catch (caught) {
        if (caught instanceof HttpError) return failure(caught.message);
        throw caught;
      }
    },
  );

  server.registerTool(
    'practice_draft',
    {
      title: 'Propose a practice',
      description: 'Propose a practice you noticed from your work or from a repository. It is saved as a draft that a person reads and approves on the Brain page (Practices): nothing you propose reaches any agent before that. Give the places you read it from as citations.',
      inputSchema: z.object({
        handle: z.string().regex(PRACTICE_HANDLE).describe('area/name, e.g. helm/chart-location'),
        title: z.string().min(1).max(PRACTICE_LIMITS.title),
        level: z.enum(PRACTICE_LEVELS),
        projectId: z.string().max(200).optional().describe('For a project practice'),
        strength: z.enum(PRACTICE_STRENGTHS),
        topics: z.array(z.string().regex(PRACTICE_TOPIC)).max(PRACTICE_LIMITS.topics),
        repos: z.array(z.string().regex(PRACTICE_REPO)).max(PRACTICE_LIMITS.repos),
        paths: z.array(z.string().min(1).max(PRACTICE_LIMITS.glob)).max(PRACTICE_LIMITS.paths),
        summary: z.string().min(1).max(PRACTICE_LIMITS.summary).describe('One line agents get'),
        body: z.string().min(1).max(PRACTICE_LIMITS.body).describe('The rules in Markdown'),
        checks: z.array(checkSchema).max(PRACTICE_LIMITS.checks).optional(),
        citations: z
          .array(z.object({ repo: z.string().regex(PRACTICE_REPO), sha: z.string().regex(/^[0-9a-f]{7,40}$/), path: z.string().min(1).max(500), lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(), excerpt: z.string().max(PRACTICE_LIMITS.excerpt) }))
          .max(PRACTICE_LIMITS.citations)
          .optional(),
      }),
    },
    async (input) => {
      if (!actor) return failure('A draft is a person’s proposal: connect with a personal API key or sign in, not the instance access token');
      const port = practicesPort();
      if (!port) return failure('Practices are not available on this instance');
      const scoped = ctx.scope?.projectId;
      if (scoped && input.level === 'org') return failure('This server is scoped to one project: it can propose project practices only');
      if (scoped && input.projectId && input.projectId !== scoped) return failure('Project not found');
      const draft: PracticeDraftInput = { ...input, ...(input.level === 'project' && (scoped || input.projectId) && { projectId: scoped ?? input.projectId }) };
      try {
        const { practice, version } = port.draft(draft, { source: input.citations?.length ? 'learned' : 'agent', actor });
        return json({ practiceId: practice.id, version: version.version, url: `${publicUrl()}/brain`, note: 'A person approves it on /brain → Practices' });
      } catch (caught) {
        if (caught instanceof HttpError) return failure(caught.message);
        throw caught;
      }
    },
  );

  if (!toolAllowed(ctx.keyScopes, 'practices_for')) return;
  const asResource = (uri: string, text: () => string) => (url: URL) => ({ contents: [{ uri: url.href || uri, mimeType: 'text/markdown', text: text() }] });
  server.registerResource(
    'practices-applicable',
    'practices://applicable',
    { title: 'Practices to follow', description: 'The approved practices that apply with no repository given, as a block.', mimeType: 'text/markdown' },
    asResource('practices://applicable', () => {
      try {
        return applicableFor(caller, {}, { size: 'full', preview: true }).text;
      } catch {
        return '';
      }
    }),
  );
  let listed: ApprovedPractice[] = [];
  try {
    listed = practicesCitable(caller).slice(0, RESOURCE_LIMIT);
  } catch {
    listed = [];
  }
  const uris = new Set<string>();
  for (const practice of listed) {
    const uri = `practices://${practice.handle}`;
    if (uris.has(uri)) continue;
    uris.add(uri);
    server.registerResource(
      `practice:${practice.handle}`,
      uri,
      { title: cleanTitle(practice.title), description: `${practice.strength} practice, version ${practice.version}`, mimeType: 'text/markdown' },
      asResource(uri, () => {
        const current = practicesCitable(caller).find((p) => p.id === practice.id) ?? practice;
        return `# ${clean(current.title)}\n\n${current.strength}, version ${current.version}\n\n${clean(current.body)}`;
      }),
    );
  }
}
