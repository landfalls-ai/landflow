# Team templates

A [team](agent-teams.md) and the flow that runs it saved as one template, and created again, anywhere, with fresh ids.
This replaces the setup script that recreated the plugin team and its flow by hand. It extends the Templates library
([features/editor.md](features/editor.md)); there is no second template system: a team template is a saved template with a
`bundle`, listed, used, edited, exported and imported like the others.

## Saving

**Save as template** on a team page (`POST /api/agent-teams/:id/template`) asks for a name, a description, where the
template is available (a project, or the whole instance for owners and admins) and **which flow to take along**: the
flows that run this team (a Run a Team node set to it; `GET /api/agent-teams/:id/flows`) or none. The template holds:

| What | How |
|---|---|
| The team | its draft: members, titles, roles, reporting lines, reviewers, budgets, where questions go |
| Every member that is a Landflow agent | its **published** config (the draft while it was never published), with whether it was published |
| The agents those agents delegate to, and the ones the flow's Run an Agent nodes name | the same way, up to 30 agents in all |
| Remote members | their A2A address and options, as data (`parameters`) |
| The flow, if picked | a normal template workflow (ids of this instance, pinned data and publication state left out; data tables by name) |
| Credential slots | one per credential type and referenced credential, named for who uses it ("Used by Developer (model), Reviewer (remote)") |

No secret and no credential id of this instance is kept: every reference in the agents' models, tools, knowledge bases,
channels, the remote members and the flow's nodes becomes a slot. An Anthropic key on a model is an optional slot (the
host's key serves otherwise). A flow that doesn't run the team is refused (400), and so is a team with a member whose agent
was deleted.

A team template shows on the Templates page with a **Team** badge. Its page lists the members (title, agent or remote
address), says how many agents come with it, and shows the flow's canvas if it has one. **Export** and **Import** carry
it (the template file's `bundle`). Its flow can't be swapped by **Edit**: save it again from the team page.

## Using

**Use template** on a team template asks for the team's name, the flow's name (when there is one), the project, and a
credential for each slot: pick a saved one of the slot's type or **+ New credential…** (the same picker as for any
template). Then (`POST /api/templates/:id/use`, `teamName?`):

1. Data tables of the flow are created if missing.
2. The agents are created in the project as drafts with new ids. Credentials come from the picks; a reference left on
   "Choose later" is dropped (the unpicked slots come back as warnings). Schedules and channels come back **off**.
   Agents that were published are published again.
3. Sub-agent tools follow the new agents. A workflow tool pointing at the template's flow follows the new flow; any other
   workflow tool is left out with a warning.
4. The team is created with its members' `agentId`s remapped (titles, reviews and reporting lines keep their member ids),
   remote members get the picked credentials, and it is published again when it was published and has no issues.
5. The flow is created inactive, in the project and folder asked for: the Run a Team node carries the new team's id and
   name, Run an Agent nodes the new agents' ids, credentials the picks, URL paths made unique.

If anything fails the agents and team just created are removed again. The page then opens the **new team**
(`/agents/teams/:id?flow=<id>`), which lists the flows that run it with the new one marked. A team template without a flow
creates only the team and its agents (`workflow` is absent from the answer; `team` and `agents` are always there).

## Where it lives

The bundle is part of the template document (`templates.data`), so there is no migration. The code is
`apps/web/src/lib/server/templates/team.ts` (bundle, credential slots, create, remap) and `saveTeamTemplate` /
`useTemplate` in `templates/index.ts`; the types are `TemplateBundle` in `lib/shared/templates.ts`; the UI is
`components/agents/save-team-template-dialog.tsx` and the team parts of `components/templates/`.

## Not built

- One flow per template, and no other teams: a flow that runs a second team keeps pointing at that team's id here.
- A credential the agents and the flow both use becomes two slots (the dialog starts both on the first saved credential of
  the type).
- A workflow tool for a flow outside the template is dropped, and agents' knowledge bases arrive empty (their collections
  are data, not configuration).
- Agents of the same name are not merged with ones already in the project: using a template twice makes two sets.
