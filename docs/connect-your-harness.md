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

## The admin's switch

**Settings → MCP → Work from local tools → Allow automatic sending** (owners and admins; `PATCH /api/settings
{ brain: { workAutoSend: 'allowed' | 'forbidden' } }`). When it is off, people's tools hold their work until the person
sends it, also in mode `auto`.

## Settings → MCP

Four collapsed sections, each with one sentence and a link: **Access token** (the instance server's switch and token, your
MCP tokens), **Connected clients**, **Tools** (the 25 instance tools with the scope each needs, the plugin tools, grants,
approvals) and **Gateway**.
