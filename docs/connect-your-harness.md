# Connect your harness

One page for each person to connect their own coding tool to Landflow: `/connect`, in the user menu as **Connect your
harness**. Part of the [Landflow docs](README.md).

## The three steps

1. **Pick your harness**: Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code or any MCP client.
2. **Make a key**: **Brain** is always ticked (`brain:read` and `brain:write`: your briefing, asking, recording your own
   work). **Read workflows**, **Edit workflows** and **Run** are optional. Pick an expiry (90 days by default). The key
   is made with `POST /api/api-keys` as "Harness · <harness>", shown once, and put into the setup below.
3. **Copy the setup** and press **Test connection**: it sends `tools/list` to `/api/mcp` with the key and says how many
   tools the key reaches (a brain-only key reaches 9).

The instance MCP server must be on (Settings → MCP → Access token), or the test says it is off.

## Setup for each harness

| Harness | Where it goes |
|---|---|
| Claude Code | `claude mcp add --transport http landflow <url> --header "Authorization: Bearer <key>"`, or a `.mcp.json` entry (do not commit it: it holds the key) |
| Cursor | `.cursor/mcp.json` (`mcpServers`, `url`, `headers`) |
| Codex CLI | `~/.codex/config.toml` (`[mcp_servers.landflow]`, `url`, `http_headers`) |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers`, `httpUrl`, `headers`) |
| VS Code | `.vscode/mcp.json` (`servers`, `type: "http"`) |
| Any MCP client | the URL (Streamable HTTP) and an `Authorization: Bearer <key>` header |

For Claude Code the page also shows the [landflow-brain mod](landflow-brain-mod.md) install, first from the repository's
marketplace (`claude plugin marketplace add landfalls-ai/landflow`, then `claude plugin install landflow-brain`), or from a
checkout, and its options (`url`, `key`, `repos`, `mode`). The snippets are made by `snippetFor` in `apps/web/src/components/connect/harness-snippets.ts`.

## Who may make which key

Every role makes keys with the brain scopes and the workflow scopes (`workflows:*`, `executions:*`, `run`): the role's
own checks still apply to every call. Only owners and admins make a key with `admin`, and SCIM tokens are made in
Settings → Security. The route refuses the rest with the reason (`scopeRefusal` in `lib/server/auth/api-keys.ts`).

## What the brain gives at session start

With the mod (or the `morning-briefing` prompt of the MCP server), your own work from yesterday comes into the session as
quoted data, and your sessions are held for your review before they are sent. Every event is private unless you share it with your team or the organization (B18).
See [work-and-briefings.md](work-and-briefings.md).

## Project context

A project lists the repositories it works in (**owner/name**, lowercased; at most 20; set by the project's admins with
`PATCH /api/projects/:id { repos }`). A harness asks which project a repository belongs to and gets that project's
"Where this work fits" block: the goals, brief and words the agents inside Landflow get ([agents.md](agents.md#project-context)).
It is data, not instructions.

- **Route:** `GET /api/projects/context?repo=owner/name` or `?projectId=…`, `&size=compact|full` (default compact),
  scope `brain:read`. By repository you get the projects you have a role in that list it (owners and admins: all of them),
  sorted by name, and the first one's block; none is `{ projects: [], context: null }`, never a 404. By id without a
  role it is 404. The answer's shape is `ProjectContextAnswer` (`lib/shared/project-context-api.ts`).
- **MCP tool:** `project_context { repo?, projectId?, size? }` gives the same answer. On a server scoped to one project
  (`/api/mcp/projects/<id>`) it gives that project only, whatever is asked.
- **Workspace:** when the first project saved a [workspace](projects-and-goals.md#workspace), the answer (and the MCP
  tool's) also has `workspace: { projectId, repos, worktree, branchTemplate, branchPattern }`: for each repository its
  `defaultBranch` and `setup` lines, a worktree per run or a shared checkout, and the branch pattern with `{project}`
  filled in. `setup` is left out unless you are an editor or admin of that project (owners and admins always). Landflow
  never runs the setup lines. Without a saved workspace the answer has no `workspace`. The mod and `landflow work context`
  ignore the field for now.
- **MCP resource:** `project://{id}/context` is the full block of a project you have a role in.
- **Morning briefing:** the `morning-briefing` prompt ends with "Your goals": the open goals of the projects you have a
  role in, at most 5 by project, titles only.

The mod (0.4.0) and `landflow work context` also load the goals of the project that lists the repository you are in; see [projects-and-goals.md](projects-and-goals.md#in-claude-code-and-the-shell).

## The admin's switch

**Settings → MCP → Work from local tools → Allow automatic sending** (owners and admins; `PATCH /api/settings
{ brain: { workAutoSend: 'allowed' | 'forbidden' } }`). When it is off, people's tools hold their work until the person
sends it, also in mode `auto`.

## Settings → MCP

Four collapsed sections, each with one sentence and a link: **Access token** (the instance server's switch and token, your
MCP tokens), **Connected clients**, **Tools** (the 25 instance tools with the scope each needs, the plugin tools, grants,
approvals) and **Gateway**.
