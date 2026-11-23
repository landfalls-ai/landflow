# Per-rule outputs for Switch and Text Classifier

## Problem

[limitations.md](../limitations.md) ("Integrations are tested against fakes") says: "Switch and Text Classifier have a
fixed set of outputs (4 plus a fallback): ports can be shown or hidden by parameters, but not repeated per rule."

Today `switchNode` (`apps/web/src/lib/server/nodes/flow.ts`, `SWITCH_OUTPUTS = 4`) declares five static
`outputs` (`0`-`3`, `Fallback`) and `textClassifierNode` (`nodes/chains.ts`, `CLASSIFIER_OUTPUTS = 4`) declares four plus
"Other". A fifth rule makes the node throw ("Switch has 4 rule outputs, but 5 rules are set"). n8n's Switch grows one
output per rule; `n8n-import.ts` (`switchNode` converter, `SWITCH_OUTPUTS`) drops connections from outputs 4 and up and
warns. The port machinery (`indexedPorts()` in `packages/protocol/src/util.ts`, `PortDescriptor.displayOptions`) only
shows or hides a fixed list of ports; a port's index is its position in the descriptor.

## Goals / Non-goals

Goals
- A Switch with N rules shows N rule outputs plus Fallback (when enabled); a Text Classifier with N categories shows N
  plus Other (when enabled). Handles are labelled with the rule's name when it has one.
- Existing workflows keep working with no data change: connections to `Fallback` (output index 4) and `Other` stay put.
- The canvas, run view, assistant, flow builder, MCP tools and n8n import all agree on how many outputs a node has.

Non-goals
- Dynamic outputs for plugin nodes in other languages (Go, Python SDKs). This spec adds the descriptor field to the
  protocol and the TypeScript SDK; Go and Python get it when a plugin needs it.
- Changing Switch matching semantics, or any other node's ports (If, Filter, Merge).

## Design

### Descriptor change (protocol, no migration)

Add to `PortDescriptor` (`packages/protocol/src/types.ts`) an optional, new field:

```ts
/** One port per entry of a collection parameter instead of one port. */
repeat?: { parameter: string; path?: string; labelFrom?: string; min?: number }
```

and a matching zod entry in `portSchema` (`packages/protocol/src/schema.ts`, `outputs: z.array(portSchema)`).
Resolution is one shared function, `resolvePorts(ports, parameters)` in `packages/protocol/src/util.ts`, which expands a
`repeat` port into `n` copies (n = length of `parameters[parameter][path]`, at least `min`), each labelled from
`labelFrom` (a field of the entry, for example `outputKey`) or its number. `indexedPorts()` and `visiblePorts()` call it
first, so every consumer that already goes through them gets the new ports. Ports after the repeating one (the
`Fallback`) are indexed after the expanded ones, so the fallback index moves with the rule count.

### Backwards compatibility (the hard part)

Today `Fallback` is output index 4. If it moved to index `rules.length` for old nodes, a saved connection from output 4
would silently re-point. So the new layout is opt-in per node by a new property, not a change to the old one:

- New property `outputMode` (`options`: `fixed` default, `perRule`) on both nodes. Absent or `fixed`: exactly today's
  five ports (`repeat` is guarded by `displayOptions.show.outputMode = ['perRule']`, the legacy ports by
  `hide`). `perRule`: `repeat` port plus `Fallback`.
- The node creator, `flow-builder.ts` and assistant ops create new nodes with `outputMode: 'perRule'` (set through the
  starter `parameters`); the editor offers "Show one output per rule" for an old node, which renumbers connections
  (see step 5). No saved workflow changes meaning on load.
- Open alternative: pin the layout by `typeVersion: 2` of the node (workflow nodes already carry `typeVersion`,
  `packages/engine/src/types.ts`). Rejected here because the descriptor has a single `version` and the engine reads ports
  per type, not per pinned version.

### Execution

`execute()` in both nodes builds `outputs` from the same resolver: in `perRule` mode it makes
`Array.from({ length: rules.length + 1 })`, drops the "more than 4" error, and puts Fallback/Other last. Expression mode
(`mode: 'expression'`) has no rules to count, so in `perRule` mode it gets a new `numberOutputs` property
(default 4, shown only for expression mode), as n8n has, and the index is checked against it. Items go
through `NodeItem.pairedItem` exactly as now. The engine returns `outputs: NodeItem[][]` (`NodeResult` in
`packages/engine/src/types.ts`) and routes by index, so it needs no change.

### Places that read `descriptor.outputs` directly (must switch to the resolver)

`components/canvas/node-tile.tsx` (`indexPorts`), `components/editor/store.ts` (lines ~660-734, drop-to-add and
split-edge), `components/editor/node-panel.tsx:152`, `components/editor/node-creator.tsx:248`,
`components/run/logs-panel.tsx:188`, `lib/server/flow-builder.ts` (`catalog()` line ~97, the output-count check ~182),
`lib/shared/assistant-ops.ts` (~313, ~378), `lib/server/assistant/research.ts:166`, `lib/server/mcp/instance-tools.ts:368`
(returns the descriptor; add the resolved ports for the node's parameters in `get_workflow`/node-type tools),
`lib/server/n8n-import.ts` (`mainCount()` ~1655 and the Switch/Classifier converters: with `perRule` set, map n8n
output i to i and stop dropping). Each takes `parameters` where it has a node, and the unresolved descriptor otherwise.

### Routes, policy, queue mode, deploy

No new route, table or migration; nothing in `policy.ts` or `openapi.ts` changes (the node-type descriptor served by
`GET /api/node-types` just carries the new `repeat` field; mention it in the OpenAPI description of the node type if
the schema lists port fields). Queue mode: workers run the same node code and the same resolver; a mixed-version fleet
during a rollout is the one risk (an old worker throws on rule 5), noted below. No deploy changes.

## Implementation plan

1. Protocol: `repeat` in `PortDescriptor` and `portSchema`; `resolvePorts()` and use it in `indexedPorts`/`visiblePorts`.
   Test: new `packages/protocol` unit tests (expansion, labels, min, fallback index, hidden ports keep indexes).
2. Switch: `outputMode`, `numberOutputs`, repeat port, execute for `perRule`. Test: extend `apps/web/test/switch.test.ts`
   (7 rules route to 7 outputs; legacy node unchanged; Fallback index = rules.length; allMatchingOutputs).
3. Text Classifier: same in `nodes/chains.ts`. Test: `apps/web/test/chains.test.ts` (more than 4 categories, Other last).
4. Consumers: swap the direct `.outputs` reads listed above for the resolver. Tests: `apps/web` editor/store tests,
   `flow-builder` and `assistant-ops` tests, a canvas test of handle ids for a 6-rule Switch.
5. Conversion: "Show one output per rule" action that sets `outputMode` and moves the `Fallback` connection from index
   4 to `rules.length` in one store action (one undo step). Test: store test on a saved workflow.
6. n8n import: no dropped outputs in `perRule` mode. Test: `apps/web/test/n8n-import*.test.ts` fixtures with 6 outputs.
7. Run `(cd apps/web && npx vitest run) && pnpm typecheck && pnpm test`.

## Docs to update

`docs/limitations.md` (delete the Switch/Classifier fixed-outputs sentence), `docs/features/editor.md` or
`docs/features/integrations.md` (Switch and Text Classifier pages), `docs/protocol.md` (port `repeat`),
`docs/reference/api.md` if node-type fields are listed, `docs/roadmap.md` (a line that closes the gap), a row in
`docs/history.md` per commit, and `docs/features/ai.md` where the Text Classifier "4 categories" limit is described.

## Risks and open questions

- Mixed-version fleets: an old worker can't run a 5-rule Switch. Acceptable (rollouts replace workers); document.
- Going back from `perRule` to `fixed` with more than 4 rules: refuse in the panel (not silently drop).
- Handle ids are `type:index`, so deleting rule 2 of 5 renumbers rules 3-5; connections must be remapped on rule
  delete/reorder, otherwise they follow the position, not the rule. Needs a per-rule stable key (`outputKey`) and a
  store hook on collection edits in `components/editor/param-form.tsx`. Decide: remap by position (simple, n8n does this)
  or by key.
- Does `resolvePorts` belong in the Go/Python SDK validation now? Defer until a plugin asks.

## Effort and first slice

Effort: M (the protocol change is small; the consumer sweep and rule delete/reorder remap are the bulk).

First slice: steps 1-2 plus the canvas read in `node-tile.tsx`: Switch only, `outputMode: 'perRule'` behind the property,
no conversion action and no importer change. Ships a Switch with more than 4 outputs for new nodes and leaves every
saved workflow untouched.
