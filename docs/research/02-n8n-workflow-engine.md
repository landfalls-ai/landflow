# 02 — n8n workflow representation & execution engine (reference)

> Research target: **n8n 2.44.6** (Docker container `n8n`), packages `n8n-workflow@2.44.2`, `n8n-core@2.44.4`,
> `@n8n/api-types@1.44.3`, `@n8n/engine@0.24.1`, `@n8n/expression-runtime@0.35.0`, `@n8n/workflow-sdk@0.37.2`, `n8n-editor-ui@2.44.3`.
>
> Method: the Docker image ships stripped JS (no `.d.ts`, no `sourcesContent`). Type quotes below come from the
> **identical-version npm tarballs** (`n8n-workflow-2.44.2`, `n8n-core-2.44.4`, `@n8n/api-types-1.44.3`, `@n8n/engine-0.24.1`,
> `@n8n/workflow-sdk-0.37.2`, `@n8n/expression-runtime-0.35.0`); I verified that the compiled JS is byte-identical to the
> container's (`workflow-execute.js`, `workflow.js`).
> Runtime behaviour was read from the compiled JS (`n8n-core/dist/execution-engine/workflow-execute.js`,
> `n8n/dist/execution-lifecycle/execution-lifecycle-hooks.js`, `n8n/dist/push/*`, `n8n/dist/webhooks/*`, …) plus docs.n8n.io.
> Nothing in the container was modified.

---

## 0. TL;DR (design-relevant facts)

- A workflow is **`{ nodes: INode[], connections: IConnections, settings, pinData, … }`**. Connections are an
  **adjacency list keyed by source node *name*** → connection type (`main`, `ai_tool`, …) → **output index** → array of
  `{ node: <dest name>, type, index: <dest input index> }`. Node names are unique and are the primary key everywhere
  (connections, runData, pinData, `$('Name')` expressions). Renames rewrite all references.
- Data between nodes is **always an array of items** per output: `INodeExecutionData[][]` (outer = output index, inner =
  items). Each item is `{ json, binary?, pairedItem?, error? }`. A node runs **once per batch** of items (not once per
  item); expressions are evaluated per item index.
- An execution's full state is a single serializable object, `IRunExecutionData`: `resultData.runData` (per node → array of
  runs `ITaskData[]`), `executionData.nodeExecutionStack` (ready queue), `executionData.waitingExecution` (partially filled
  input slots of multi-input nodes). Because it's all JSON, executions can be **paused (Wait node), persisted, resumed and
  partially re-run**.
- The run loop (`WorkflowExecute.processRunExecutionData`) is a **work-list scheduler**: pop stack head → run node (with
  retry) → write `ITaskData` → for each output with ≥1 item, enqueue children (`unshift` = depth-first in v1, `push` =
  breadth-first in legacy v0). Multi-input nodes accumulate inputs in `waitingExecution` and are enqueued when all inputs are
  filled, or — when the stack drains — flushed with whatever arrived (respecting `requiredInputs`).
- **Empty output ⇒ downstream does not run** (unless `alwaysOutputData`). IF/Switch routing is literally "which output
  array got the items".
- Lifecycle hooks `workflowExecuteBefore/After`, `nodeExecuteBefore/After` are pushed to the editor over **WebSocket
  (default, `/rest/push?pushRef=…`) or SSE** as `{type, data}` JSON: `executionStarted`, `nodeExecuteBefore`,
  `nodeExecuteAfter` (metadata + item counts, no data), `nodeExecuteAfterData` (full data, binary frame),
  `executionFinished`/`executionWaiting`, each node event carrying a monotonically increasing `sequenceNumber`.

---

## 1. Workflow JSON format

### 1.1 `IWorkflowBase` (n8n-workflow `dist/esm/interfaces.d.ts`)

```ts
export interface IWorkflowBase {
    id: string;
    name: string;
    description?: string | null;
    active: boolean;
    isArchived: boolean;
    createdAt: Date;
    startedAt?: Date;
    updatedAt: Date;
    nodes: INode[];
    connections: IConnections;
    settings?: IWorkflowSettings;
    staticData?: IDataObject;          // per-workflow persistent KV (poll cursors, etc.)
    pinData?: IPinData;
    versionId?: string;                // draft version
    activeVersionId: string | null;    // the *published* version that triggers run (2.x draft/publish model)
    activeVersion?: IWorkflowHistory | null;
    versionCounter?: number;
    meta?: WorkflowFEMeta;             // { onboardingId?, templateId?, instanceId?, templateCredsSetupCompleted? }
    nodeGroups?: IWorkflowGroup[];     // { id, name, nodeIds: string[], description? }
}

export interface IWorkflowSettings {
    timezone?: 'DEFAULT' | string;
    errorWorkflow?: 'DEFAULT' | string;          // id of a workflow starting with Error Trigger
    callerIds?: string;
    callerPolicy?: 'any' | 'none' | 'workflowsFromAList' | 'workflowsFromSameOwner';
    saveDataErrorExecution?: 'DEFAULT' | 'all' | 'none';
    saveDataSuccessExecution?: 'DEFAULT' | 'all' | 'none';
    saveManualExecutions?: 'DEFAULT' | boolean;
    saveExecutionProgress?: 'DEFAULT' | boolean; // persist after every node (resumable after crash)
    executionTimeout?: number;
    executionOrder?: 'v0' | 'v1';
    engineType?: 'v1' | 'v2';                    // v2 = the new @n8n/engine (see §7)
    binaryMode?: WorkflowSettingsBinaryMode;
    timeSavedPerExecution?: number;
    timeSavedMode?: 'fixed' | 'dynamic';
    availableInMCP?: boolean;
    credentialResolverId?: string;
    redactionPolicy?: 'none' | 'all' | 'non-manual' | 'manual-only';
    customTelemetryTags?: ICustomTelemetryTag[];
}
```

Note the 2.x **draft vs published** split: `nodes/connections` on the workflow row are the editable draft; triggers run
`activeVersion.nodes/connections` (`ActiveWorkflowManager` copies `dbWorkflow.activeVersion` into the `Workflow` it
activates). Public API has `POST /workflows/{id}/publish|unpublish` alongside `activate|deactivate`, plus
`/workflows/{id}/history` and `/versions/{versionId}`.

### 1.2 `INode`

```ts
export type OnError = 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow';
export interface INode {
    id: string;                       // UUID, stable across renames
    name: string;                     // unique within workflow; used as the key in connections/runData/pinData
    typeVersion: number;              // e.g. 2.2 — node types are versioned; parameters are interpreted per version
    type: string;                     // "<package>.<nodeName>", e.g. "n8n-nodes-base.if"
    position: [number, number];       // canvas x,y — ALSO affects v1 execution order (top→bottom, left→right)
    disabled?: boolean;               // pass-through (see §3.6)
    notes?: string;
    notesInFlow?: boolean;            // show note under node on canvas
    retryOnFail?: boolean;
    maxTries?: number;                // clamped to [2,5], default 3
    waitBetweenTries?: number;        // ms, clamped to [0,5000], default 1000
    alwaysOutputData?: boolean;       // emit one empty item if output is empty
    executeOnce?: boolean;            // only the first item of each input is passed in
    onError?: OnError;                // replaces legacy continueOnFail
    continueOnFail?: boolean;         // legacy == onError:'continueRegularOutput'
    customTelemetryTags?: { tag?: ICustomTelemetryTag[] };
    parameters: INodeParameters;      // free-form, defined by node type's `properties`; strings starting with "=" are expressions
    credentials?: INodeCredentials;   // { [credentialType]: { id: string | null, name: string } }
    webhookId?: string;               // UUID used as default webhook path
    extendsCredential?: string;
    rewireOutputLogTo?: NodeConnectionType;
    forceCustomOperation?: { resource: string; operation: string };
}
export interface IPinData { [nodeName: string]: INodeExecutionData[]; }
```

### 1.3 `IConnections`

```ts
export interface IConnection {
    node: string;               // DESTINATION node name
    type: NodeConnectionType;   // destination input type
    index: number;              // DESTINATION input index
}
export type NodeInputConnections = Array<IConnection[] | null>;   // indexed by SOURCE output index
export interface INodeConnections { [key: string]: NodeInputConnections; }  // keyed by connection type
export interface IConnections   { [key: string]: INodeConnections; }        // keyed by SOURCE node name

export declare const NodeConnectionTypes: {
    readonly AiAgent: 'ai_agent'; readonly AiChain: 'ai_chain'; readonly AiDocument: 'ai_document';
    readonly AiEmbedding: 'ai_embedding'; readonly AiLanguageModel: 'ai_languageModel'; readonly AiMemory: 'ai_memory';
    readonly AiOutputParser: 'ai_outputParser'; readonly AiRetriever: 'ai_retriever'; readonly AiReranker: 'ai_reranker';
    readonly AiTextSplitter: 'ai_textSplitter'; readonly AiTool: 'ai_tool'; readonly AiVectorStore: 'ai_vectorStore';
    readonly Main: 'main';
};
```

So `connections[src][type][outputIndex] = [{node: dst, type, index: dstInputIndex}, …]`. One output can fan out to many
inputs; one input can receive from many outputs (items are **not** merged automatically — the node runs once per arriving
batch unless it's a multi-input node). The `Workflow` class precomputes the reverse map
(`connectionsByDestinationNode = mapConnectionsByDestination(connectionsBySourceNode)`).

**AI "sub-node" connections run the other way semantically:** e.g. an `OpenAI Chat Model` node connects
`connections["OpenAI Chat Model"].ai_languageModel = [[{node:"AI Agent", type:"ai_languageModel", index:0}]]`. Sub-nodes are
*not* placed on the execution stack; the root node pulls them via `getInputConnectionData()` → `supplyData()`, or (newer) by
returning an `EngineRequest` asking the engine to run tool nodes (see §3.9).

### 1.4 Node type side: inputs/outputs are declared by the type, not the instance

```ts
export interface INodeTypeDescription extends INodeTypeBaseDescription {
    version: number | number[];
    defaults: NodeDefaults;                                   // { name, color }
    inputs: Array<NodeConnectionType | INodeInputConfiguration> | ExpressionString;   // can be dynamic: "={{ … }}"
    requiredInputs?: string | number[] | number;              // used by v1 when flushing partial inputs
    inputNames?: string[];
    outputs: Array<NodeConnectionType | INodeOutputConfiguration> | ExpressionString;
    outputNames?: string[];                                   // e.g. IF: ['true','false']
    properties: INodeProperties[];                            // parameter schema → drives the NDV form
    credentials?: INodeCredentialDescription[];
    polling?: true; webhooks?: IWebhookDescription[]; triggerPanel?: TriggerPanelDefinition | boolean;
    requestDefaults?: …; requestOperations?: …;               // declarative (no-code) HTTP nodes
    hints?: NodeHint[]; builderHint?: IBuilderHint; sensitiveOutputFields?: string[]; …
}
export interface INodeOutputConfiguration { category?: 'error'; displayName?: string; maxConnections?: number;
    required?: boolean; type: NodeConnectionType; filter?: INodeFilter; }
export type ExpressionString = `={{${string}}}`;

export interface INodeType {
    description: INodeTypeDescription;
    execute?(this: IExecuteFunctions, response?: EngineResponse): Promise<NodeOutput>;
    poll?(this: IPollFunctions): Promise<INodeExecutionData[][] | null>;
    trigger?(this: ITriggerFunctions): Promise<ITriggerResponse | undefined>;
    webhook?(this: IWebhookFunctions): Promise<IWebhookResponseData>;
    supplyData?(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData>;   // AI sub-nodes
    methods?: { loadOptions?, listSearch?, credentialTest?, resourceMapping?, … };    // editor-time RPCs
    webhookMethods?: { [name in WebhookType]?: { checkExists, create, delete } };     // register remote webhooks on activate
    customOperations?: …;
}
export type NodeOutput = INodeExecutionData[][] | NodeExecutionWithMetadata[][] | EngineRequest | null;
```

Real example: IF v2 declares `inputs: ['main']`, `outputs: ['main','main']`, `outputNames: ['true','false']`. Merge v3
declares `inputs: "={{(configuredInputs)($parameter)}}"` (dynamic count) and
`requiredInputs: '={{ $parameter["mode"] === "chooseBranch" ? [0, 1] : 1 }}'`. When a node's `onError` is
`continueErrorOutput`, `NodeHelpers.getNodeOutputs` **appends** an output `{category:'error', type:'main', displayName:'Error'}`
(and renames a single existing output to "Success"), so the error branch is just another output index in `connections`.

### 1.5 Example exported workflow (trigger → IF → two branches)

Shape is exactly what "Download"/copy-paste produces in 2.x (node types/versions taken from the installed
`n8n-nodes-base`: manualTrigger v1, if v2.2 (default 2.4), set v3.4 (default 3.5); IF filter-parameter shape from IfV2's
`builderHint`). Pin data on the trigger supplies two sample items so the IF routes one item to each branch.

```json
{
  "name": "Order router",
  "nodes": [
    {
      "parameters": {},
      "id": "0f5a6c1e-6b1d-4a52-9d0a-3c8f0d0b9a11",
      "name": "When clicking ‘Execute workflow’",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0]
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict", "version": 2 },
          "conditions": [
            {
              "id": "b3c0e5d2-8a51-4f7e-a0a5-1f0f8f2b6c01",
              "leftValue": "={{ $json.amount }}",
              "rightValue": 100,
              "operator": { "type": "number", "operation": "gt" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "5c2b8f4e-2f0e-4d7c-9a1b-7e3d2c1b0a99",
      "name": "Amount > 100?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [220, 0]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            { "id": "a1", "name": "tier", "value": "high", "type": "string" },
            { "id": "a2", "name": "note", "value": "=Review order {{ $json.orderId }} manually", "type": "string" }
          ]
        },
        "includeOtherFields": true,
        "options": {}
      },
      "id": "9d1e7a3b-4c5f-4e8a-b2d6-0c9f8e7d6a55",
      "name": "Flag high value",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [440, -100]
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [{ "id": "b1", "name": "tier", "value": "standard", "type": "string" }]
        },
        "includeOtherFields": true,
        "options": {}
      },
      "id": "e4f3a2b1-0c9d-4e8f-a7b6-5c4d3e2f1a00",
      "name": "Standard",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [440, 100],
      "retryOnFail": true,
      "maxTries": 3,
      "waitBetweenTries": 1000,
      "notes": "Fallback branch",
      "notesInFlow": true
    }
  ],
  "connections": {
    "When clicking ‘Execute workflow’": {
      "main": [[{ "node": "Amount > 100?", "type": "main", "index": 0 }]]
    },
    "Amount > 100?": {
      "main": [
        [{ "node": "Flag high value", "type": "main", "index": 0 }],
        [{ "node": "Standard", "type": "main", "index": 0 }]
      ]
    }
  },
  "pinData": {
    "When clicking ‘Execute workflow’": [
      { "json": { "orderId": "A-1001", "amount": 250 } },
      { "json": { "orderId": "A-1002", "amount": 40 } }
    ]
  },
  "settings": { "executionOrder": "v1" },
  "active": false,
  "versionId": "7a0c1d2e-3f4a-5b6c-7d8e-9f0a1b2c3d4e",
  "meta": { "templateCredsSetupCompleted": true, "instanceId": "…" },
  "id": "Xq3vKp0aB1cD2eF3",
  "tags": []
}
```

Output index 0 of `Amount > 100?` is the `true` branch, index 1 the `false` branch (`outputNames`). Copy/paste of a
selection on the canvas uses the same `{ nodes, connections, pinData?, meta? }` subset.

---

## 2. Data model between nodes

### 2.1 Items

```ts
export interface INodeExecutionData {
    [key: string]: …;
    /** JSON output. In `continueErrorOutput` mode, engine will try to read item.error or fallback to item.json.error … */
    json: IDataObject;
    binary?: IBinaryKeyData;                       // { [propertyName e.g. "data"]: IBinaryData }
    error?: NodeApiError | NodeOperationError;
    pairedItem?: IPairedItemData | IPairedItemData[] | number;   // lineage → which input item(s) produced this item
    metadata?: { subExecution: RelatedExecution };
    evaluationData?: Record<string, GenericValue>;
    redaction?: INodeExecutionRedactionInfo;
    sendMessage?: ChatNodeMessage;                 // chat-triggered workflows
    /** @deprecated */ index?: number;
}
export interface IPairedItemData { item: number; input?: number; sourceOverwrite?: ISourceData; }
export interface IBinaryData {
    data: string;              // base64, or a storage reference when `id` is set (filesystem/S3/DB binary modes)
    mimeType: string; fileType?: 'text'|'json'|'image'|'audio'|'video'|'pdf'|'html';
    fileName?: string; directory?: string; fileExtension?: string; fileSize?: string; bytes?: number; id?: string;
}
```

- A node receives `inputData: ITaskDataConnections` = `{ main: [ items_of_input0, items_of_input1, … ] }` and returns
  `INodeExecutionData[][]` = one array per output.
- **Paired items** are the lineage that powers `$('Some Node').item` and the editor's input/output hover-highlighting. The
  engine auto-assigns `pairedItem` when unambiguous (`assignPairedItems`: 1 in → 1 out; N in → N out; N in → 1 out ⇒ item 0),
  otherwise the node must set it. Before running a node, `addPairedItemLineage` stamps each input item with
  `{item: itemIndex, input: inputIndex}`.
- Error items: `normalizeNodeErrors` turns `item.error` into `json = { error: message }`.

### 2.2 Per-node run records

```ts
/** The data that gets returned when a node execution starts */
export interface ITaskStartedData {
    startTime: number;
    /** This index tracks the order in which nodes are executed */
    executionIndex: number;
    source: Array<ISourceData | null>;     // which upstream node/output/run fed each input
    hints?: NodeExecutionHint[];
}
/** The data that gets returned when a node execution ends */
export interface ITaskData extends ITaskStartedData {
    executionTime: number;
    executionStatus?: ExecutionStatus;     // 'canceled'|'crashed'|'error'|'new'|'running'|'success'|'unknown'|'waiting'
    data?: ITaskDataConnections;           // { main: INodeExecutionData[][] }  ← the node's OUTPUT
    inputOverride?: ITaskDataConnections;  // used for AI sub-nodes to log their input
    error?: ExecutionError;
    redactedError?: IRedactedErrorInfo;
    metadata?: ITaskMetadata;              // subRun, parentExecution, subExecution, resumeUrl, tokenUsage, tracing, …
    usedDynamicCredentials?: boolean; attemptedDynamicCredentials?: boolean;
}
export interface ISourceData { previousNode: string; previousNodeOutput?: number; previousNodeRun?: number; }
export interface IRunData { [nodeName: string]: ITaskData[]; }          // array index == runIndex
export interface ITaskDataConnections { [key: string]: Array<INodeExecutionData[] | null>; }
```

A node that executes multiple times (loops, or once per arriving batch from multiple parents) gets multiple `ITaskData`
entries — the editor's "run selector" (Run 1 of 3) is literally `runData[node][runIndex]`. **Inputs are not stored**; the
UI reconstructs a node's input from `source` → upstream node's `runData[prev][previousNodeRun].data.main[previousNodeOutput]`.

### 2.3 Whole-execution state

```ts
// run-execution-data.v1.d.ts  (IRunExecutionData = IRunExecutionDataV1 & brand; build via createRunExecutionData())
export interface IRunExecutionDataV1 {
    version: 1;
    startData?: {
        startNodes?: StartNodeData[];            // { name, sourceData: ISourceData | null }
        destinationNode?: IDestinationNode;      // { nodeName, mode: 'inclusive' | 'exclusive' }  ("execute up to here")
        originalDestinationNode?: IDestinationNode;
        runNodeFilter?: string[];                // only these nodes may run (partial executions)
    };
    resultData: {
        error?: ExecutionError;
        redactedError?: IRedactedErrorInfo;
        runData: IRunData;
        pinData?: IPinData;
        lastNodeExecuted?: string;
        metadata?: Record<string, string>;       // $execution.customData
    };
    executionData?: {
        contextData: IExecuteContextData;
        runtimeData?: IExecutionContext;
        nodeExecutionStack: IExecuteData[];      // READY QUEUE
        metadata: { [key: string]: ITaskMetadata[] };
        waitingExecution: IWaitingForExecution;  // partially-filled inputs of multi-input nodes
        waitingExecutionSource: IWaitingForExecutionSource | null;
    };
    parentExecution?: RelatedExecution;          // sub-workflow → parent link
    subWorkflowOutput?: SubWorkflowOutputPolicy;
    parentAgentRun?: RelatedAgentRun;
    resumeToken?: string;                        // validates webhook/form resume requests
    waitTill?: Date;                             // set by Wait node etc. → execution status 'waiting'
    waitReason?: 'suspended';
    pushRef?: string;                            // which editor tab gets live push events
    manualData?: Pick<IWorkflowExecutionDataProcess, 'dirtyNodeNames' | 'triggerToStartFrom' | 'userId' | …>;
    redactionInfo?: RedactionInfo;
}
export interface IExecuteData {                  // one stack entry
    data: ITaskDataConnections;                  // input items per input index
    metadata?: ITaskMetadata;
    node: INode;
    source: ITaskDataConnectionsSource | null;   // { main: Array<ISourceData | null> }
    runIndex?: number;
}
export interface IWaitingForExecution {          // nodeName → waitingRunIndex → { main: [input0 | null, input1 | null, …] }
    [key: string]: { [key: number]: ITaskDataConnections };
}

export interface IRun {                          // what an execution resolves to / gets stored as
    data: IRunExecutionData;
    mode: WorkflowExecuteMode;  // 'cli'|'error'|'integrated'|'internal'|'manual'|'retry'|'trigger'|'webhook'|'evaluation'|'chat'|'agent'
    waitTill?: Date | null; startedAt: Date; stoppedAt?: Date;
    storedAt: 'db' | 'fs' | 's3' | 'az';
    status: ExecutionStatus;
    jobId?: string;                              // scaling (queue) mode
}
```

### 2.4 Pin data

- `pinData: { [nodeName]: INodeExecutionData[] }` saved on the workflow. In `WorkflowExecute.getPinnedOutput`, if a node
  has pin data (and isn't disabled) the engine **skips calling the node** and uses `[pinData[node]]` as its output (output 0
  only), still emitting before/after hooks.
- Pin data is applied **only in `manual` and `evaluation` modes** (`webhook-helpers.prepareExecutionData`:
  `const usePinData = ['manual','evaluation'].includes(executionMode)`), never in production trigger runs.
- Pinned nodes count as "not dirty" for partial executions; a pinned trigger means "Execute workflow" doesn't need to
  wait for a real test event.

---

## 3. Execution algorithm (`n8n-core` `WorkflowExecute`)

```ts
export declare class WorkflowExecute {
    constructor(additionalData: IWorkflowExecuteAdditionalData, mode: WorkflowExecuteMode,
                runExecutionData?: IRunExecutionData, storedAt?: ExecutionStorageLocation);
    run({ workflow, startNode, destinationNode, pinData, triggerToStartFrom, additionalRunFilterNodes }): PCancelable<IRun>;
    runPartialWorkflow2(workflow, runData, pinData, dirtyNodeNames, destinationNode, agentRequest?): PCancelable<IRun>;
    processRunExecutionData(workflow: Workflow): PCancelable<IRun>;   // the loop; also used to RESUME a saved execution
    runNode(workflow, executionData: IExecuteData, runExecutionData, runIndex, additionalData, mode,
            abortSignal?, subNodeExecutionResults?): Promise<IRunNodeResponse | EngineRequest>;
    addNodeToBeExecuted(workflow, connectionData: IConnection, outputIndex, parentNodeName,
                        nodeSuccessData: INodeExecutionData[][], runIndex, newRunIndex?, metadata?): void;
    checkReadyForExecution(workflow, { startNode?, destinationNode?, pinDataNodeNames? }): IWorkflowIssues | null;
    suspend(): void;  …
}
```

### 3.1 Choosing the start node / seeding the stack

Every execution starts with a seeded `nodeExecutionStack`; there is no separate "trigger phase" in the loop.

- **Production trigger/poll/webhook**: the server builds `nodeExecutionStack = [{ node: triggerNode, data: { main: emittedItems }, source: null }]`
  (`WorkflowExecutionService.runWorkflow`, `webhook-helpers.prepareExecutionData`) and calls `processRunExecutionData`.
  When the loop "runs" a trigger/poll/webhook node in non-manual mode, `runNode` simply returns `{ data: inputData.main }` —
  the trigger node *passes through* the payload it emitted. Elegant: triggers appear in runData like any node.
- **Manual "Execute workflow"** (`ManualExecutionService.runManually` → `WorkflowExecute.run`):
  `startNode = startNode || workflow.getStartNode(destinationNode?.nodeName)` and the stack is seeded with
  `{ node: startNode, data: triggerToStartFrom?.data?.data ?? { main: [[{ json: {} }]] }, source: null }`.
  `Workflow.getStartNode(dest?)`: if a destination is given, compute its highest ancestors (`getHighestNode`) and pick
  among them; else consider all nodes. `__getStartNode(names)`: (1) a single candidate that isn't disabled wins;
  (2) first non-disabled node whose type has `trigger` or `poll` (skipping the manual chat trigger);
  (3) else first non-disabled node of `STARTING_NODE_TYPES` = `[manualTrigger, executeWorkflowTrigger, errorTrigger,
  evaluationTrigger, formTrigger]`.
  For a **manual-mode trigger node**, `executeTriggerNode` actually calls `nodeType.trigger()` and awaits
  `manualTriggerFunction()` / `manualTriggerResponse` (the Manual Trigger just `emit([[{json:{}}]])`; the Schedule Trigger
  emits one item with timestamp fields; a webhook trigger instead goes through the *test webhook* flow, §4.3).
- **Partial execution** ("Execute step" on a node with prior run data, `runPartialWorkflow2`): build a `DirectedGraph`,
  find the trigger (`findTriggerForPartialExecution`), `filterDisabledNodes`, `findSubgraph(trigger → destination)`,
  `cleanRunData` for dirty nodes, then `findStartNodes`: walk from the trigger along edges that carry data; a node is a start
  node if it is **dirty** (no runData and no pinData, or its last run errored) or is the destination. `handleCycles` moves
  start nodes inside a loop to the loop entry. `recreateNodeExecutionStack` rebuilds `nodeExecutionStack` +
  `waitingExecution` from the *existing* runData of the parents, so only the needed part re-runs. `runNodeFilter` restricts
  execution to the subgraph. (The editor sends `{ runData, destinationNode, dirtyNodeNames, triggerToStartFrom }` to
  `POST /rest/workflows/:id/run`.)

### 3.2 The loop (`processRunExecutionData`, condensed from the compiled JS)

```text
initializeExecution: acquire expression isolate; establishExecutionContext;
                     hooks.workflowExecuteBefore(workflow, runExecutionData)   (or workflowExecuteResume)
checkForWorkflowIssues: validate parameters of all nodes reachable from start (or parents of destination) → WorkflowHasIssuesError

while nodeExecutionStack not empty:
    if timed out / canceled → stop;   if suspend requested → waitTill=now, waitReason='suspended', return
    executionData = stack.shift()                             # ALWAYS pop from the FRONT
    taskStarted = { startTime, executionIndex: counter++, source: executionData.source.main, hints: [] }
    executionData.data = addPairedItemLineage(executionData)
    runIndex = executionData.runIndex ?? runData[node].length
    guard: if `${node}:${runIndex}` == last try → "Stopped execution because it seems to be in an endless loop"
    if node not in runNodeFilter → continue
    if !ensureInputData(...) → (re-push to END of stack) continue    # v0: all inputs must be present
    hooks.nodeExecuteBefore(nodeName, taskStarted)            # (skipped if metadata.nodeWasResumed)

    [maxTries, wait] = retryOnFail ? [clamp(maxTries||3, 2, 5), clamp(waitBetweenTries||1000, 0, 5000)] : [1, 0]
    for try in 0..maxTries-1:
        try:
            out = pinData[node] ? [pinData[node]] : await runNode(...)
            (also re-runs while out[0][0].json.error is truthy and tries remain)
            if out is EngineRequest → enqueue requested (tool) nodes, continue loop
            out = convertBinaryData(out); if onError=='continueErrorOutput' → handleNodeErrorOutput (split error items to last output)
            out = assignPairedItems(out); lastNodeExecuted = node
            out = ensureAlwaysOutputData(out)                 # alwaysOutputData → [[{json:{}, pairedItem:[all inputs]}]]
            if out === null && !waitTill → continue loop       # node produced nothing: no runData entry, no children
            break
        catch e: executionError = e
    taskData = { ...taskStarted, executionTime, metadata, executionStatus: waitTill ? 'waiting' : 'success' }
    if executionError:
        taskData.error = …; status='error'
        if continueOnFail || onError in (continueRegularOutput, continueErrorOutput):
            out = [input.main[0]]  (pass the input items through on output 0)   → continue normally
        else: store taskData, re-push executionData to FRONT, hooks.nodeExecuteAfter(...), BREAK (workflow fails)
    taskData.data = { main: out };  runData[node][runIndex] = taskData
    if waitTill (Wait node / send-and-wait / form): nodeExecuteAfter; re-push to FRONT; BREAK  → status 'waiting', persisted
    if node == startData.destinationNode: nodeExecuteAfter; continue      # don't schedule children
    for outputIndex, conns in connectionsBySourceNode[node].main:
        for conn in conns:
            if out[outputIndex] has items (v0 also: or conn.index > 0):
                v1: collect {position: child.position, conn, outputIndex}
                v0: addNodeToBeExecuted(conn, outputIndex, node, out, runIndex)
    v1: sort collected children by position (y DESC, then x DESC) and addNodeToBeExecuted each   # see 3.4
    hooks.nodeExecuteAfter(nodeName, taskData, runExecutionData)
    if stack empty and waitingExecution not empty: flush one waiting multi-input node (3.3)

processSuccessExecution: status = error | waiting | success | canceled; moveNodeMetadata;
                         hooks.workflowExecuteAfter(fullRunData, newStaticData); release isolate
```

Notes:
- `runNode` order of dispatch: `metadata.resumeError` (sub-workflow failed while parent waited) → **disabled** →
  `prepareConnectionInputData` (returns `null` ⇒ node skipped when it got no items) → `executeOnce` slicing →
  `execute`/`customOperation` (regular nodes, via `ExecuteContext`) → `poll` / `trigger` (manual mode runs them, other modes
  pass through) → `webhook` (pass through) → declarative `RoutingNode` (HTTP described in JSON).
- Node implementations receive **all items** and loop themselves (`this.getInputData()`, `this.getNodeParameter(name, i)`);
  this is why expressions are evaluated per item index.
- `closeFunction`s (from triggers) run at the end; cancellation (`PCancelable.cancel()`) aborts an `AbortController`
  passed to nodes, marks running tasks `canceled` and fires `workflowExecuteAfter`.
- Execution timeout: `additionalData.executionTimeoutTimestamp` checked between nodes ⇒ `TimeoutExecutionCancelledError`.

### 3.3 Multi-input nodes (Merge etc.) and `waitingExecution`

`addNodeToBeExecuted(conn, outputIndex, parent, out, runIndex)`:

1. `numberOfInputs = connectionsByDestinationNode[dest].main.length` — counts **connected** input slots.
2. If `numberOfInputs <= 1`: push a stack entry `{ node: dest, data: { main: [..., out[outputIndex] at conn.index] },
   source: { main: [{ previousNode: parent, previousNodeOutput, previousNodeRun: runIndex }] }, runIndex: newRunIndex }`.
3. If `> 1`: find the first waiting "run slot" `waitingExecution[dest][k]` whose `main[conn.index]` is still empty (else
   create slot `k = count` with `main = [null, null, …]`), write `out[outputIndex]` into `main[conn.index]` and its source
   into `waitingExecutionSource`. If **every** input slot is now non-null → move the slot to the stack (`unshift` in v1,
   `push` in v0) and delete it. Otherwise it stays waiting.
   - **v0 only**: when a multi-input node first starts waiting, the engine proactively walks *other* parents that haven't
     run and enqueues their highest un-run ancestor with a dummy `[{json:{}}]` item ("force input node execution") so the
     merge eventually gets all inputs. v1 removed this (branches that aren't triggered simply don't run).
4. **Drain-time flush** (end of each loop iteration): if the stack is empty but nodes are still waiting, iterate waiting
   nodes; skip if any parent is itself waiting; in v1, evaluate `nodeType.description.requiredInputs` (number or index
   list, may be an expression) and skip if requirements aren't met. Otherwise turn `null` inputs into `[]`, pad to the
   declared input count, and push the node with the partial data — **if at least one input has items**. This is how "Merge
   with one branch empty" still runs in v1 (unless mode = chooseBranch which requires `[0, 1]`).
5. In v0 `ensureInputData` additionally re-queues a node at the back of the stack while any of its inputs is `null`;
   `prepareConnectionInputData` in v1 uses the first non-empty input as the "current items" for parameter resolution.

### 3.4 Execution order v0 vs v1 ("depth-first by branch")

| aspect | v0 (legacy, pre-1.0 workflows) | v1 (default since 1.0) |
|---|---|---|
| enqueue children | `push` (FIFO) ⇒ breadth-first: "first node of each branch, then the second node of each branch…" | `unshift` (LIFO) ⇒ depth-first: "executes each branch in turn, completing one branch before starting another" |
| sibling order | connection order | sorted by **canvas position**: top→bottom, ties left→right (children sorted y DESC/x DESC then each unshifted, so the top-most ends up at the head) |
| empty outputs | child enqueued if `conn.index > 0` even with 0 items | child enqueued only if output has ≥1 item |
| Merge inputs | forces execution of un-run parent branches; waits for all inputs | no forcing; flushes partial inputs when stack drains, honouring `requiredInputs` |

`isLegacyExecutionOrder(workflow) = workflow.settings.executionOrder !== 'v1'` — note a *missing* setting means legacy;
new workflows are saved with `"executionOrder": "v1"`.

### 3.5 Loops

Cycles are allowed (e.g. `Loop Over Items`/`SplitInBatches` output "loop" wired back to its input). Each re-entry gets a
new `runIndex` (`runData[node].length`). The only guard is "same node + same runIndex popped twice in a row". Partial
executions use strongly-connected components to restart a loop from its entry.

### 3.6 Disabled nodes

`handleDisabledNode(inputData)`: returns `{ data: [inputData.main[0]] }` — **input 0 is passed through to output 0**,
other inputs/outputs are dropped (with `metadata.forwardAllOutputs` — used when a waiting webhook resumes — all branches are
forwarded). If input 0 is `null` the node produces nothing. Disabled nodes still appear in runData. `getHighestNode`,
`__getStartNode`, partial-execution graphs (`filterDisabledNodes`) and parameter validation all skip disabled nodes.

### 3.7 Errors

- Per node `onError` (`continueOnFail` legacy):
  - `stopWorkflow` (default): `taskData.error` set, stack entry put back, `nodeExecuteAfter` emitted, loop breaks,
    `resultData.error` + `lastNodeExecuted` set, execution status `error`, then the **error workflow** (settings
    `errorWorkflow`, must start with Error Trigger) is invoked by the server with
    `{ execution: { id, url, retryOf, error: {message, stack}, lastNodeExecuted, mode }, workflow: { id, name } }`.
  - `continueRegularOutput`: thrown error ⇒ input items 0 pass through on output 0; nodes that support it emit
    `{ json: { error } }` items themselves (`this.continueOnFail()`).
  - `continueErrorOutput`: node gets an extra last output "Error". After the node runs, `handleNodeErrorOutput` moves every
    item with `item.error` or `json.error` (with only `error|message|details` keys) to the error output, merging the
    paired *input* item's json so downstream has context. A thrown error ⇒ inputs pass through (to output 0).
- `Stop and Error` node throws deliberately. AI tool nodes default to continue (error text returned to the agent).
- Retries (`retryOnFail`, `maxTries`, `waitBetweenTries`) wrap only `runNode` — before/after hooks fire once per node run,
  not per try.
- Executions can be retried from the UI/API (`POST /executions/{id}/retry`): mode `retry`, `retryOf` links them; it
  resumes from the saved `IRunExecutionData` (failed node re-runs).

### 3.8 Waiting / resuming

A node sets `runExecutionData.waitTill` (Wait node, Form, "send and wait for response", `putExecutionToWait`). The loop
stores the task as `executionStatus: 'waiting'`, puts the node back at the head of the stack and stops; the server
persists the execution with status `waiting` and pushes `executionWaiting`. Resume happens via `WaitTracker` (time-based)
or `/webhook-waiting/:executionId` / `/form-waiting/…` (signed with `resumeToken`; exposed as `$execution.resumeUrl`).
On resume `handleWaitingState` marks the head node **disabled** (so it passes its input/webhook data through) and pops its
duplicate runData entry, then `processRunExecutionData` continues. Sub-workflows that wait park the parent the same way.

### 3.9 Sub-workflows & AI engine requests

- `Execute Workflow` node runs another workflow (by id / JSON / URL) whose `Execute Workflow Trigger` ("When Executed by
  Another Workflow") defines inputs (fields / JSON example / accept all). The last node's output returns to the caller
  (`ExecuteWorkflowData.data: Array<INodeExecutionData[] | null>`). `metadata.subExecution` / `parentExecution` link
  executions both ways; `callerPolicy` restricts who may call.
- New AI flow: a node's `execute()` may return `EngineRequest { actions: [{ actionType: 'ExecutionNodeAction', nodeName,
  input, type, id, metadata }], metadata }`. The loop (`handleEngineRequest`) enqueues the requested (tool) nodes, then
  re-runs the requesting node with `EngineResponse { actionResponses: [{ action, data: ITaskData }], metadata }`. This
  turns agent tool calls into first-class, visible node runs.

### 3.10 Lifecycle hooks → live UI push

Hook registry (n8n-core `execution-lifecycle-hooks.d.ts`):

```ts
export type ExecutionLifecycleHookHandlers = {
    nodeExecuteBefore:     Array<(this: ExecutionLifecycleHooks, nodeName: string, data: ITaskStartedData) => Promise<void> | void>;
    nodeExecuteAfter:      Array<(this: ExecutionLifecycleHooks, nodeName: string, data: ITaskData, executionData: IRunExecutionData) => Promise<void> | void>;
    workflowExecuteBefore: Array<(this: ExecutionLifecycleHooks, workflow: Workflow, data?: IRunExecutionData) => Promise<void> | void>;
    workflowExecuteResume: Array<(this: ExecutionLifecycleHooks, workflow: Workflow, data: IRunExecutionData) => Promise<void> | void>;
    workflowExecuteAfter:  Array<(this: ExecutionLifecycleHooks, data: IRun, newStaticData: IDataObject) => Promise<void> | void>;
    sendResponse:          Array<(this: ExecutionLifecycleHooks, response: IExecuteResponsePromiseData) => Promise<void> | void>;  // webhook "respond" data
    sendChunk:             Array<(this: ExecutionLifecycleHooks, chunk: StructuredChunk) => Promise<void> | void>;               // streaming responses
    nodeFetchedData:       Array<(this: ExecutionLifecycleHooks, workflowId: string, node: INode) => Promise<void> | void>;
};
export declare class ExecutionLifecycleHooks {
    readonly mode: WorkflowExecuteMode; readonly executionId: string; readonly workflowData: IWorkflowBase; readonly retryOf?: string;
    addHandler<Hook extends keyof ExecutionLifecycleHookHandlers>(hookName: Hook, ...handlers): void;
    runHook<Hook extends keyof ExecutionLifecycleHookHandlers>(hookName: Hook, parameters): Promise<void>;
}
```

The CLI composes handler sets per execution: `hookFunctionsPush` (only when the execution has a `pushRef`, i.e. was started
from an editor tab or test webhook — production trigger/webhook runs have no `pushRef` and are not streamed; the
Executions list auto-refreshes instead), `hookFunctionsSave`
(persist on `workflowExecuteAfter`), `hookFunctionsSaveProgress` (persist after every `nodeExecuteAfter` if
`saveExecutionProgress`), statistics, event-bus/log-streaming, external hooks.

**Push messages** (`@n8n/api-types` `dist/push/execution.d.ts`), serialized as `JSON.stringify({ type, data })` (circular-safe):

```ts
export type ExecutionStarted = { type: 'executionStarted'; data: {
    executionId: string; mode: WorkflowExecuteMode; source?: WorkflowExecutionSource; startedAt: Date;
    workflowId: string; workflowName?: string; retryOf?: string;
    flattedRunData: string;            // `flatted.stringify(runData)` — pre-existing runData for partial runs
}};
export type NodeExecuteBefore = { type: 'nodeExecuteBefore'; data: {
    executionId: string; nodeName: string; sequenceNumber: number; data: ITaskStartedData; }};
export type NodeExecuteAfter = { type: 'nodeExecuteAfter'; data: {
    executionId: string; nodeName: string; sequenceNumber: number;
    data: Omit<ITaskData, 'data'>;                                     // status, timing, error — NO items
    itemCountByConnectionType: Partial<Record<NodeConnectionType, number[]>>;  // e.g. { main: [1, 1] } → edge labels
}};
export type NodeExecuteAfterData = { type: 'nodeExecuteAfterData'; data: {   // sent right after, as a BINARY ws frame
    executionId: string; nodeName: string; data: ITaskData;            // full output (after redaction)
    itemCountByConnectionType: NodeExecuteAfter['data']['itemCountByConnectionType']; }};
export type ExecutionWaiting  = { type: 'executionWaiting';  data: { executionId: string; source?: WorkflowExecutionSource } };
export type ExecutionFinished = { type: 'executionFinished'; data: { executionId: string; workflowId: string; status: ExecutionStatus; source?: … } };
export type ExecutionRecovered = { type: 'executionRecovered'; data: { executionId: string } };
export type AgentNodeProgress = { type: 'agentNodeProgress'; data: { executionId; nodeId; nodeName; runIndex; itemIndex;
    sequenceNumber; toolCallId; capability: {kind:'tool',name}|{kind:'skill',…}; status: 'running'|'succeeded'|'failed' } };
// also: { type: 'testWebhookReceived', data: { executionId, workflowId } }, { type: 'testWebhookDeleted', … },
//       workflowActivated / workflowDeactivated, collaboration, heartbeat …
```

Example stream for the §1.5 workflow:

```jsonc
{"type":"executionStarted","data":{"executionId":"412","mode":"manual","startedAt":"…","workflowId":"Xq3v…","workflowName":"Order router","flattedRunData":"[{}]"}}
{"type":"nodeExecuteBefore","data":{"executionId":"412","nodeName":"When clicking ‘Execute workflow’","sequenceNumber":0,"data":{"startTime":1761400000000,"executionIndex":0,"source":[],"hints":[]}}}
{"type":"nodeExecuteAfter","data":{"executionId":"412","nodeName":"When clicking ‘Execute workflow’","sequenceNumber":1,"itemCountByConnectionType":{"main":[2]},"data":{"startTime":…,"executionIndex":0,"source":[],"hints":[],"executionTime":1,"executionStatus":"success"}}}
<binary frame> {"type":"nodeExecuteAfterData","data":{"executionId":"412","nodeName":"When clicking ‘Execute workflow’","itemCountByConnectionType":{"main":[2]},"data":{…,"data":{"main":[[{"json":{"orderId":"A-1001","amount":250},"pairedItem":{"item":0}}, …]]}}}}
{"type":"nodeExecuteBefore","data":{"executionId":"412","nodeName":"Amount > 100?","sequenceNumber":2,"data":{"startTime":…,"executionIndex":1,"source":[{"previousNode":"When clicking ‘Execute workflow’","previousNodeOutput":0,"previousNodeRun":0}]}}}
{"type":"nodeExecuteAfter","data":{"executionId":"412","nodeName":"Amount > 100?","sequenceNumber":3,"itemCountByConnectionType":{"main":[1,1]},…}}
… "Flag high value" (top branch first in v1) … "Standard" …
{"type":"executionFinished","data":{"executionId":"412","workflowId":"Xq3v…","status":"success"}}
```

**Transport** (`n8n/dist/push`): `N8N_PUSH_BACKEND` = `websocket` (default) | `sse`. Endpoint
`/{restEndpoint}/push?pushRef=<per-tab random id>` (WS upgrade or SSE GET), cookie-auth + origin validation; server pings
every 60 s. The editor passes the same `pushRef` when starting a run, and the hooks address messages to that `pushRef`
(`sendToOne`), plus `sendToUsers`/`sendToAll` for broadcast types. In multi-main/queue mode, workers relay push messages
via Redis pub/sub (`relayViaPubSub`) to the main instance holding the socket. The editor uses `sequenceNumber` to order
node events and `itemCountByConnectionType` to draw "2 items" edge labels before the (possibly large) data arrives.

### 3.11 Process topology (brief)

`WorkflowRunner` runs executions either in the main process ("regular") or enqueues them to Bull/Redis for **workers**
("queue mode"); concurrency limits per mode; webhook processors can be split out. Code nodes execute in a separate
**task runner** process (`@n8n/task-runner`), not in the engine process. The public REST API (`/api/v1`, header
`X-N8N-API-KEY`, cursor pagination `limit`≤250 + `nextCursor`) manages workflows (CRUD, activate/deactivate,
publish/unpublish, archive, transfer, history/versions, tags), executions (list/get/delete/stop/retry), credentials, tags,
variables, projects, data tables, source control, audit — but has **no "run workflow" endpoint**: you start workflows
via webhooks (or the internal `/rest/workflows/:id/run` the editor uses).

---

## 4. Triggers & activation

Trigger kinds are distinguished by which `INodeType` method exists:

| kind | method | production activation | manual ("Execute workflow") |
|---|---|---|---|
| Manual Trigger | `trigger()` returning `{ manualTriggerFunction }` that `emit([[{json:{}}]])` | none (not activatable by itself) | runs immediately |
| Event triggers (Schedule, MQTT, IMAP, RabbitMQ, …) | `trigger()` → `ITriggerResponse { closeFunction?, manualTriggerFunction?, manualTriggerResponse? }`; calls `this.emit(data)` whenever an event occurs | `ActiveWorkflowTriggers.addAllTriggers` calls `trigger()` on activation and keeps `closeFunction` for deactivation | `trigger()` is called; `emit` resolves `manualTriggerResponse` once ⇒ one test execution |
| Schedule Trigger | `trigger()` that calls `this.helpers.registerCron(cron, onTick)` → `ScheduledTaskManager.register()` (`cron` lib `CronJob`, workflow timezone) | crons registered **only on the leader** instance | `manualTriggerFunction` emits one item now |
| Polling triggers (Gmail, RSS, …) | `poll()` returning `INodeExecutionData[][] \| null` (null = nothing new); description `polling: true` + `pollTimes` param | `activatePollTrigger`: rejects sub-minute crons ("The polling interval is too short…"), runs one poll at activation, registers crons (or a DB-backed `PollJobManager`); state in `staticData` / poll cursor hooks | `poll()` called once |
| Webhook triggers (Webhook, Form, Chat, app triggers with `webhooks` + `webhookMethods`) | `webhook()` returning `IWebhookResponseData { workflowData?, webhookResponse?, noWebhookResponse? }` | `addWebhooks`: store row in `webhook_entity` (method + path, unique ⇒ `WebhookPathTakenError`), and call `webhookMethods.default.checkExists/create` to register with the remote service | test-webhook flow |

Production emit path: `emit(data)` → `WorkflowExecutionService.runWorkflow(workflowData, node, data, additionalData,
'trigger', responsePromise)` → seeded stack `[{ node, data: { main: data }, source: null }]` → `WorkflowRunner.run`.

### 4.1 Activation (2.x)

`ActiveWorkflowManager.add(workflowId, activationMode)` with `WorkflowActivateMode = 'init' | 'create' | 'update' |
'activate' | 'manual' | 'leadershipChange'`:
- requires a published `activeVersion`; builds a `Workflow` from `activeVersion.nodes/connections`;
- validates `validateWorkflowHasTriggerLikeNode` ("…at least one active trigger, poll trigger, webhook trigger, or schedule
  trigger node is required");
- adds webhooks (all mains on init; otherwise leader) and non-webhook triggers/pollers (leader only — multi-main uses
  leader election and pub/sub commands `add-webhooks-triggers-and-pollers` / `remove-triggers-and-pollers`);
- activation errors are recorded (`activationErrorsService`) and retried with back-off; the UI shows them on the toggle;
- pushes `workflowActivated` / `workflowDeactivated` to editors; trigger count stored for licensing.

### 4.2 Webhook URLs

- **Production**: `/{N8N_ENDPOINT_WEBHOOK|webhook}/<path>` — live once the workflow is published/active. Executions are
  saved per settings and visible in the Executions list (not streamed to the canvas unless watched).
- **Test**: `/{webhook-test}/<path>` — only exists while the editor is "listening". Clicking *Execute workflow* / *Listen
  for test event* on an un-pinned webhook trigger makes `POST /rest/workflows/:id/run` return `{ waitingForWebhook: true }`;
  `TestWebhooks.needsWebhook` registers the webhook (in cache/Redis so any main can serve it) for
  `TEST_WEBHOOK_TIMEOUT = 2 min` (+30 s registration buffer), and also calls remote `webhookMethods.create`. On the first
  request it pushes `testWebhookReceived`, runs a **manual-mode** execution streamed to that `pushRef`, then deregisters.
  Timeout ⇒ `cancelWebhook` + `testWebhookDeleted`.
- **Waiting/resume**: `/webhook-waiting/:executionId[/suffix]`, forms `/form/…`, `/form-test/…`, `/form-waiting/…`.
- Paths: default = node's `webhookId` UUID; custom paths may include `:params` (dynamic webhooks matched by static segments).
- Response modes (`WebhookResponseMode`): `'onReceived' | 'lastNode' | 'responseNode' | 'formPage' | 'hostedChat' |
  'streaming'` — immediately, when last node finishes, via a *Respond to Webhook* node (uses the `sendResponse` hook),
  or streamed chunks (`sendChunk` hook).

---

## 5. Expressions

### 5.1 Syntax

- A parameter value is an expression iff it is a **string starting with `=`** (`isExpression`). The rest is a template:
  literal text with `{{ js-expression }}` segments, e.g. `"=Review order {{ $json.orderId }} manually"`, or a pure
  expression `"={{ $json.amount > 100 }}"` (which yields a typed value, not a string). `splitExpression()` parses into
  `{type:'text'|'code'}` chunks; `extendSyntax()` rewrites method-call sugar (`"abc".toTitleCase()`,
  `$json.date.toDateTime()`) to extension calls.
- Evaluation is **per item**: `getNodeParameter(name, itemIndex)` resolves expressions with `$json` bound to that item.
  The `filter`/`assignment` parameter types embed expressions in structured params (as in the IF example).
- Engines (`Expression.initExpressionEngine`, env `N8N_EXPRESSION_ENGINE`): **`vm` is the server default in 2.44**
  (`@n8n/config` `ExpressionEngineConfig`: `this.engine = 'vm'`) = isolated-vm V8 isolates via `@n8n/expression-runtime`;
  `legacy` = `@n8n/tournament` (n8n's successor of riot `tmpl`) compiling the template to JS and running it with
  `new Function` in-process behind AST sandbox hooks; `quickjs` = QuickJS-wasm (also runs in the browser;
  `N8N_EXPRESSION_ENGINE_FRONTEND` = `legacy` (default) | `quickjs`). Optional `N8N_EXPRESSION_ENGINE_NATIVE_EVALUATION`
  interprets a simple subset in-process without the isolate. `WorkflowExecute` leases one isolate per execution
  (`workflow.expression.acquireIsolate()` / `releaseIsolate()`). Runtime details: §7.3.

### 5.2 Variables (from `WorkflowDataProxy.getDataProxy()` + additional keys)

| variable | meaning |
|---|---|
| `$json` | current item's json (from the current input) — `$input.item.json` |
| `$binary` | current item's binary map |
| `$input` | `ProxyInput { item, all(), first(), last(), params, context }` for the node's current input |
| `$('Node Name')` | any **upstream** node: `.item` (paired-item resolved — follows `pairedItem` lineage back to that node), `.itemMatching(i)`, `.first(runIndex?)`, `.last()`, `.all()`, `.params`, `.context`, `.isExecuted`. Error if node unexecuted: "An expression references this node, but the node is unexecuted…" |
| `$node["Name"].json` | legacy accessor (same-index item, not lineage) |
| `$items(node?, output?, run?)`, `$item(i)` | legacy |
| `$parameter`, `$rawParameter` | this node's parameters |
| `$prevNode` `{name, outputIndex, runIndex}` | the node that fed this input |
| `$runIndex`, `$itemIndex`, `$position`, `$nodeId`, `$nodeVersion`, `$webhookId`, `$mode` | execution context |
| `$now`, `$today` | Luxon `DateTime` (workflow timezone) |
| `$workflow` | `{ id, name, active }` |
| `$execution` | `{ id, mode: 'test' \| 'production', resumeUrl, resumeFormUrl, customData.set/get/setAll/getAll }` |
| `$env` | process env — blocked unless `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (then `process.env`; `data.process.env` is `{}` by default) |
| `$vars`, `$secrets` | instance variables / external secrets |
| `$jmespath(obj, expr)`, `$if(c,a,b)`, `$ifEmpty(v,d)`, `$min/$max/$average/$not`, `$evaluateExpression` | helpers |
| `$fromAI(key, desc, type, default)` | AI-tool parameter placeholders filled by the agent |
| `$agentInfo`, `$tool`, `$self`, `$evaluation`, `$pageCount` | special contexts |

Extensions add methods on primitives: string (`toTitleCase`, `extractEmail`, `toDateTime`, `hash`…), number, boolean,
array (`pluck`, `unique`, `sum`, `chunk`…), object, date. The editor's expression editor autocompletes all of these and
shows a **live result preview** using the last run data (the frontend evaluates expressions locally with the same
`n8n-workflow` code — or QuickJS when that engine is selected).

---

## 6. Editor UX (from the `n8n-editor-ui` bundle + `@n8n/i18n` strings + docs)

Source tags: **[B]** = bundle/i18n (9,553 English keys extracted from the `@n8n/i18n` source map; components in
`n8n-editor-ui/dist/assets`), **[D]** = docs.n8n.io. The bundle is the more reliable source; the docs have moved under `/build/…`.

### 6.1 Canvas [B]
- **Stack:** Vue 3 + `@vue-flow/core` (+ MiniMap, Controls, Background); "Tidy up" uses **dagre** auto-layout
  (`Shift+Alt+T`). (React equivalent: React Flow + dagre/elk.)
- **Node shapes encode role:** trigger = D-shape (rounded left side) + bolt badge, with a hover **"Execute workflow"** flask
  button attached (chat trigger: "Open chat"); regular = square; AI root ("configurable", e.g. AI Agent) = wide rectangle with
  labelled **diamond** handles along the bottom ("Chat Model", "Memory", "Tool"; red when a required one is missing);
  AI sub-node ("configuration") = circle/pill; placeholder "+" node. Node size grows with port count.
- **Ports:** main inputs left / outputs right (dots), output labels beside handles (IF **true/false**, error output
  **Success/Error**). An unconnected output shows a stub line + **"+"** box (click → node creator, pre-wired). After a run it
  turns green and shows **"N items"** (`ndv.output.items` = `'{count} item | {count} items'`).
- **Edges:** midpoint item-count label; green after success, purple when fed by pinned data; AI edges dashed (`5,6`).
  Hover replaces the label with a toolbar: **"+"** (insert node in between) and trash ("Delete connection"). Dropping a
  dragged connection on empty canvas opens the node creator and auto-connects the new node.
- **Status chrome (priority order):** disabled (power icon, "Deactivated", strike-through line on 1-in/1-out nodes) →
  execution error (red, issue list, "(xN)") → validation issues ("Issues:" tooltip) / missing credential (key icon) →
  **pinned** (pin icon, purple border) → **success** (green check + run count) → **stale/dirty** (yellow triangle:
  "Node configuration changed. Output data may change when this node is run again"). Running/waiting = animated border.
  Small badges show active settings (Always Output Data, Execute Once, Retry On Fail, Continue On Fail).
- **Node hover toolbar:** Execute step, Deactivate/Activate, Delete, (sticky: color), "Add to n8n AI", More actions.
- **Context menu (`contextMenu.*`):** Open…, Execute step, Rename (F2), Replace (r), Activate/Deactivate (d), Pin/Unpin (p),
  Copy, Duplicate (Ctrl+D), Tidy up, "Convert to sub-workflow" (Alt+X), Group nodes (Ctrl+G), Select all, Delete,
  Add node, Add sticky note (Shift+S), Change color, Copy test URL / production URL. Labels pluralise ("Copy 3 nodes").
- **Sticky notes:** markdown (markdown-it), double-click to edit, resizable, 7 presets + custom color, image/YouTube embeds,
  can sit behind nodes. **Node groups** (new): titled, collapsible, single entry/exit enforced, convertible to sub-workflow.
- **Copy/paste is workflow JSON** on the clipboard; pasting JSON adds nodes (and credentials); pasting a workflow URL
  offers "Import Workflow?".
- **Navigation:** box-select on drag, pan with middle/Space/Ctrl-drag, minimap (200×120, bottom-left, appears while
  panning/hovering then fades), Zoom In/Out/Fit (`1`)/Reset (`0`), arrow keys move selection to neighbours,
  `Shift+←/→` selects all upstream/downstream.
- **Empty canvas:** "Add first step…" / "or start from a template".
- **Shortcuts:** `n` open nodes panel (Tab deprecated → coachmark "Press N to browse nodes"), `Enter` open node,
  `Ctrl+Enter` execute workflow, `l`/`i`/`o` toggle logs/input/output, `Shift+F` focus panel, `Ctrl+K` command bar,
  `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Shift+P` publish, typing `=` in an empty field switches it to expression mode.

### 6.2 Node creator ("nodes panel") [B]
- Opens from `n`, the canvas "+" button, an output's "+", an edge's "+", dropping a connection on empty canvas, or
  "Replace" ("Replace this step"). Opening from a port pre-filters to compatible nodes (e.g. AI sub-node categories).
- **Trigger-first for empty workflows:** **"What triggers this workflow?"** — "A trigger is a step that starts your
  workflow": Trigger manually · On app event · On a schedule · On webhook call · On form submission · When executed by
  another workflow · On chat message · Other ways… Once a trigger exists: **"What happens next?"**
- **Categories:** AI (Agents, Chains, Language Models, Memory, Tools, Vector Stores, Embeddings, Document Loaders, Text
  Splitters, Retrievers, Output Parsers, MCP servers, Misc) · Action in an app · Data transformation (Popular, Add or remove
  items, Combine items, Convert data) · Flow ("Branch, merge or loop the flow") · Core ("Run code, make HTTP requests, set
  webhooks") · Files · Human review ("Send and wait for response") · Add another trigger.
- **App nodes** expand into **Triggers** and **Actions** lists (one node type exposes many resource/operation "actions";
  picking an action pre-sets `resource`/`operation`), with a footer: "Didn't find the right event? Make a custom {node} API
  call" (HTTP Request node pre-wired with that app's credential). Badges: Trigger, Beta, Preview, Deprecated, New.
- **Search** "Search nodes…", ranked by popularity (`data/node-popularity.json`), plus "Results in other categories" and
  "More from the community"; empty state points to HTTP Request/Webhook and "Suggest a node". Keyboard: Enter insert,
  →/← enter/leave subcategory, Esc close.

### 6.3 NDV — Node Details View [B]
- Modal with **Input | Parameters | Output** panes (middle pane draggable to resize). Floating icons of parent (left),
  child (right) and sub-nodes (top) to hop between nodes. Header tabs **Parameters / Settings** + Docs link. Close
  tooltip: "Data stored, safe to close" (autosave).
- **Input pane:** parent-node picker ("{count} nodes back"); empty states "No input data" → **"Execute previous nodes"**
  ("From the earliest node which is unexecuted, or is executed but has since been changed"), "No input connected",
  "Parent node hasn't run yet".
- **Display modes:** **Schema / Table / JSON** (+ Binary, HTML, Rendered for AI text). Schema is derived from the first
  item; before a run it shows predicted fields ("Usually outputs the following fields…"). Field search, pagination 1–100.
- **Drag-to-map:** drag a field from the input into a parameter → expression `{{ $json.field }}` (immediate parent) or
  `{{ $('Node Name').item.json.field }}` (further upstream); dropping into a fixed field flips it to Expression mode.
  First-success toast "You just mapped some data!". JSON view: "Copy Item Path" / "Copy Parameter Path".
- **Parameters:** per-field **Fixed / Expression** toggle; inline CodeMirror expression editor with autocomplete and a live
  **"Result of item 1"** preview, inline diagnostics ("Execute previous nodes for preview", "'{node}' is on another
  branch", "No path back to node", "Can't determine which item to use"); "Open Edit Window" = full-screen expression editor
  with input data beside it. "Focus parameter" pins a field into the side focus panel.
- **Item linking:** hovering an item highlights its paired items in the other pane; run selector "Run {current} of
  {total}" with "Link displayed input and output runs".
- **Execute step** ("Runs the current node. Will also run previous nodes if they have not been run yet"); disabled reasons
  ("Complete required fields first", "A previous node has missing required fields", "Enable node to execute"). Webhook
  triggers: **"Listen for test event"** / "Stop Listening", showing the Test URL; polling triggers: "Fetch Test Event".
- **Output pane:** item count, sub-execution links, stale warning "Node parameters have changed. Test node again to refresh
  output.", empty state hints at Settings → "Always Output Data".
- **Settings tab:** Always Output Data · Execute Once · Retry On Fail (Max. Tries, Wait Between Tries (ms)) · **On Error:
  Stop Workflow / Continue / Continue (using error output)** · Notes · Display Note in Flow? · custom OTel span attributes ·
  node version (Latest / Deprecated). Hint banners echo active settings.

### 6.4 Pin data [B/D]
- "Node will always output current data instead of executing. Doesn't apply to production executions." Only
  single-main-output nodes, not binary outputs; size cap per workflow.
- Pin button in output header (`p`) → banner "This data is pinned for test executions." + "Unpin". **"Edit Output"** opens a
  JSON editor (saving pins; "set mock data" before any run; prefilled from last execution). Re-executing a pinned node asks
  "Unpin output data? — Testing a node overwrites pinned data." On canvas: purple border/edges.
- "Debug in editor" (failed run) / "Copy to editor" (successful run) in the Executions tab **pins a past execution's data
  into the workflow** so you can iterate on downstream nodes.

### 6.5 Running, partial runs, logs, executions [B/D]
- **Execute workflow** button (split button with trigger picker when several triggers exist); states "Executing
  workflow" / "Waiting for trigger event"; stop buttons. Changes **autosave**; triggers use the last **Publish**ed version
  (publish modal: version name + description).
- **Partial runs:** "Execute step" runs the node plus only the upstream nodes needed. Nodes become **dirty** when their
  params change, upstream nodes are inserted/deleted, connections into them change, they're deactivated/unpinned →
  yellow border + triangle; dirty nodes are re-run, clean ones reuse previous output (engine side: §3.1).
- **Logs panel** (bottom dock, `l`): Overview/Details, **tree of node runs** (status, "{status} in {time}", AI token counts,
  sub-workflow runs inline), Input/Output toggle per entry, "Sync selection with canvas", pop-out window, keyboard j/k.
  Chat panel docks beside it for chat-triggered workflows.
- **Executions tab** (header tabs **Editor | Executions | Evaluations**): list with auto-refresh and filters (status, date,
  version, highlighted data key/value, rating, tags); read-only canvas preview of a past run; **Debug in editor / Copy
  to editor**; "Retry with current version" / "Retry with original version"; concurrency header "{running}/{cap} active".

### 6.6 Other features worth emulating [B]
- **Command bar** (`Ctrl+K`): "Type a command or search..." over nodes, workflows, credentials, executions ("Add node >
  {name}", "Open node > {name}").
- **Focus/side panel** (`Shift+F`): pinned parameters (e.g. prompt) editable next to the canvas while re-running; a
  **Setup** tab listing missing credentials/required fields until "Your workflow is ready to be executed".
- **Version history** with restore/publish/clone/download and a visual **workflow diff** (nodes and connectors before/after).
- **AI builder** (Ask / Build, plan mode with "Proposed plan" → "Implement the plan", results as "Edits · N nodes" with
  "Open diff"), powered by `@n8n/workflow-sdk` (§7.2).
- Zoom-dependent edge/border contrast, collaboration presence pill.

---

## 7. The new packages

### 7.1 `@n8n/engine` 0.24.1 — "n8n workflow execution engine (v2)"

**What it is:** a separate, **Postgres-backed, step-oriented durable execution service** (Express HTTP API + queue workers).
n8n main is the control plane, the engine is the data plane (`n8n-engine-dp`). It is the intended successor of
`WorkflowExecute`, but it does not know about nodes: each step is handed to an injected executor; n8n plugs in a
`v1StepExecutor` from `@n8n/node-engine-compatibility` that builds an n8n-core execute context and calls
`nodeType.execute()`.

**Graph format — new, id-based, flat edge list** (`dist/graph/workflow-graph.d.ts`, npm tarball):

```ts
export type StepType = 'trigger' | 'v1-node' | 'wait' | 'subworkflow' | 'batch';
export interface GraphNode { id: string; name: string; type: StepType; config?: StepConfig; }
export interface GraphEdge { from: string; to: string; outputIndex: number; inputIndex: number; isBackEdge?: boolean; }
export interface WorkflowGraph { nodes: GraphNode[]; edges: GraphEdge[]; }
```

`V1WorkflowConverter.convert(workflow, firedTriggerName)` (in node-engine-compatibility) maps v1 JSON → graph: edges by
node **id**, only `main` connections (AI sub-nodes rejected), disabled nodes spliced out, SplitInBatches → `batch`, every
other node → `v1-node` with `config = { nodeType, typeVersion, parameters, continueOnFail, credentials? }`.

**Execution & step model** (`dist/execution/execution.types.d.ts`):

```ts
export type ExecutionStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type ExecutionMode = 'production' | 'manual';
export type StepStatus = /* 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'cancelled' */;
export type StepSlots = JsonValue[];               // one entry per output slot; null = branch not taken
export type WaitDeclaration =
  | { resumeAt: string; outputsAtDeadline: StepSlots; acceptsResumeRequest: boolean }
  | { resumeAt?: never; outputsAtDeadline?: never; acceptsResumeRequest: true };
```

```ts
// dist/dependencies/external-dependencies.d.ts
export interface StepExecutionContext { executionId: string; stepId: string; workflowId: string; mode: ExecutionMode;
    iteration: number; callerContext: CallerContext; responseExpectation: ResponseExpectation; }
export interface StepExecutionRequest { node: GraphNode; inputs: StepSlots; context: StepExecutionContext; respond: ResponseEmitter; }
export type StepExecutionResult = { outputs: StepSlots; wait?: never } | { wait: WaitDeclaration; outputs?: never };
export interface IStepExecutor { execute(request: StepExecutionRequest): Promise<StepExecutionResult>; }
export interface ExternalDependencies { v1StepExecutor?: IStepExecutor; lifecycleEventCallback?: LifecycleEventCallback;
    deleteExecutionFiles?: ExecutionFilesDeleter; }
```

**Algorithm:** `POST /api/workflow-executions` validates the graph and inserts `workflow_execution` (queued) → start handler
marks it running and inserts the trigger step as already `completed` with `triggerOutputs` → on every `step:settled`,
`decideSuccessors()` evaluates each successor: it is decidable only when **every incoming source has settled**; it's
`queued` if ≥1 source completed and filled the edge's `outputIndex` slot, else **`skipped`, and skips propagate** →
`claimStep` atomically flips queued→running (guarded UPDATE, no-op if a sibling already failed) → executor runs →
`completeStep | suspendStep | failStep` → publish `step:settled`. One row per `(executionId, nodeId, iteration)`. Loops:
only a `batch` node may head a loop, via an explicit `isBackEdge` edge; loop bodies are SCCs (Tarjan), each pass increments
`iteration`; batch slot 0 = done, slot 1 = loop. Two edges into the same input slot ⇒ `UnimplementedError` (HTTP 501).
Any failed step fails the execution. **No retries**, no `alwaysOutputData`/`executeOnce`/`continueErrorOutput`; in-memory
work queues processing one message at a time; state transitions are compare-and-set in Postgres but nothing re-enqueues
after a crash. Waits: `WaitSweeper` re-queues due steps (`FOR UPDATE SKIP LOCKED`); only timed waits work in practice.

**Lifecycle events** (zod `lifecycleEventSchema`, discriminated on `type`):

```ts
executionFields = { executionId, workflowId, at /* ISO datetime */ }
stepFields      = { executionId, stepId, nodeId, nodeName, iteration, at }
  { type: 'execution:started', ...executionFields, mode: 'production' | 'manual', hostMode: string }
  { type: 'execution:completed' | 'execution:failed' | 'execution:cancelled', ...executionFields }
  { type: 'step:started', ...stepFields }
  { type: 'step:completed', ...stepFields, outputs: JsonValue[] }
  { type: 'step:failed', ...stepFields }          // no error payload yet; no step:skipped / step:waiting
```

Batched (`BatchingLifecycleEventPublisher`: flush every 50 ms, ≤500/batch, backlog 10k, **drops on overflow**) to
`lifecycleEventCallback`, which in n8n POSTs to the control plane, where `EngineLifecycleEventPushRelay` translates them
into the existing push messages (`nodeExecuteBefore/After/AfterData`, `executionFinished`; failed steps get "Engine v2 does
not report error detail yet."). A separate response channel (`undeliverable | response | chunk | ended`) handles webhook
responses/streaming. Exports: `createEngineRuntime(...) → { app, start(), stop() }`, `createDataSource(url)`, entities,
admittance, `deriveLoops`, lifecycle/response schemas, JWT helpers (`mintIdentityToken`, `mintActionToken`, …).
HTTP: `GET /healthz`, `POST /api/workflow-executions` (201 `{executionId}`), `POST …/search`, `GET …/:id`, `POST …/:id/cancel`.

**Wiring in 2.44.6:** backend module `engine-v2` (main only), **not enabled by default** — needs
`N8N_ENABLED_MODULES=engine-v2`, `N8N_ENGINE_DATABASE_URL` (Postgres), not queue mode, expression engine `vm`/`quickjs`;
`N8N_ENGINE_MODE=in-process` (default; port 3000, CP on 127.0.0.1:3001) or `remote` (`n8n engine` command, shared secret ≥32
chars). Per-workflow opt-in `settings.engineType === 'v2'` (modes manual/webhook/trigger; not settable from the editor UI).
Unsupported: partial runs, non-trigger pin data, AI tools, `$vars`/`$secrets`, Code node, sub-workflows, Merge
chooseBranch, indefinite waits. Off in this container.

**Takeaway:** n8n's own next-gen engine moves to exactly the things Landflow should start with: id-based flat edges,
explicit back-edges, per-step durable records, "settled/skipped" readiness instead of stack heuristics, a pluggable step
executor, and a small typed lifecycle-event union.

### 7.2 `@n8n/workflow-sdk` 0.37.2 — code-first workflow builder

A TypeScript builder **plus** a parser for a restricted TS dialect (acorn AST interpreter; no execution — `eval`,
`Function`, `require`, `process`, `fetch`, `Promise`, `Math`, `Date`, … blocked). It is the backbone of n8n's AI workflow
builder, `instance-ai`, and the MCP server tools (`validate-workflow-code`, `update-workflow`,
`get-workflow-best-practices`): the LLM writes SDK code, n8n parses it to workflow JSON. Node type descriptions carry
`builderHint`s for it (see the IF node hint quoted in §1.4).

```ts
// dist/types/base.d.ts (npm tarball)
export interface WorkflowBuilderStatic {
    (id: string, name: string, options?: WorkflowSettings | WorkflowBuilderOptions): WorkflowBuilder;
    fromJSON(json: WorkflowJSON): WorkflowBuilder;
}
export interface WorkflowBuilder {
    add(node): WorkflowBuilder;  to(node | InputTarget | IfElseBuilder | SwitchCaseBuilder | SplitInBatchesBuilder | node[]): WorkflowBuilder;
    onTrue(t): WorkflowBuilder;  onFalse(t): WorkflowBuilder;  onCase(index: number, t): WorkflowBuilder;  onError(handler): WorkflowBuilder;
    settings(s: WorkflowSettings): WorkflowBuilder;
    connect(source, sourceOutput: number, target, targetInput: number): WorkflowBuilder;
    getNode(name: string); group(name: string, members: GroupMember[], options?: GroupOptions): WorkflowBuilder;
    validate(options?: ValidationOptions): ValidationResult;
    toJSON(options?: ToJSONOptions): WorkflowJSON;  toFormat<T>(format: string): T;  toString(): string;
    generatePinData(options?): WorkflowBuilder;  regenerateNodeIds(existingIdsByName?: Map<string, string>): void;
}
export interface NodeInput<TType extends string = string, TVersion extends number = number, TParams = unknown> {
    type: TType; version: TVersion; config: NodeConfig<TParams>; output?: IDataObject[];   // output = sample data (→ pin data)
}
export interface NodeConfig<TParams = IDataObject> { id?; parameters?: TParams; credentials?; name?; position?; webhookId?;
    disabled?; notes?; notesInFlow?; executeOnce?; retryOnFail?; maxTries?; waitBetweenTries?; alwaysOutputData?;
    onError?: OnError; pinData?: IDataObject[]; output?: IDataObject[]; subnodes?: SubnodeConfig; … }
export interface NodeInstance<TType, TVersion, TOutput> { readonly type; readonly version; readonly config; readonly id; readonly name;
    update(config); to(target, outputIndex?): NodeChain; input(index: number): InputTarget; output(index: number): OutputSelector;
    onTrue?(t); onFalse?(t); onCase?(i, t); onError(handler): this; getConnections(): DeclaredConnection[]; }

export declare const workflow: WorkflowBuilderStatic;
export declare function node<TNode extends NodeInput>(input: TNode): NodeInstance<TNode['type'], `${TNode['version']}`, unknown>;
export declare function trigger<TTrigger extends TriggerInput>(input: TTrigger): TriggerInstance<…>;
export declare function ifElse<TOutput = unknown>(input: IfElseFactoryConfig): NodeInstance<'n8n-nodes-base.if', string, TOutput>;
export declare function merge<TOutput = unknown>(input: MergeFactoryConfig): NodeInstance<'n8n-nodes-base.merge', string, TOutput>;
export declare function expr(expression: string): string;            // just prefixes "="
export declare function parseWorkflowCode(code: string): WorkflowJSON;
export declare function generateWorkflowCode(input: WorkflowJSON | GenerateWorkflowCodeOptions): string;
export declare function validateWorkflow(workflowOrJson: WorkflowBuilder | WorkflowJSON, options?: ValidationOptions): ValidationResult;
```

Also: `switchCase`, `splitInBatches(...).onEachBatch(...).onDone(...)`, `nextBatch`, `sticky`, `placeholder`,
`newCredential`, AI sub-node factories (`languageModel`, `memory`, `tool`, `outputParser`, `embedding(s)`, `vectorStore`,
`retriever`, `documentLoader`, `textSplitter`, `fromAi`), `workflowToMermaid`, a `workflow-sdk` CLI (`json-to-code`,
`code-to-json`, `validate`), `generate-types` (per-node, per-version TS types + Zod schemas from node descriptions, using
resource/operation discriminated unions), and `prompts/sdk-reference` (LLM-facing language reference, patterns, rules,
expression reference). Example (from `prompts/sdk-reference/workflow-patterns.js`):

```ts
const startTrigger = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } });
const fetchData = node({ type: 'n8n-nodes-base.httpRequest', version: 4.3,
  config: { name: 'Fetch Data', parameters: { method: 'GET', url: '...' } } });
const checkValid = ifElse({ version: 2.2, config: { name: 'Check Valid', parameters: { conditions: {
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
  conditions: [{ leftValue: expr('{{ $json.status }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'active' }],
  combinator: 'and' } } } });
export default workflow('id', 'name').add(startTrigger).to(fetchData)
  .to(checkValid.onTrue(formatData.to(saveToDb)).onFalse(logError));
```

`toJSON()` emits standard workflow JSON (`nodes[]`, name-keyed `connections`, auto-laid-out `position`s, generated ids,
`"={{ $json.status }}"` expression strings). (The README's `new WorkflowBuilder().addTrigger(manual())` example is stale.)

### 7.3 `@n8n/expression-runtime` 0.35.0 — isolated expression evaluation

Three layers (ARCHITECTURE.md): **Evaluator** on the host (tournament transform → JS, LRU code cache, isolate pool, metrics)
→ **Bridge** (`IsolatedVmBridge` = isolated-vm V8 isolate, backend default; `QuickJsBridge` = quickjs-emscripten WASM,
backend or browser) → **Runtime** IIFE bundle loaded in each isolate (lodash, Luxon, extension functions, `SafeObject`,
`SafeError`, lazy proxies, `buildContext`). Isolates are pooled and leased per caller (one per execution).

```ts
class ExpressionEvaluator { constructor(config: EvaluatorConfig); initialize(): Promise<void>;
  acquire(owner: object): Promise<boolean>;
  evaluate(expression: string, data: WorkflowData, caller: object, options?: EvaluateOptions /* { timezone } */): unknown;
  release(owner: object): Promise<void>; dispose(): Promise<void>; isDisposed(): boolean; }
interface RuntimeBridge { initialize(): Promise<void>; execute(code: string, data: Record<string, unknown>): unknown;
  dispose(): Promise<void>; isDisposed(): boolean; }
interface EvaluatorConfig { createBridge: () => RuntimeBridge; maxCodeCacheSize: number; observability?: ObservabilityProvider;
  hooks?: TournamentHooks; poolSize?: number; idleTimeoutMs?: number; logger?: Logger; }
// DEFAULT_BRIDGE_CONFIG = { memoryLimit: 128 /*MB*/, timeout: 5000 /*ms*/, runtimeBundle: '', compileCache: false }
```

- Evaluation: strip `=` → (native subset fast path) → `extendSyntax` → tournament `getExpressionCode` (cached) →
  `bridge.execute` runs `(function(){ <code> }).call(buildContext({ getValueAtPath, getArrayElement, callHost }, tz))`;
  results are copied out, errors come back as sentinels and are rebuilt host-side.
- **Data crosses lazily:** only object keys / array lengths enter the isolate; values are fetched on demand via
  `getValueAtPath`; host functions are unreachable. `$now/$today/DateTime/$jmesPath/extensions` live inside the isolate;
  `$('X').first/last/all/item/pairedItem/itemMatching`, `$input.first/last/all`, `$items`, `$fromAI`,
  `$evaluateExpression`, `$getPairedItem` are explicit `callHost` RPCs; everything else (`$json`, `$node`, `$workflow`, …)
  resolves lazily from the host `WorkflowDataProxy`.
- **Security:** 128 MB / 5 s per isolate (nested evaluations share the budget); `globalThis`, `eval`, `Function`,
  `require`, `process`, `Buffer`, `fetch`, `Promise`, `Reflect`, `Proxy`, `WebAssembly`, timers neutralised; `Object` →
  `SafeObject` (no defineProperty/setPrototypeOf/…), `Error` → `SafeError`; `__sanitize()` blocks `__proto__`,
  `prototype`, `constructor`…; AST hooks `{ before: [ClassExtensionValidator, ThisSanitizer], after: [PrototypeSanitizer,
  DollarSignValidator] }`; non-expression errors evaluate to `undefined` (legacy-compatible).
- Flags: `N8N_EXPRESSION_ENGINE` (`vm` default), `N8N_EXPRESSION_ENGINE_FRONTEND`, `_POOL_SIZE`, `_TIMEOUT`,
  `_MEMORY_LIMIT`, `_IDLE_TIMEOUT`, `_LAZY_ACQUIRE`, `_NATIVE_EVALUATION`, ….

---

## 8. Implications for Landflow

A minimal-but-correct model that keeps n8n's proven semantics (items, ports, depth-first, pin data, partial runs, live
events) and adopts what n8n itself is moving to in engine v2 (ids, flat edges, explicit loops, settled/skipped readiness,
pluggable step executors, typed events).

### 8.1 Workflow document

```ts
type WorkflowDoc = {
  id: string; name: string; version: number;              // draft vs published version ids (n8n 2.x model)
  nodes: NodeInstance[];
  edges: Edge[];                                           // FLAT list — maps 1:1 to React Flow edges
  settings: { timezone?: string; errorWorkflowId?: string; timeoutMs?: number; saveProgress?: boolean };
  pinData?: Record<NodeId, Item[]>;                        // honoured only in manual runs
  meta?: { groups?: Group[]; stickies?: Sticky[] };        // UI-only data kept out of the engine path
};
type NodeInstance = {
  id: NodeId;                    // stable uuid — the engine key (NOT the name)
  key: string;                   // unique, human-readable slug used in expressions: $('fetch_orders'); refactor on rename
  label: string;                 // display name
  type: string; typeVersion: number;                       // "<plugin>/<node>", versioned descriptors
  position: [number, number];
  parameters: Record<string, ParamValue>;                  // "={{ … }}" strings = expressions (n8n-compatible)
  credentials?: Record<string, { id: string }>;
  disabled?: boolean; notes?: string;
  settings?: { retry?: { maxTries: number; backoffMs: number }; onError?: 'stop' | 'continue' | 'errorPort';
               alwaysOutputData?: boolean; executeOnce?: boolean; timeoutMs?: number };
};
type Edge = { id: string; kind: 'main' | `ai_${string}`;
              source: { nodeId: NodeId; port: string };   // port ids from the node descriptor: "main", "true", "false", "error", "case_2"
              target: { nodeId: NodeId; port: string };
              backEdge?: boolean };                        // required to close a loop (validated: must target a loop node)
```

Why: n8n keys connections and runData by *name* and by *numeric index*. Names force rename rewrites (n8n rewrites
expressions on rename), and numeric indices break when dynamic outputs (Switch cases, Merge inputs) are reordered. Use ids
for wiring, string port ids from the descriptor (keep an `index` in the descriptor for ordering/n8n import), and a
separate `key` for expressions. Keep a converter to/from n8n JSON (name→id, index→port) for import.

### 8.2 Data shape between nodes (keep n8n's — it works)

```ts
type Item = { json: JsonObject; binary?: Record<string, BinaryRef>;      // BinaryRef = { storageKey, mimeType, fileName, size } — never inline base64 over RPC
              pairedItem?: { item: number; input?: number } | Array<{ item: number; input?: number }>;
              error?: { message: string; description?: string; code?: string } };
type PortData = Record<PortId, Item[]>;           // node output; an absent/empty port = branch not taken
```

- Nodes run **once per batch** with all input items (`inputs: Record<PortId, Item[]>`), returning `PortData`. Keep the n8n
  rule **"no items ⇒ downstream doesn't run"** (plus `alwaysOutputData`).
- Auto-assign `pairedItem` when unambiguous (1→1, N→N same count, N→1) exactly like `assignPairedItems`; require plugins to
  set it otherwise. This powers `$('key').item` and input/output hover-linking in the UI.
- For **remote plugins (HTTP/gRPC)**: resolve expressions host-side and send `params: ResolvedParams[]` (one per input
  item, or one if the descriptor says `paramMode: 'once'`) together with the items, so plugins stay stateless and there's
  no per-parameter callback chatter (n8n's `getNodeParameter(name, i)` callback model doesn't survive a network hop).
  Binary goes by reference to shared blob storage.

### 8.3 Execution state (one JSON document ⇒ pause/resume/partial re-run for free)

```ts
type ExecutionState = {
  id: string; workflowId: string; workflowVersion: number; mode: 'manual' | 'trigger' | 'webhook' | 'retry' | 'subworkflow';
  status: 'queued' | 'running' | 'waiting' | 'success' | 'error' | 'canceled';
  runs: Record<NodeId, NodeRun[]>;                  // append-only; index = runIndex (n8n runData)
  ready: Activation[];                              // deque (n8n nodeExecutionStack)
  pending: Record<NodeId, PendingInputs[]>;         // per multi-input node, per run slot (n8n waitingExecution)
  edgeState: Record<EdgeId, 'open' | 'delivered' | 'dead'>;   // per (activation generation); enables skip propagation
  startData?: { destinationNodeId?: NodeId; destinationMode?: 'inclusive' | 'exclusive'; nodeFilter?: NodeId[] };
  pinData?: Record<NodeId, Item[]>; waitUntil?: string; error?: SerializedError; seq: number;
};
type Activation = { nodeId: NodeId; inputs: Record<PortId, Item[] | null>; source: Record<PortId, SourceRef | null>; runIndex?: number };
type NodeRun = { runIndex: number; executionIndex: number; startedAt: number; durationMs: number;
                 status: 'success' | 'error' | 'waiting' | 'canceled'; source: Record<PortId, SourceRef | null>;
                 output?: PortData; error?: SerializedError; attempts: number };
type SourceRef = { nodeId: NodeId; port: PortId; runIndex: number };   // inputs reconstructable from upstream output
```

Persist the whole state after each node when `saveProgress` (n8n `saveExecutionProgress`), always on finish/wait.

### 8.4 Scheduling algorithm

```text
seed: trigger fired → ready = [{ nodeId: trigger, inputs: { main: emittedItems } }]   (trigger "runs" as pass-through)
      manual run    → start = trigger chosen by user (or the single trigger); destination optional
      partial run   → see 8.5
loop while ready not empty:
  check cancel/timeout/suspend
  a = ready.shift()                                   # always pop FRONT
  if nodeFilter && a.nodeId ∉ nodeFilter → continue
  emit node.started
  if node.disabled: output = { [firstOutPort]: a.inputs[firstInPort] ?? [] }       # n8n pass-through rule
  elif pinData[node] && mode=='manual': output = { [firstOutPort]: pinData[node] }
  else: output = await executeWithRetry(node, a)      # attempts emit node.retrying; onError → stop | pass input through | route to "error" port
  apply pairedItem auto-assignment; alwaysOutputData
  record NodeRun; emit node.finished (+ node.data)
  if error && onError=='stop' → status=error, run error workflow, stop
  if node == destination → don't schedule children
  children = []
  for each outgoing edge e (ordering of the resulting activations: see next line):
     items = output[e.source.port]
     if items?.length: deliver(e, items) else markDead(e)
  order deliveries: by target canvas position (y asc, then x asc) — n8n v1's visible rule — then ready.unshift in reverse
  so the top-most branch runs first (depth-first)
deliver(e, items):
  target has 1 connected input port (or e targets a port with multiple incoming edges) →
      ready.unshift(new Activation(target, { [e.target.port]: items }))       # fan-in to one port = one run per arrival (n8n v1)
  target has ≥2 distinct connected input ports (Merge-like) →
      fill first pending slot whose port is empty; when every connected port is delivered OR dead and the
      descriptor's requiredInputs (count or port list) is satisfied → enqueue with missing ports = [];
      if all ports dead → markNodeSkipped(target) (propagate dead to its outgoing edges)
markDead(e) / markNodeSkipped(n): propagate "dead" downstream so Merge nodes become decidable deterministically
  (engine-v2 style), instead of n8n's "flush waiting nodes when the stack drains" heuristic.
loops: only through edges flagged backEdge into a loop-capable node (SplitInBatches/"Loop"); each pass increments
  runIndex/iteration and resets edgeState for the loop body (SCC). Guard: max iterations per node + n8n's
  "same node/runIndex twice in a row" check.
finish: status = error | waiting | success | canceled; emit execution.finished/waiting
```

Rules to copy verbatim from n8n: depth-first (unshift) with position-based sibling order; empty output stops a branch;
disabled = input-0→output-0 pass-through; `executeOnce` = first item only; retries wrap only the node call (one
started/finished pair per run, attempts counted); `onError: errorPort` splits items with `error` onto an extra `error` port
and merges the paired input item's json for context; pin data only in manual mode; Wait = set `waitUntil`, push the
activation back to the head, persist, resume by marking the head as "resumed" so it passes its input/resume payload through.

### 8.5 Partial execution ("Execute step" / "run to here")

Track dirtiness in the editor (params changed, upstream inserted/removed, incoming edges changed, (un)disabled, unpinned —
n8n's list). Send `{ runs (or a previous executionId), destination, dirtyNodeIds }`. Server: subgraph = ancestors of
destination (incl. the trigger); start nodes = walking from the trigger along edges that carried items, the first node
that is dirty / has no run & no pin / last run errored (or the destination itself); a start node inside a loop moves to the
loop entry; rebuild `ready` + `pending` from the parents' existing runs; `nodeFilter = subgraph`. This is n8n's
`findStartNodes` + `recreateNodeExecutionStack` and is what makes iterating on one node cheap.

### 8.6 Event stream for the live UI

Per-execution, ordered, resumable stream (SSE fits Next.js route handlers and proxies; WebSocket optional). Every event has
`seq` (monotonic per execution, like n8n's `sequenceNumber`) and is persisted so a client can reconnect with
`Last-Event-ID: <seq>` and replay.

```ts
type ExecEvent =
  | { type: 'execution.started';  seq; executionId; workflowId; mode; startedAt; resumedFrom?: string }
  | { type: 'node.started';       seq; executionId; nodeId; runIndex; executionIndex; source: Record<PortId, SourceRef | null> }
  | { type: 'node.retrying';      seq; executionId; nodeId; runIndex; attempt; error: SerializedError; nextInMs }
  | { type: 'node.finished';      seq; executionId; nodeId; runIndex; status; durationMs; error?: SerializedError;
                                  itemCounts: Record<PortId, number> }        // small: drives check marks + "N items" edge labels
  | { type: 'node.data';          seq; executionId; nodeId; runIndex; output: PortData; truncated?: boolean } // large; may be skipped & fetched lazily
  | { type: 'node.skipped';       seq; executionId; nodeId }                   // n8n has no equivalent; useful for greying branches
  | { type: 'execution.waiting';  seq; executionId; waitUntil?: string; resumeUrl?: string }
  | { type: 'execution.finished'; seq; executionId; status; error?: SerializedError; stoppedAt }
  | { type: 'trigger.listening' | 'trigger.received' | 'trigger.timeout'; seq; workflowId; executionId? };  // test webhooks
```

- Split metadata (`node.finished` with `itemCounts`) from payload (`node.data`) exactly as n8n splits
  `nodeExecuteAfter` / `nodeExecuteAfterData`: the canvas updates instantly; the NDV/log panel fetches or streams data
  (paginated, size-capped, redacted).
- Subscribe by **executionId** (any viewer, any tab, production runs included) rather than n8n's per-tab `pushRef`; a
  workflow-level channel carries `trigger.*` events for "Listen for test event" (n8n: test webhook live for 120 s at
  `/webhook-test/…`, production at `/webhook/…`).
- Engine emits the same events internally (an in-process emitter or bus — Redis/NATS when workers are split), so
  persistence, logs panel, metrics and the UI all consume one stream. Batch at ~50 ms like engine v2 but **never drop** —
  back-pressure or persist-then-notify instead (engine v2 drops on overflow; avoid that).

### 8.7 Triggers & plugins

- Trigger node kinds as in n8n: `manual`, `schedule` (cron registered on a single leader), `poll` (interval ≥ 1 min,
  cursor in per-workflow static state), `webhook` (descriptor declares method/path; production vs test URL; response
  modes onReceived/lastNode/responseNode/streaming), `event` (long-lived `start()`/`stop()` with `emit(items)`).
  Activation = register these for the **published** version; record activation errors for the UI.
- Plugin descriptors discovered over HTTP/gRPC should mirror `INodeTypeDescription` essentials: `type`, `version[]`,
  `displayName`, `group`/category (for the node creator), `inputs`/`outputs` as port descriptors (`{ id, kind, label,
  required?, maxConnections? }`, possibly parameter-dependent), `requiredInputs`, `properties` (parameter schema with
  `displayOptions`), `credentials`, trigger kind + webhook/poll config, plus **sample output schema** (n8n shows predicted
  fields before a run) and `paramMode`. Editor-time RPCs (`loadOptions`, `listSearch`, credential test) map naturally to
  plugin endpoints.

### 8.8 Expressions

Keep n8n syntax (`"={{ … }}"`, `$json`, `$input`, `$('key').item`, `$now`, `$workflow`, `$execution`, `$vars`) — users and
LLMs already know it, and `@n8n/workflow-sdk`'s `expr()` shows the string form is enough. Evaluate in an isolate
(isolated-vm server-side, QuickJS-wasm for the browser live preview), pass data lazily (keys first, values on demand),
cap memory/time (n8n: 128 MB / 5 s), block prototype/constructor access, and resolve paired-item lookups host-side.
