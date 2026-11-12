# Items 6 and 10: Find Similar, the vector access fix, and the brain over MCP

## What was built

- `brain/similar.ts` `findSimilar(text, { scope, kinds, limit, minScore, includeOthers, exclude })`: nearest workflows, agents
  and facts; shared word overlap (cosine on stemmed term sets) plus a vector bonus for the subjects of facts found by
  `vectorFactHits`; works with embeddings off. Own-project matches carry `yours: true`, `id` and detail; other-project
  matches are exactly `{ type, title, owner, goal, project, score }` (workflows and agents only, never facts).
- `core.findSimilar` node (nodes/usage.ts), usable as an agent tool.
- Vector access fix: the Vector Store nodes refuse any `landflow-brain*` collection (case ignored, trimmed), for insert, load
  and the retrieve sub-node modes. No "own project read" exception: refusing all was cheaper and safer; the nodes point at
  Find Similar and Landflow Usage.
- `mcp/brain-tools.ts`, registered by `instanceServer`: `brain_search_facts`, `brain_list_suggestions`,
  `brain_workflow_knowledge`, `brain_usage_report`, `check_overlap`, `brain_suggest`. Scope = `scopeForActor`, cut down to the
  project on project servers. The instance server has no per-token read-only mode, so `brain_suggest` is gated by edit access
  (`canProposal`) and by the project scope.
- Docs: second-brain.md (Find Similar, vector collections, brain over MCP, Limits, Where the code is), reference/api.md.

## History rows

| Commit | What | Docs |
|---|---|---|
| `<hash>` | Find Similar: `findSimilar` and the `core.findSimilar` node (nearest workflows, agents, facts; keywords, plus vectors when embeddings are on); matches in projects the caller can't open are a six-field projection with no id, no facts and no evidence; Vector Store nodes refuse `landflow-brain*` collections | [second-brain.md](../../second-brain.md), [limitations.md](../../limitations.md) |
| `<hash>` | The brain over the instance MCP server: `brain_search_facts`, `brain_list_suggestions`, `brain_workflow_knowledge`, `brain_usage_report`, `check_overlap`, `brain_suggest`, each scoped to what the caller can open | [second-brain.md](../../second-brain.md), [reference/api.md](../../reference/api.md) |

(Both landed in one commit; use its hash for both rows.)

## Roadmap paragraph

**Find Similar and the brain over MCP**: a Find Similar node and `check_overlap` tool answer "is anyone already doing this?"
with the nearest workflows, agents and facts, in full for the caller's projects and as a six-field projection (type, title,
owner, goal, project, score) for the rest. The instance MCP server serves the brain (`brain_search_facts`,
`brain_list_suggestions`, `brain_workflow_knowledge`, `brain_usage_report`, `check_overlap`, `brain_suggest`). Workflows and
agents can no longer read the brain's vector collections with a Vector Store node. Open: a stricter embedding-only ranking
mode, a per-token read-only flag for `brain_suggest`, and showing Find Similar in the editor when a workflow is created.

## limitations.md change

Remove the bullet in the second-brain section that says the vector collections `landflow-brain-<project>` are not
access-controlled (it is closed: Vector Store nodes refuse them). Add, if wanted: "Find Similar ranks by shared words and, with
embeddings on, by meaning; it does not look inside workflow nodes, only names, descriptions and the brain's purpose. A match in a
project you can't open shows its title, owner, goal and project name, which is by design."
