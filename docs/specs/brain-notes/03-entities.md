# Brain item 3: generic entities

## What was built

- **Registry.** Table `brain_entities` (migration 2063, in `TABLES`): `type`, `id`, `name`, `description`, `owner` (a user
  id or a free name), `project_id`, `attrs` JSON (flat values, at most 20), `source`, timestamps; primary key (type, id).
  Types in one constant, `ENTITY_TYPES` (`initiative`, `person`, `customer`, `system`) in `lib/shared/brain.ts`, with
  `BrainEntity`, `EntityKnowledge`, `entityRef`/`parseEntityRef`, `ENTITY_ID`. Server module `brain/entities.ts`
  (`upsertEntity`, `getEntity`, `listEntities`, `deleteEntity`, `addEntityFact`, `entityKnowledge`, `canEntity`,
  `entityKeysFor`/`entityKeysIn`). Custom types: not built.
- **Routes.** `GET/POST /api/entities`, `GET/PATCH/DELETE /api/entities/:type/:id`, `POST /api/entities/:type/:id/facts`
  (policy: `workflows:read`/`write`; the route checks the entity's project role). OpenAPI entries added.
- **Scope.** `UsageScope.entities` (a set of `<type>/<id>`): `scopeForActor` (members: entities of projects they can open),
  `scopeForWorkflow` (the workflow's or agent's project), `covers(scope, { entity })`, `projectsOf`, the MCP `brainScope`.
- **Facts and suggestions.** `FACT_SUBJECTS` gained `entity` (subjectId `<type>/<id>`); `ProposalTargetType` gained `entity`
  (target id `<type>/<id>`); `ProposalInput.entity`. `inScope` in facts and proposals, `canProposal`, `proposeFrom`, the
  proposals route, dismiss-as-intended (writes the `intended` fact on the entity) and the inbox card (name and type) handle it.
  Facts added by people or flows carry an id with `:fact_` so `staleFactsBefore` never stales them.
- **Nodes.** Entity (`core.brainEntity`, `nodes/entities.ts`, a tool): create or update, get, list (type, owner, words),
  delete, add fact. Suggest Improvement: *About Entity* (type and ID). Landflow Usage: *Search Facts* has an *About* filter
  (`subjectType`), new operation *Entity Knowledge*. Find Similar lists Entities in *Search In*.
- **Study, search, analyst.** `study()` profiles every entity without a model (`studyEntities`; `StudyResult.entities`);
  facts embed per project like workflow facts. `findSimilar` kind `entity` (`SIMILAR_KINDS`), the six-field projection for
  other projects, `SimilarOwn.entityType`. MCP: `check_overlap` and `brain_search_facts` include entities, `brain_suggest`
  takes `entity`. Analyst: tools `entity_knowledge`, `entities` (list only), `note_entity_fact` (no delete).
- **UI.** Insights: entity count in the status line; the facts list shows an entity's type. `BrainStatus.entities`.
- Tests: `apps/web/test/brain-entities.test.ts` (15). Updated: `brain.test.ts` analyst tool list and count (5 to 8 tools).
  Docs: `docs/second-brain.md` ("Entities", API table, where the code is), `docs/reference/api.md`.

## Decisions

- An entity's project is its own `project_id`, not a `project_resources` row: no new `ResourceKind`, so no share/transfer
  plumbing. No project means the default project, like a workflow without a row.
- The ids of an entity in facts, suggestions and scopes is `<type>/<id>`, so ids need no global uniqueness.
- A flow or agent creates entities in its own project and can't touch ones outside its creator's view (a name it can't see
  answers "No <type> <id>", the same as a missing one).
- Find Similar's projection for other projects stays the six fields: `type` is `entity`, not the entity type.
- The study does not use a model for entities (a description is already human-written).
- The analyst can note a fact but not delete or edit an entity.

## History row

`Entities: a registry of initiatives, people, customers and systems (brain_entities, /api/entities), facts and suggestions about them (entity:<type>/<id>), the Entity node, Entity Knowledge, entities in Find Similar, the study, the MCP brain tools and the analyst`

## Roadmap paragraph

The brain reasons about more than workflows and agents. An entity registry (initiatives, people, customers, systems) with
an owner, a project and flat attributes gives it things no workflow holds; facts and suggestions are addressed to
`entity:<type>/<id>`, the study profiles them, Find Similar and the MCP `check_overlap` search them (other projects only as
the six-field projection), and an Entity node lets flows and agents keep the registry and note facts. This is what an
overlap finder ("two teams run the same initiative") needs.

## Limitations to record

- Four entity types only; custom types are not supported.
- Entities have no relations between them (an initiative's system, a customer's owner is a plain attribute or fact).
- The study profiles entities from what is on file; it never asks a model about them, and no detector looks at them.
- Entity suggestions are advice only (nothing to apply); entities have no page of their own: the Insights facts list and
  the inbox are where they show.
- Entities can't be moved or shared between projects except by `PATCH projectId`; they are not a project resource kind.
