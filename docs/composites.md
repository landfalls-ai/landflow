# Composite nodes

Part of the [Landflow docs](README.md); the [feature map](README.md#feature-map) lists every feature page.

A **composite** is a canvas group typed by a contract. The contract (a **composite type**) names the steps the frame
must or may hold (its **slots**), the edges it shows when collapsed (its ports), the wiring and settings it insists on
(its rules), and how a run treats the frame as a whole. The frame's nodes are ordinary nodes the workflow owns. The type
is copied in once, as a starter graph, and from then on it is only *linked*: the editor checks the frame against it
while you edit, so a new version of a type never rewrites anyone's nodes.

- **Errors block Publish, warnings don't, and Save is never blocked.** A draft can be broken while you work on it.
- **Free nodes are allowed** (a member that fills no slot) unless the type is `closed`.
- **Slots can take nested composites**: a slot whose matcher names a composite type is filled by a frame of that type
  inside this one.

The code is `apps/web/src/lib/shared/composites.ts` (matching, checks, binding, instantiating and proposing types), the
editor's `components/editor/composite-*.tsx` and `composites.ts`, the host's `lib/server/composites.ts` and the
engine's scopes in `packages/engine/src/executor.ts`.

## Where types come from

| Source | Type names | How |
|---|---|---|
| A plugin's manifest | `<pluginId>.<name>` | `composites` in the manifest ([protocol.md §3](protocol.md#3-messages-json-shapes)); `defineComposite` in the TypeScript SDK, `PluginInfo.Composites` in Go, `Plugin(composites=[...])` in Python. Each SDK validates them like node descriptors |
| Landflow core | `core.aiStep` | the **AI step**: a reasoner (an AI action with a model input), its model, an optional memory and any number of tools, with each sub-node wired to the reasoner |
| The triage plugin | `triage.aiTriage` | **AI triage**: optional IOC extraction and enrichment, the reasoner and its model, and a locked **Triage Decision** with Open, Attach and Ask outputs. It fails open (enrichment and the reasoner have On error → Continue), every path reaches the decision, and the frame is sealed. The [alert triage and phishing flows](triage.md) are built on it |
| This instance's library | `local.<name>` | saved from a group (below) into `composite_types` (migration 1883), one row per version |

`GET /api/composites` lists them all, with each type's versions; a plugin's types stay listed (as unavailable) while
the plugin is offline, so frames typed by them still load. Explore in the [marketplace](marketplace.md) has a
**Composites** kind; a library type can be deleted there by whoever saved it, or by an owner or admin.

## The contract

A composite type (`CompositeTypeDescriptor` in `packages/protocol/src/types.ts`) has:

- **Slots**: `{ name, displayName, accepts, min?, max?, locked? }`. `min` defaults to 1 (0 makes the slot optional);
  `locked` nodes can be configured but not deleted or retyped.
- **Matchers** (`accepts`): any of `type`, `kind`, `supplies` (what a sub-node provides, `ai_languageModel`),
  `category`, `capability`, `input` (the node has an input of that connection type), `composite` (a nested frame of
  that type) and `anyOf`. Every field given must match, and a list matches any of its values. Matching reads the
  node's descriptor, so it works for any plugin's nodes.
- **Capabilities**: node descriptors carry `capabilities`, dotted tags such as `ioc.extract`, `ioc.enrich`,
  `ioc.lookup` or `llm.chain`. They are the stable thing a slot asks for, where `categories` only group the node
  creator. The triage and threat intel plugins tag their nodes.
- **Ports**: `inputs` name the slot that takes what comes in; `outputs` name a slot's node and output index. A
  collapsed composite draws its outputs as named handles.
- **Rules**: `feeds` (every node of slot `to` gets a `via` connection from slot `from`), `onError` (the nodes of
  these slots have this On error setting), `reaches` (everything the input reaches leads to slot `to`) and `sealed`
  (main connections leave only through the output ports and enter only at the input slots; a warning, not an error).
- **closed**: members outside the slots are errors.
- **Run behaviour** (optional): `onError: 'fallback'`, `timeoutSeconds` and `properties` (below).
- **starter**: the nodes and connections a new frame starts with, bound to their slots.

A frame is a group with `composite: { type, version, slots, params?, fallback? }` in `workflow.groups`: the type pinned
to a version, slot name → node ids (for a composite slot: nested group ids), the values of the type's properties and
where failures go. Saving prunes bindings to the frame's members and fallback targets to nodes that exist.

### Checks

`compositeReports()` checks every frame and returns its slots (what fills each, and whether that is enough), the rules,
the ports, the free members and the issues. Errors: an empty required slot, too many nodes, a node that doesn't match
its slot, a broken `feeds`, `onError` or `reaches` rule, a member of a closed type outside its slots, an unknown type or
version. Warnings: `sealed`, and a newer version of the type. Most issues carry a fix (set On error, unbind, use the
newer version).

The same checks run on the host: `publishVersion` refuses a version whose frames have errors (422 "This version breaks
a composite's contract, so it can't be published: …"), a template's problems list them with the kind `contract`
(they don't make it unusable; its page says "Fix before publishing"), and the editor assistant gets each frame's
contract in its context and a warning for an edit that introduces a new error (`validateOps`).

## In the editor

- **Insert**: the node creator's **Composites** section (on its first page and in search) drops a frame with the type's
  starter, every node bound to its slot, in one undo step. It lands in clear space: moved down past any node or frame it
  would cover, so it is never nested into a frame by accident.
- **The frame**: its header has the type's badge and a count of errors and warnings; clicking it opens the
  **contract panel**: the type and version (with "Check against v2" when a newer one is out), each slot with what fills
  it (unbind, **Add**), the members in no slot (**Bind to …**), the type's properties, where failures go (types that
  fall back), the rules, and the issues with their fixes. **Make plain group** keeps the nodes and drops the contract.
- **Empty required slots** show as dashed placeholders in the frame; clicking one opens the node creator filtered to
  what the slot accepts ("Add to Model"), and the chosen node joins the frame, is bound and is wired the way the
  type's `feeds` rules say.
- **Dropping a node into a frame** binds it to the slot it obviously fills (the only one with room that accepts it, else the
  only empty required one that does); otherwise it stays free. Dragging it out unbinds it.
- **Locked slots**: their nodes can't be deleted while the frame is typed.
- **Copy, paste and duplicate** keep the bindings on the copies.
- **Composite…** on a plain group's toolbar: **Use a type** types the group (members bind to the slots they obviously
  fill), and **New type from this group** proposes a type from it: one slot per node type in the group (exactly that
  type; a model or tool slot takes any), its outgoing connections as outputs, its sub-node wiring and fail-open nodes as
  rules. Name it, make slots optional, lock the ones it can't lose, choose **Closed**, and **Save type and use it**
  saves `local.<name>` (a name already saved gets the next version) and types the group.
- The Executions tab's canvas shows a composite's badge on its frame.

## In a run

The engine runs a frame's nodes like any others. A type that sets one of these makes the frame a **scope**: the host
passes the workflow's scopes to the engine (`ExecuteWorkflowOptions.scopes`, built by `compositeScopes()`).

- **`onError: 'fallback'`**: a node inside that fails (after its retries, without On error → Continue) stops the frame
  instead of the run. What is still queued inside the frame is dropped, and the items that entered the frame, with
  `error: { message, node, composite }` added, go to the frame's fallback targets (**On failure** in the contract
  panel: nodes outside the frame). The failed node's run says where it fell back to. With nested frames, the innermost
  one that falls back takes the failure.
- **`timeoutSeconds`**: checked when each node inside starts. Past it, that node fails with "… ran past its N s limit"
  (and the fallback applies). A node already running isn't interrupted.
- **`properties`**: the frame's settings, edited in the contract panel and read inside it as
  `$composite.params.<name>` (defaults from the type). `$composite.name` and `$composite.type` name the frame; outside a
  frame `$composite.params` is empty.

What entered a frame is saved with checkpoints and waits, so a resumed run still falls back with it.

## API

| Route | |
|---|---|
| `GET /api/composites` | `{ composites: CompositeTypeInfo[] }`: every type, the plugins' then the library's, each with `source` (`plugin` with its plugin, or `local` with who saved it), the newest `descriptor`, `versions` and `available` |
| `POST /api/composites` | `{ descriptor }` → 201 `{ composite }`: save a library type (`local.<name>`); a name already saved gets a new version. 400 with `details` for an invalid descriptor |
| `DELETE /api/composites/:type` | delete a library type, every version: whoever saved it, an owner or an admin (else 403); a plugin's type answers 400. Frames typed by it keep their nodes and show it as unknown |

Reading needs `workflows:read`, saving and deleting `workflows:write`.

## Not built

- A governance rule that requires a composite (for example "AI calls only inside an AI step"): see
  [limitations.md](limitations.md).
- The fallback is picked in the contract panel and isn't drawn as an edge on the canvas.
- Composite types aren't part of Git sync or environment promotion yet; a workflow that uses a `local.` type on another
  instance shows the type as unknown until it is saved there too.
