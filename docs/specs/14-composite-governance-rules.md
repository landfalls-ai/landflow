# Composite governance rules ("AI calls only inside an AI step")

## Problem

[composites.md](../composites.md#not-built) and [limitations.md](../limitations.md) (Composite nodes bullet): "no
governance rule can require a composite yet (for example 'AI calls only inside an AI step')."

Governance ([audit-and-governance.md](../features/audit-and-governance.md)) can allow or block node *types*, plugins,
HTTP hosts and MCP servers (`governanceSchema` in `lib/server/governance/policy.ts`; narrowed per project and workflow in
`governance/scopes.ts`). It can block `core.aiAgent`, but not say "a node that calls a model is fine only when it sits
inside a `core.aiStep` frame, where the contract guarantees a chat model, On error -> Continue, and a reviewable shape".
A frame's contract is checked (`compositeIssues()` in `lib/shared/composites.ts`, published through `workflowCompositeIssues`
in `lib/server/composites.ts`), but whether a node must live inside a frame is not.

## Goals / Non-goals

Goals
- A rule says: nodes matching X may only exist inside a composite frame matching Y (or: must not exist inside Z).
- Same matcher language as slots (`NodeMatcher`, `packages/protocol/src/types.ts`): by `type`, `kind`, `supplies`,
  `category`, `capability`, `input` and `anyOf`; composites by type (`composite`).
- Enforced where governance already is: a warning on save (`policyWarnings`), a refusal on publish (422), a refusal at
  run start; shown in the node creator and the editor as "needs an AI step", with a one-click "wrap in AI step".
- Scoped like node lists: instance, then project, then workflow; each level only adds rules.

Non-goals
- New composite types, or changing a frame's contract.
- Content rules (what a node's prompt says). Fine-grained per-call checks inside a node.
- Forcing frames in agents' own tool use (`withGovernance` for `agent:<id>` calls stays node-type based).

## Design

### Rule shape (no migration)

The instance policy is one JSON document under the `governance` key of `settings`; project and workflow policies are the
`data` column of `project_settings` (migration 1401, in `TABLES`) and `workflow_policies`. All three are JSON, so adding a
field needs a zod change and defaults, not a migration. (If review prefers a table for audit of rule changes, sketch
migration `2080 composite_rules`; not needed for v1.)

```ts
interface CompositeRule {
  id: string;                      // stable, for messages and the audit log
  name: string;                    // "AI calls only inside an AI step"
  kind: 'require-inside' | 'forbid-inside';
  match: NodeMatcher;              // nodes the rule is about: { input: 'ai_languageModel' } or { category: 'AI', kind: 'action' }
  composite: NodeMatcher;          // frames: { composite: ['core.aiStep', 'triage.aiTriage'] }
  nested?: boolean;                // a frame nested in an allowed frame counts (default true)
  severity: 'error' | 'warn';      // error blocks publishing; warn is shown only
  message?: string;
}
```

Changes: `governanceSchema` (`policy.ts`) gets `compositeRules: z.array(compositeRuleSchema).max(50)`, defaulting to `[]`
in `DEFAULT_GOVERNANCE_POLICY` and `GovernancePolicy` (`lib/shared/governance.ts`), plus `governancePatchSchema`;
`projectSettingsPatchSchema` and `workflowPolicyPatchSchema` (`governance/scopes.ts`) get the same optional array, with
`DEFAULT_PROJECT_SETTINGS` / `DEFAULT_WORKFLOW_POLICY` in `lib/shared/project-policy.ts`. Rules are the union of the
levels (a lower level cannot remove an instance rule). `PolicyViolation.rule` (`lib/shared/governance.ts`) gets a new
value `'composite'` and optional `ruleId`, `groupId`.

### Evaluation (new module `lib/server/governance/composite-rules.ts`)

`compositeViolations(workflow, rules, lookup = serverCompositeLookup())`:
1. For each enabled node, find rules whose `match` matches it with `nodeMatches(type, descriptor, matcher)`
   (`lib/shared/composites.ts`; works for any plugin's node through its descriptor; with the plugin offline only `type`
   matchers can be judged, so a rule naming a descriptor field treats an unknown node as a **violation of unknown**: warn,
   never error).
2. Find the node's frame with `compositeOfNode(workflow, nodeId)` and its ancestors via `compositeMembers`; test each frame
   type with `compositeMatches(type, rule.composite)`. `require-inside` violates when none match; `forbid-inside` when any does.
3. The nodes a frame's own slots place are inside by definition (a reasoner in `core.aiStep`'s reasoner slot).
Result is `PolicyViolation[]` with a message built from `describeMatcher()` ("AI calls must be inside an AI step") and the fix.

Import cycle: `policy.ts` is imported by the plugin registry (`withGovernance`), and `lib/server/composites.ts` imports the
registry. So `composite-rules.ts` is not imported by `policy.ts`; it registers itself with a small hook
(`registerWorkflowRule()` in `policy.ts`, the same pattern as `registerApproverCheck` in `approvals.ts`) which
`workflowViolations()` consults. That keeps all existing call sites (`governance/saves.ts` for `policyWarnings`,
`assertPublishable()` for publish, importers, templates "unusable") unchanged and rule-aware.

### Run time

`withGovernance()` checks one node call with only a `workflowId`, with no knowledge of frames. Instead the check is at run
start in `runner.ts` next to `workflowScopes(workflow)` (line ~587): evaluate `compositeViolations` for the workflow being
run (cached by workflow version id, 1 s like the policy cache) and fail the execution before the first node with
"Blocked by policy: <rule name> ..." for `severity: 'error'`. Sub-workflows and queue workers go through the same segment
runner, so they are covered. Agents' tool calls to workflows are runs and are covered too.

### Routes, policy, UI

No new route for the instance: `GET`/`PATCH /api/settings/governance` already read and write the document (owners and
admins; `policy.ts` access rules unchanged). `PATCH /api/projects/:id/settings` and `PUT /api/workflows/:id/policy`
accept `compositeRules` (project admins / workflow admins). `openapi.ts` schemas for those three bodies get the field.
A read-only `GET /api/composites/rules?workflowId=` (new, `workflows:read`, under `/api/composites` in `policy.ts`) returns
a workflow's effective rules and current violations for the editor. UI: Settings -> Governance "Composite rules" editor
(a rule card, the matcher shown with `describeMatcher`, a **Preset: AI calls only in an AI step** button building
`{ match: { input: 'ai_languageModel' }, composite: { composite: 'core.aiStep' } }`); the editor shows a badge on a
violating node and **Wrap in AI step** (uses `instantiateComposite` / `autoBind` from `lib/shared/composites.ts`); the node
creator marks types a rule would reject outside a frame.

### Queue mode and deploy

The policy documents are re-read at most once a second by every process, so rule changes reach mains and workers alike; the
run-start check runs on whichever worker takes the segment. No deploy or compose change.

## Implementation plan

1. Types and schemas: `CompositeRule`, `compositeRuleSchema`, defaults, `PolicyViolation` extension. Test: schema
   round-trip, default policy unchanged (`apps/web/test/governance*.test.ts`).
2. `composite-rules.ts` + hook in `policy.ts`. Test: nodes inside/outside an AI step, nested frames, plugin offline,
   `forbid-inside`, warn vs error, disabled nodes ignored.
3. Save and publish wiring (already via `workflowViolations`). Test: PUT returns `policyWarnings` with the rule;
   `publishVersion` 422; four-eyes request path unaffected.
4. Scoped rules (project, workflow) in `scopes.ts` and their routes. Test: union semantics, a workflow cannot drop an
   instance rule, error text says where the rule was set.
5. Run-start check in `runner.ts`. Test: a published workflow edited by rules after publishing fails fast; sub-workflow;
   rules off changes nothing (`cluster-runtime.test.ts` stays green).
6. UI: rules editor, node badge, wrap action; `GET /api/composites/rules`. Test: component tests + manual check.
7. Templates: a template using a violating node is marked unusable (existing logic via `workflowViolations`). Test: template problems list.

## Docs to update

`docs/composites.md` (remove the Not built bullet, add "Governance rules"), `docs/features/audit-and-governance.md`,
`docs/limitations.md` (delete the Composite nodes sentence, add what stays: plugin-offline matchers), `docs/roadmap.md`,
`docs/reference/api.md`, `docs/history.md`, `docs/templates.md` (unusable reason).

## Risks and open questions

- Existing published workflows break at run start when a rule is switched on. Mitigate: rules start as `warn` in the editor
  with a "N workflows would violate this" preview before saving a rule (needs a scan over `store.listWorkflows()`).
- "AI call" is not a property of a node; `input: 'ai_languageModel'` catches agent-shaped nodes and chains but not an HTTP
  Request to a model API. Document it; a `capability` tag (`llm.chain`) is the stable handle, so more nodes should be tagged.
- Frame membership is by `workflow.groups`, which the editor normalises (`normalizeGroups`); a hand-edited JSON with stale
  groups is judged after normalisation, as `workflowScopes` does.
- Composite types saved as `local.<name>` are not in Git sync or promotion (limitations): a rule naming one is unknown on
  another instance. Prefer plugin-declared types in rules and warn on `local.` names.

## Effort and first slice

Effort: M.

First slice: steps 1-3 for the **instance** only, with the single preset (match `input: ai_languageModel`, composite
`core.aiStep`), enforced on save (warning) and publish (422), edited as JSON in Settings -> Governance. No run-start
check, no scoping, no wrap action.
