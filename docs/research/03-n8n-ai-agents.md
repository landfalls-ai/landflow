# 03 — How n8n implements AI agents

> Research target: **n8n 2.44.6** (Docker container `n8n`), read from installed compiled sources under
> `/usr/local/lib/node_modules/n8n/` plus docs.n8n.io. The packages ship compiled JS without `.d.ts`
> files, so the quotes below are compiled JavaScript, lightly trimmed. Paths are abbreviated:
>
> | Alias | Real path (inside container) |
> |---|---|
> | `LC/` | `node_modules/@n8n/n8n-nodes-langchain/dist/` (v2.44.x) |
> | `CORE/` | `node_modules/n8n-core/dist/` |
> | `WF/` | `node_modules/n8n-workflow/dist/cjs/` |
> | `CLI/` | `dist/` (the `n8n` server package) |
> | `AIU/` | `node_modules/@n8n/ai-utilities/dist/esm/` (0.37.4) |
> | `AGENTS/` | `node_modules/@n8n/agents/dist/` (0.29.5) |
> | `AWB/` | `node_modules/@n8n/ai-workflow-builder/dist/` (1.44.4) |
> | `API/` | `node_modules/@n8n/api-types/dist/` |
> | `UI/` | `node_modules/n8n-editor-ui/dist/assets/app-B73P2rmz.js` (minified) |

## TL;DR

* n8n models AI as **cluster nodes**: a *root node* (AI Agent, chains, vector stores) plus *sub-nodes* (chat
  model, memory, tools, output parser, embeddings, …). Sub-nodes connect to the root over typed
  `ai_*` connections. On the canvas, the root's `ai_*` inputs are drawn as slots along the **bottom** of the
  node, and the sub-node's `ai_*` output is drawn on the **top** of the sub-node.
* A sub-node does not produce items. Its `supplyData(itemIndex)` returns a **live object** (a LangChain
  `ChatAnthropic`, a memory, a `DynamicStructuredTool`, …). The root pulls it with
  `this.getInputConnectionData('ai_languageModel', i)`. Logging is done by wrappers
  (`N8nLlmTracing`, `logWrapper`) that write synthetic **run entries for the sub-node** into the execution's
  run data, with `source.previousNode = <root>`.
* **Any regular node becomes a tool.** If its description has `usableAsTool`, n8n synthesizes a
  `<name>Tool` node type with `inputs: []` and `outputs: ['ai_tool']`, and adds a "Tool Description"
  field. The tool's input schema is built from the `$fromAI('key', 'desc', 'type', default)` placeholders in
  its parameters.
* **AI Agent v3 (default 3.1) does not run tools in-process.** Each model turn returns an
  `EngineRequest` (a list of tool calls). The **workflow engine** runs the tool nodes as ordinary
  node runs, then calls the agent's `execute(response)` again with an `EngineResponse` holding the
  results. Iterations are counted in `response.metadata.iterationCount`. Human-in-the-loop approval
  (`…HitlTool` nodes, synthesized from every "send and wait" node) plugs into the same request/response
  mechanism.
* Newer layers, all built on the Vercel AI SDK rather than LangChain:
  * **`@n8n/agents`**: a code-first agent SDK (`new Agent(name).model().tool().memory()…`) with approvals,
    suspend/resume, checkpoints, sub-agents and evals.
  * **n8n "Agents"**: standalone, JSON-configured agents, separate from workflows, called from workflows
    with the **Message an Agent** node.
  * **`@n8n/instance-ai`**: the in-product "n8n Assistant" deep agent.
  * **`@n8n/ai-workflow-builder`**: generates workflows from a prompt. The newest path has the LLM edit a
    TypeScript file written with `@n8n/workflow-sdk`, which is then parsed to workflow JSON.

---

## 1. Cluster-node architecture

### 1.1 Connection types

`WF/interfaces.js`:

```js
export const NodeConnectionTypes = {
    AiAgent: 'ai_agent',
    AiChain: 'ai_chain',
    AiDocument: 'ai_document',
    AiEmbedding: 'ai_embedding',
    AiLanguageModel: 'ai_languageModel',
    AiMemory: 'ai_memory',
    AiOutputParser: 'ai_outputParser',
    AiRetriever: 'ai_retriever',
    AiReranker: 'ai_reranker',
    AiTextSplitter: 'ai_textSplitter',
    AiTool: 'ai_tool',
    AiVectorStore: 'ai_vectorStore',
    Main: 'main',
};
```

`main` carries items. Every other type carries a **capability object**. `ai_agent` and `ai_chain` exist but
are hardly used. `getConnectionHintNoticeField([AiAgent])` uses `ai_agent` only for the "connect this to an
agent" notice.

### 1.2 Root nodes vs sub-nodes

From the docs (docs.n8n.io → cluster nodes / "LangChain in n8n"): a cluster node has *"a root node that
defines the cluster's main functionality, with one or more sub-nodes attached to extend it"*. Root nodes
are chains, agents and vector stores. Sub-nodes are language models, memory, tools, retrievers,
embeddings, document loaders, output parsers and text splitters. *"Memory sub-nodes only attach to the AI
Agent root node."*

Root versus sub-node is **not a declared flag**. It falls out of the port types. The editor classifies
nodes like this (de-minified from `UI/`, `useNodeTypesStore`):

```js
// isConfigNode  → rendered as a small round "sub-node"
h = (workflow, node, nodeType) => { …; let outputs = getNodeOutputs(workflow, node, desc);
      return outputs ? outputs.filter(t => t !== 'main').length > 0 : false }
// isConfigurableNode → rendered wide, with bottom slots ("root node")
w = (workflow, node, nodeType, version) => { …; let inputs = getNodeInputs(workflow, node, desc);
      return inputs ? inputs.filter(t => t !== 'main').length > 0 : false }
// isToolNode
_ = nodeType => outputs.map(o => typeof o === 'string' ? o : o.type).includes('ai_tool')
```

Handle placement on the canvas (from `UI/`, the `CanvasNode` composable):

```js
te = ee({ mode: Input,  position: Position.Left,   offsetAxis: 'top'  }),  // main inputs
ne = ee({ mode: Input,  position: Position.Bottom, offsetAxis: 'left' }),  // non-main inputs = bottom slots
re = ee({ mode: Output, position: Position.Right,  offsetAxis: 'top'  }),  // main outputs
ie = ee({ mode: Output, position: Position.Top,    offsetAxis: 'left' })   // non-main outputs (sub-node top)
```

An edge is valid only between handles of the **same type** and opposite modes:

```js
function isValidConnection(e) { let {type:t, mode:n} = parse(e.sourceHandle), {type:r, mode:i} = parse(e.targetHandle);
  return n !== i && t === r }
```

Nodes can be both root and sub-node, or switch role based on a parameter:

* **Vector stores** change their ports with `mode` (`AIU/utils/vector-store/createVectorStoreNode/createVectorStoreNode.js`):

  ```js
  outputs: `={{ ((parameters) => { const mode = parameters?.mode ?? 'retrieve';
      if (mode === 'retrieve-as-tool') return [{ displayName: "Tool", type: "ai_tool"}]
      if (mode === 'retrieve') return [{ displayName: "Vector Store", type: "ai_vectorStore"}]
      return [{ displayName: "", type: "main"}] })($parameter) }}`,
  inputs: `={{ … const inputs = [{ displayName: "Embedding", type: "ai_embedding", required: true, maxConnections: 1}]
      if (['load','retrieve','retrieve-as-tool'].includes(mode) && useReranker) inputs.push({ … type: "ai_reranker" …})
      if (mode === 'retrieve-as-tool') return inputs;
      if (['insert','load','update'].includes(mode)) inputs.push({ displayName: "", type: "main"})
      if (['insert'].includes(mode)) inputs.push({ displayName: "Document", type: "ai_document", required: true, maxConnections: 1})
      return inputs })($parameter) }}`,
  ```
* **Sub-nodes with their own sub-node inputs.** Examples: Model Selector (N × `ai_languageModel` in, one
  `ai_languageModel` out), Vector Store Tool, retrievers, and the HITL tool (`ai_tool` in, `ai_tool` out).

### 1.3 How a root node declares its inputs (the Agent)

`LC/nodes/agents/Agent/V3/AgentV3.node.js`. `inputs` is an **expression string**. It inlines a JS function
with `Function.prototype.toString()` and is evaluated against the node's own parameters:

```js
inputs: `={{
    ((hasOutputParser, needsFallback) => {
        ${utils_1.getInputs.toString()};
        return getInputs(true, hasOutputParser, needsFallback);
    })($parameter.hasOutputParser === undefined || $parameter.hasOutputParser === true,
       $parameter.needsFallback !== undefined && $parameter.needsFallback === true)
}}`,
outputs: [NodeConnectionTypes.Main],
```

`LC/nodes/agents/Agent/utils.js`:

```js
function getInputs(hasMainInput, hasOutputParser, needsFallback) {
    const getInputData = (inputs) => inputs.map(({ type, filter, displayName, required }) => {
        const input = { type, displayName, required,
            maxConnections: ['ai_languageModel', 'ai_memory', 'ai_outputParser'].includes(type) ? 1 : undefined };
        if (filter) input.filter = filter;
        return input;
    });
    let specialInputs = [
        { type: 'ai_languageModel', displayName: 'Chat Model', required: true,
          filter: { excludedNodes: ['@n8n/n8n-nodes-langchain.lmCohere', '@n8n/n8n-nodes-langchain.lmOllama',
                                    'n8n/n8n-nodes-langchain.lmOpenAi', '@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference'] } },
        { type: 'ai_languageModel', displayName: 'Fallback Model', required: true, filter: { /* same */ } },
        { displayName: 'Memory', type: 'ai_memory' },
        { displayName: 'Tool', type: 'ai_tool' },
        { displayName: 'Output Parser', type: 'ai_outputParser' },
    ];
    if (hasOutputParser === false) specialInputs = specialInputs.filter((i) => i.type !== 'ai_outputParser');
    if (needsFallback === false)  specialInputs = specialInputs.filter((i) => i.displayName !== 'Fallback Model');
    const mainInputs = hasMainInput ? ['main'] : [];
    return [...mainInputs, ...getInputData(specialInputs)];
}
```

The input-configuration fields in use are `type`, `displayName`, `required`, `maxConnections`, and
`filter: { nodes?: string[], excludedNodes?: string[] }`. Two inputs of the same type (`Chat Model`,
`Fallback Model`) are told apart only by **index**. `getChatModel(ctx, 1)` reverses the connected array to
get the fallback:

```js
const connectedModels = await ctx.getInputConnectionData('ai_languageModel', 0);
… const reversedModels = [...connectedModels].reverse(); model = reversedModels[index];
if (!isChatInstance(model) || !model.bindTools) throw new NodeOperationError(…, 'Tools Agent requires Chat Model which supports Tools calling');
```

The JS expression cannot be read without running it. For the AI workflow builder, n8n therefore duplicates
the port contract **declaratively** in `builderHint`:

```js
builderHint: { inputs: {
    ai_languageModel: { required: true },
    ai_memory: { required: false },
    ai_tool: { required: false },
    ai_outputParser: { required: false, displayOptions: { show: { hasOutputParser: [true] } } },
}},
```

`WF/node-helpers.js` evaluates dynamic ports with the expression engine. It does not use a JSON rule
language:

```js
function getNodeInputs(workflow, node, nodeTypeData, options = {}) {
    if (Array.isArray(nodeTypeData?.inputs)) return nodeTypeData.inputs;
    try { return workflow.expression.getSimpleParameterValue(node, nodeTypeData.inputs, 'internal', {}) || []; }
    catch (e) { …; console.warn('Could not calculate inputs dynamically for node: ', node.name); return []; }
}
```

### 1.4 Workflow JSON

Edges always go **sub-node → root**, keyed by connection type and stored under the *source*
(sub-node):

```json
"connections": {
  "OpenAI Chat Model": { "ai_languageModel": [[{ "node": "AI Agent", "type": "ai_languageModel", "index": 0 }]] },
  "Calculator":        { "ai_tool":          [[{ "node": "AI Agent", "type": "ai_tool",          "index": 0 }]] },
  "Chat Trigger":      { "main":             [[{ "node": "AI Agent", "type": "main",             "index": 0 }]] }
}
```

The builder's `connect_nodes` tool states the convention and auto-swaps reversed edges
(`AWB/tools/connect-nodes.tool.js`, `utils/connection.utils.js`):

> `sourceNodeId`: "For ai_* connections (ai_languageModel, ai_tool, etc.), use the sub-node (e.g., OpenAI Chat
> Model)." / `"Auto-corrected connection: … (Note: Swapped nodes to ensure sub-node is the source)"`

### 1.5 Bottom slots in the editor

* A root node is drawn wide. Each non-main input becomes a labelled bottom handle (`displayName`: "Chat
  Model", "Memory", "Tool", "Output Parser"). A `required` handle that is empty raises the issue
  `"No node connected to required input \"{inputName}\""` (`nodeIssues.input.missing`).
* Each bottom handle has a **"+"**. It opens the node creator filtered to nodes whose *outputs* contain that
  connection type (`visibleNodeTypesByOutputConnectionTypeNames`), minus `filter.excludedNodes` (or
  limited to `filter.nodes`). When `maxConnections` is reached, no more connections can be added. Parameter
  notices can open the same filtered creator through an HTML action:

  ```js
  displayName: `Connect an <a data-action='openSelectiveNodeCreator'
                data-action-parameter-connectiontype='ai_outputParser'>output parser</a> on the canvas …`
  ```
* Node-creator categories come from each node's `codex.subcategories`. `AI: ['Agents', 'Root Nodes']` for
  the agent, `AI: ['Tools'], Tools: ['Recommended Tools' | 'Other Tools']` for tools, and so on. The UI
  names them "Agents", "Chains", "Language Models", "Memory", "Tools", "Vector Stores", "Output Parsers",
  "Human review", and "MCP servers" ("Add a toolset from an external MCP server").

---

## 2. `supplyData`: how sub-nodes hand objects to the parent

### 2.1 The contract

A sub-node implements `supplyData(this: ISupplyDataFunctions, itemIndex): Promise<SupplyData>`, where
`SupplyData = { response: unknown; closeFunction?: () => Promise<void> }`. Examples:

```js
// LC/nodes/llms/LMChatAnthropic/LmChatAnthropic.node.js
inputs: [], outputs: [NodeConnectionTypes.AiLanguageModel], outputNames: ['Model'],
async supplyData(itemIndex) {
    const credentials = await this.getCredentials('anthropicApi');
    const modelName = this.getNodeParameter('model.value', itemIndex);
    …
    const model = new ChatAnthropic({ anthropicApiKey: credentials.apiKey, model: modelName, …,
        callbacks: [ new N8nLlmTracing(this, { tokensUsageParser: anthropicTokensUsageParser, … }) ],
        onFailedAttempt: makeN8nLlmFailedAttemptHandler(this, failedAttemptHandler), invocationKwargs, … });
    return { response: model };
}

// LC/nodes/memory/MemoryBufferWindow/MemoryBufferWindow.node.js
async supplyData(itemIndex) {
    const contextWindowLength = this.getNodeParameter('contextWindowLength', itemIndex);
    const sessionId = getSessionId(this, itemIndex);
    const memory = await MemoryChatBufferSingleton.getInstance().getMemory(`${workflowId}__${sessionId}`,
        { k: contextWindowLength, inputKey: 'input', memoryKey: 'chat_history', outputKey: 'output', returnMessages: true });
    return { response: logWrapper(memory, this) };
}
```

### 2.2 `getInputConnectionData` (the resolver)

`CORE/execution-engine/node-execution-context/utils/get-input-connection-data.js` (key parts):

```js
async function getInputConnectionData(workflow, runExecutionData, parentRunIndex, connectionInputData, parentInputData,
                                      additionalData, executeData, mode, closeFunctions, connectionType, itemIndex, abortSignal) {
    const parentNode = this.getNode();
    const inputConfigurations = this.nodeInputs.filter((input) => input.type === connectionType);
    …
    const maxConnections = inputConfigurations.reduce((acc, cur) => cur.maxConnections !== undefined ? acc + cur.maxConnections : acc, 0);
    const connectedNodes = this.getConnectedNodes(connectionType);
    validateInputConfiguration(this, connectionType, inputConfigurations, connectedNodes); // "A {displayName} sub-node must be connected and enabled"
    if (connectedNodes.length === 0) return maxConnections === 1 ? undefined : [];
    if (maxConnections && connectedNodes.length > maxConnections) throw … `Only ${maxConnections} ${connectionType} sub-nodes are/is allowed to be connected`;
    const nodes = [];
    for (const connectedNode of connectedNodes) {
        if (isHitlToolType(connectedNode?.type)) { nodes.push(await createHitlToolSupplyData(…)); continue; }
        const connectedNodeType = workflow.nodeTypes.getByNameAndVersion(connectedNode.type, connectedNode.typeVersion);
        const contextFactory = (runIndex, inputData) => new SupplyDataContext(workflow, connectedNode, additionalData, mode,
            runExecutionData, runIndex, connectionInputData, inputData, connectionType, executeData, closeFunctions, abortSignal, parentNode);
        if (!connectedNodeType.supplyData) {
            if (connectedNodeType.description.outputs.includes('ai_tool')) {          // ← regular node used as tool
                nodes.push(createNodeAsTool({ node: connectedNode, nodeType: connectedNodeType,
                    handleToolInvocation: makeHandleToolInvocation((i) => contextFactory(i, {}), connectedNode, connectedNodeType, runExecutionData),
                    context: contextFactory(parentRunIndex, parentInputData), itemIndex }));
            } else throw new UnexpectedError('Node does not have a `supplyData` method defined', …);
        } else {
            const context = contextFactory(parentRunIndex, parentInputData);
            try {
                const supplyData = await connectedNodeType.supplyData.call(context, itemIndex);
                extendResponseMetadata(supplyData.response, connectedNode);   // tool.metadata.sourceNodeName = node.name
                if (supplyData.closeFunction) closeFunctions.push(supplyData.closeFunction);
                nodes.push(supplyData);
            } catch (error) {
                … await context.addExecutionDataFunctions('input', error, connectionType, parentNode.name, currentNodeRunIndex);
                  await context.addExecutionDataFunctions('output', error, connectionType, parentNode.name, currentNodeRunIndex);
                throw new NodeOperationError(connectedNode, `Error in sub-node ${connectedNode.name}`, { functionality: 'configuration-node', … });
            }
        }
    }
    return maxConnections === 1 ? (nodes || [])[0]?.response : nodes.map((node) => node.response);
}
```

Points that matter for a design:

* **Cardinality determines the return shape.** If the summed `maxConnections` is 1, the caller gets a single
  object. Otherwise it gets an array. `required` is enforced at runtime, not only in the editor.
* `supplyData` runs **lazily, every time the parent asks**, with the parent's `itemIndex`. AI Agent v3 asks
  for model, memory and tools with `itemIndex = 0` (`getInputConnectionData(AiLanguageModel, 0)`,
  `getOptionalMemory(ctx)` → `getInputConnectionData(AiMemory, 0)`). So sub-node parameters such as a
  memory `sessionKey` are resolved **against the first input item** for the whole batch. The builder hint
  warns that sub-nodes don't share the main item context: *"Inside subnodes, reference upstream data with
  `nodeJson(triggerNode, 'path')`, not `$json` — subnodes do not share the main predecessor's item context."*
* A sub-node may itself call `getInputConnectionData`, which gives recursive clusters (Vector Store Tool
  → vector store → embeddings).
* `closeFunction`s (for example closing an MCP client) run when the parent's `execute` finishes.
* **Toolkits.** One sub-node can supply many tools by returning `new StructuredToolkit(tools)`
  (`CORE/…/ai-tool-types.js`). The agent flattens them and marks `metadata.isFromToolkit = true`.

### 2.3 How sub-node activity shows up in run data and logs

The sub-node never "runs" as a scheduled node. Wrappers call `SupplyDataContext.addInputData` /
`addOutputData` to **write synthetic task entries** (`CORE/…/supply-data-context.js`):

```js
async addExecutionDataFunctions(type, data, connectionType, sourceNodeName, currentNodeRunIndex, metadata, sourceNodeRunIndex) {
    const source = this.parentNode ? [{ previousNode: this.parentNode.name, previousNodeRun: sourceNodeRunIndex ?? currentRunIndex }] : [];
    if (type === 'input') {
        taskData = { startTime: Date.now(), executionTime: 0, executionIndex: additionalData.currentNodeExecutionIndex++,
                     executionStatus: 'running', source };
    } else { taskData = get(runExecutionData, ['resultData','runData', nodeName, currentNodeRunIndex]); taskData.source = source; }
    if (data instanceof Error) { taskData.executionStatus = 'error'; taskData.error = data; }
    else { if (type === 'output') taskData.executionStatus = 'success'; taskData.data = { [connectionType]: data }; }
    if (type === 'input') {
        taskData.inputOverride = { [connectionType]: data };
        runExecutionData.resultData.runData[nodeName][currentNodeRunIndex] = taskData;
        await additionalData.hooks?.runHook('nodeExecuteBefore', [nodeName, taskData]);
    } else {
        taskData.executionTime = Date.now() - taskData.startTime;
        await additionalData.hooks?.runHook('nodeExecuteAfter', [nodeName, taskData, this.runExecutionData]);
        // parent ↔ child index used by the logs tree:
        runExecutionData.executionData.metadata[sourceNodeName][currentNodeRunIndex].subRun.push({ node: nodeName, runIndex: currentNodeRunIndex });
    }
}
```

So every LLM call, memory read or write, and tool call becomes `runData["OpenAI Chat Model"][k]` with:

* `inputOverride.ai_languageModel = [[{ json: { messages, estimatedTokens, options } }]]`
* `data.ai_languageModel = [[{ json: { response: { generations }, tokenUsage | tokenUsageEstimate } }]]`
* `source = [{ previousNode: "AI Agent", previousNodeRun }]`

The same `nodeExecuteBefore/After` hooks push them live to the UI.

**LLM tracing** is a LangChain callback (`AIU/utils/n8n-llm-tracing.js`):

```js
async handleLLMStart(llm, prompts, runId) {
    const estimatedTokens = await this.estimateTokensFromStringList(prompts);
    const options = redactHeaderValues(llm.type === 'constructor' ? llm.kwargs : llm, this.options.redactedHeaders ?? []);
    const { index } = this.executionFunctions.addInputData(this.connectionType /* 'ai_languageModel' */,
        [[{ json: { messages: prompts, estimatedTokens, options } }]], sourceNodeRunIndex);
    this.runsMap[runId] = { index, options, messages: prompts };
}
async handleLLMEnd(output, runId) {
    const tokenUsage = this.options.tokensUsageParser(output);
    const response = { response: { generations: output.generations } };
    if (tokenUsage.completionTokens > 0) response.tokenUsage = tokenUsage; else response.tokenUsageEstimate = tokenUsageEstimate;
    this.executionFunctions.addOutputData(this.connectionType, runDetails.index, [[{ json: { ...response } }]], undefined, sourceNodeRunIndex);
    logAiEvent(this.executionFunctions, 'ai-llm-generated-output', { messages: parsedMessages, options: runDetails.options, response });
}
```

**`logWrapper(instance, ctx)`** (`AIU/utils/log-wrapper.js`) is a `Proxy` that intercepts methods on memory
(`loadMemoryVariables`, `saveContext`, chat-history `getMessages` / `addMessage`), retrievers, embeddings,
rerankers, document loaders, text splitters, tools and vector stores. It records input and output the same
way and emits AI events: `ai-messages-retrieved-from-memory`, `ai-message-added-to-memory`,
`ai-documents-retrieved`, `ai-document-embedded`, `ai-query-embedded`, `ai-document-reranked`,
`ai-document-processed`, `ai-text-split`, `ai-tool-called`, `ai-vector-store-searched`,
`ai-llm-generated-output`. These events go to log streaming.

The root node also stamps OpenTelemetry-style tracing metadata
(`LC/…/ToolsAgent/V3/execute.js`):
`'ai.agent.version','ai.agent.streaming.enabled','ai.agent.items.total','ai.agent.items.failed','ai.agent.tool_calls.requested','ai.agent.tool_calls.completed','ai.agent.iteration.count','ai.agent.memory.loads','ai.agent.memory.saves','ai.agent.execution.succeeded'`.

### 2.4 The public AI node SDK (`@n8n/ai-node-sdk`, preview)

This is a LangChain-free way to write sub-nodes. Its README (in the package) says: *"Public SDK for building AI
nodes in n8n. This package provides a simplified API for creating chat model and memory nodes without
LangChain dependencies."* Exports, all re-exported from `@n8n/ai-utilities`:
`supplyModel, supplyMemory, BaseChatModel, BaseChatHistory, BaseChatMemory, WindowedChatMemory,
parseSSEStream, getParametersJsonSchema`. `AI_NODE_SDK_VERSION = 1`.

```ts
// Simple: OpenAI-compatible provider → just return a config
return supplyModel(this, { type: 'openai', baseUrl: credentials.url, apiKey: credentials.apiKey, model, temperature });

// Advanced: custom provider
class MyProviderChatModel extends BaseChatModel {
  async generate(messages: Message[], config?: ChatModelConfig): Promise<GenerateResult> { … return {
      finishReason: 'stop',
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
      usage: { promptTokens, completionTokens, totalTokens } } }
  async *stream(messages, config): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', delta: '…' }; yield { type: 'finish', finishReason: 'stop' } }
}
return supplyModel(this, chatModel);   // wrapped in LangchainChatModelAdapter + N8nLlmTracing

// Memory
class MyDbChatHistory extends BaseChatHistory { getMessages(); addMessage(message); clear() }
return supplyMemory(this, new WindowedChatMemory(history, { windowSize }));
```

`supplyModel` (`AIU/suppliers/supplyModel.js`) turns `{type:'openai', …}` into a `ChatOpenAI` with tracing.
Anything else becomes a `LangchainChatModelAdapter`. This **config vs. implementation** split is the
pattern Landflow should copy for remote model providers (see §7).

---

## 3. Tools

### 3.1 `usableAsTool`: turning any node into a tool

A node opts in with `usableAsTool: true` or `usableAsTool: { replacements: {...} }`. About 273 files in
`n8n-nodes-base` do. Example (HTTP Request V3):

```js
usableAsTool: { replacements: { codex: { subcategories: { Tools: ['Recommended Tools'] } } } },
```

When nodes are loaded, the CLI appends a synthetic description for each such node
(`CLI/tool-generation/ai-tools.js`):

```js
function convertNodeToAiTool(item) {
    if (isFullDescription(item.description)) {
        item.description.name += 'Tool';
        item.description.inputs = [];
        item.description.outputs = [NodeConnectionTypes.AiTool];
        item.description.displayName += ' Tool';
        delete item.description.usableAsTool;
        const hasResource = …some(p => p.name === 'resource'); const hasOperation = …some(p => p.name === 'operation');
        if (!…includes('toolDescription')) {
            const descriptionType = { displayName: 'Tool Description', name: 'descriptionType', type: 'options',
                options: [{ name: 'Set Automatically', value: 'auto', description: 'Automatically set based on resource and operation' },
                          { name: 'Set Manually',      value: 'manual' }], default: 'auto' };
            const descProp = { displayName: 'Description', name: 'toolDescription', type: 'string',
                default: item.description.description, required: true,
                description: 'Explain to the LLM what this tool does, a good, specific description would allow LLMs to produce expected results much more often' };
            …splice(lastCallout + 1, 0, descProp); if (hasResource || hasOperation) { …splice(…, descriptionType); descProp.displayOptions = { show: { descriptionType: ['manual'] } }; }
        }
    }
    setToolCodex(item.description, 'Other Tools', true);   // codex: AI → Tools → Other Tools
    return item;
}
function createAiTools(types, known) {
    for (const usableNode of types.nodes.filter((n) => Boolean(n.usableAsTool))) {
        const description = typeof usableNode.usableAsTool === 'object'
            ? { ...deepCopy(usableNode), ...usableNode.usableAsTool?.replacements } : deepCopy(usableNode);
        types.nodes.push(convertNodeToAiTool({ description }).description);
        known.nodes[wrapped.name] = { ...known.nodes[usableNode.name] };
        copyCredentialSupport(known, usableNode.name, wrapped.name);
    }
}
```

At runtime, `NodeTypes.getByNameAndVersion("n8n-nodes-base.slackTool")` sees a name that ends in `Tool` and
is not a real node. It strips the suffix, clones the base node with `Object.create`, converts it, and caches
it under `"<type>?version=<v>"` (`CLI/node-types.js`). The synthetic tool **keeps the base node's `execute`**.
It has no `supplyData`, so the core path `createNodeAsTool` (§2.2) wraps it.

`createNodeAsTool` (`CORE/…/utils/create-node-as-tool.js`):

```js
function createTool({ node, nodeType, handleToolInvocation, context, itemIndex }) {
    const schema = getSchema(node);                       // ← from $fromAI() placeholders
    const description = NodeHelpers.getToolDescriptionForNode(node, nodeType, resolveToolDescription);
    const name = nodeNameToToolName(node) || nodeType.description.name;   // node *name*, sanitized
    return new DynamicStructuredTool({ name, description, schema,
        func: async (toolArgs) => await handleToolInvocation(toolArgs), metadata: { sourceNodeName: node.name } });
}
function getSchema(node) {
    traverseNodeParameters(node.parameters, collectedArguments);       // find every $fromAI(...) in every parameter
    const nameValidationRegex = /^[a-zA-Z0-9_-]{1,64}$/;  … duplicate key with different description/type → error
    return z.object(Object.fromEntries(unique.map(a => [a.key, generateZodSchema(a)]))).required();
}
```

* The tool name is the **node name**, sanitized (`WF/tool-helpers.js`): `name.replace(/[^a-zA-Z0-9_-]+/g, '_')`,
  truncated to `MAX_TOOL_NAME_LENGTH = 64` ("the maximum length allowed by OpenAI's API").
* With "Set Automatically", the description is derived from resource and operation (`makeDescription`).
  Otherwise the `toolDescription` parameter is used, and it may be an expression.
* In-process invocation (`makeHandleToolInvocation`) feeds the args as a single item on the `ai_tool` input.
  It runs `nodeType.execute` and honors `retryOnFail` (2–5 tries). It returns
  `JSON.stringify(result[0].flatMap(i => i.json))`. Binary-only output gives
  `'Error: The Tool attempted to return binary data, which is not supported in Agents'`.

### 3.2 `$fromAI()`

Docs signature: `$fromAI(key, description, type, defaultValue)`. `key` must be 1–64 characters from
`[a-zA-Z0-9_-]`. `type` is one of `string | number | boolean | json` (default `string`). Examples:
`{{ $fromAI("numItemsInStock", "Number of items in stock", "number", 5) }}`, `Generated by AI: {{ $fromAI("subject") }}`.
It *"works only for tools connected to the AI Agent node"*. In the UI, every eligible field has a
**"Let the model define this parameter"** (star) button, which inserts an auto-generated expression marked
`FROM_AI_AUTO_GENERATED_MARKER = '/*n8n-auto-generated-fromAI-override*/'`.

Two halves:

1. **Schema extraction**, statically, before calling the model (`WF/from-ai-parse-utils.js`):

   ```js
   function generateZodSchema(placeholder) {
       switch (placeholder.type?.toLowerCase()) {
           case 'string': schema = z.string(); break;   case 'number': schema = z.number(); break;
           case 'boolean': schema = z.boolean(); break;
           case 'json': /* non-empty object or array; jsonSchema anyOf [{type:'object',minProperties:1},{type:'array',minItems:1}] */
           default: schema = z.string();
       }
       if (placeholder.description) schema = schema.describe(…);
       if (placeholder.defaultValue !== undefined) schema = schema.default(placeholder.defaultValue);
       return schema;
   }
   ```
2. **Runtime resolution** inside the expression engine (`WF/workflow-data-proxy.js`). `$fromAI` reads the
   model's arguments from the tool node's `inputOverride.ai_tool` for the current run:

   ```js
   const handleFromAi = (name, _description, _type = 'string', defaultValue) => {
       … validate name …
       const resultData = that.runExecutionData?.resultData?.runData?.[that.activeNodeName]?.[runIndex];
       if (!resultData) { placeholdersDataInputData = this.connectionInputData?.[runIndex]?.json; }
       else { inputData = …runData[that.activeNodeName]?.[runIndex].inputOverride;
              placeholdersDataInputData = inputData?.['ai_tool']?.[0]?.[itemIndex].json; }
       if (!placeholdersDataInputData) throw new ExpressionError('No execution data available', …);
       return (readOwnKey(readOwnKey(placeholdersDataInputData, 'query'), name) ??
               readOwnKey(placeholdersDataInputData, name) ?? defaultValue);   // own keys only (prototype-safe)
   };
   // `$tool` (used in HITL messages) is built on the same mechanism:
   const handleTool = () => ({ name: handleFromAi('tool', ''), parameters: handleFromAi('toolParameters', '') });
   ```

   The engine (§4.3) or `makeHandleToolInvocation` writes that `inputOverride` before `execute` runs, so
   ordinary `getNodeParameter()` calls resolve to model-chosen values. The node itself needs no AI code.

The editor's tool test dialog (`fromAiParametersModal`) shows "Test {nodeName}" and *"Provide the data that
would normally come from the "{parentNodeName}" node"*. It asks the user for the `$fromAI` values, so a tool
can be executed by itself.

### 3.3 Code Tool (`toolCode`, v1–1.3)

`LC/nodes/tools/ToolCode/ToolCode.node.js` is a real sub-node: `inputs: [], outputs: ['ai_tool']`. It
implements **both** `supplyData` (in-process LangChain tool) and `execute` (for the engine-driven loop):

```js
const toolHandler = async (query) => {
    const { index } = log ? ctx.addInputData('ai_tool', [[{ json: { query } }]]) : { index: 0 };
    response = await runFunction(query);                 // JsTaskRunnerSandbox(...{ query }).runCodeForTool(code) / Python
    if (typeof response !== 'string') { executionError = …'Wrong output type returned' }
    log && ctx.addOutputData('ai_tool', index, executionError ?? [[{ json: { response } }]]);
    logAiEvent(ctx, 'ai-tool-called', { query, response });
    return response;
};
tool = useSchema ? new DynamicStructuredTool({ schema: convertJsonSchemaToZod(jsonSchema), name, description, func: toolHandler })
                 : new DynamicTool({ name, description, func: toolHandler });
…
async supplyData(itemIndex) { return { response: getTool(this, itemIndex) }; }
async execute() { for each item: result.push({ json: { response: await getTool(this, i, false).invoke(item.json) } }) }
```

Parameters: Description, Language (JavaScript / Python (Beta)), code ("access the input … via the input
property `query`"; it must return a string), and Specify Input Schema (from a JSON example or a JSON
Schema). For v ≥ 1.2 the name is the node name.

### 3.4 HTTP Request Tool

* The legacy `@n8n/n8n-nodes-langchain.toolHttpRequest` (v1, 1.1) is now `hidden: true`. It used
  `{placeholder}` syntax with a "placeholders" definition list.
* The current version is the synthetic `n8n-nodes-base.httpRequestTool`, made from HTTP Request V3's
  `usableAsTool`. Every field can be `$fromAI`-driven.

### 3.5 Workflow Tool ("Call n8n Workflow Tool", `toolWorkflow` v2.x)

`LC/nodes/tools/ToolWorkflow/v2/`. The description says *"This tool will call the workflow you define below,
and look in the last node for the response. The workflow needs to start with an Execute Workflow trigger"*.
Parameters: Source (Database / Define Below), Workflow (resource locator), **Workflow Inputs** (a resource
mapper over the sub-workflow trigger's declared inputs, typically filled with `$fromAI`), or Workflow JSON.
`WorkflowToolService.createTool` does the following:

* builds the schema from `extractFromAIParameters(node.parameters)` → `createZodSchemaFromArgs`;
* calls `context.executeWorkflow(workflowInfo, items, …)`;
* records `subExecution: { executionId, workflowId }` metadata, so the logs link to the child execution;
* for v > 2, returns all items (`returnAllItems`).

### 3.6 MCP

* **MCP Client Tool** (`mcpClientTool` v1–1.4) is a sub-node with
  `outputs: [{ type: 'ai_tool', displayName: 'Tools' }]`.
  * Transport: SSE or **HTTP Streamable** (the default from 1.2).
  * Auth: Bearer, Header, MCP OAuth2, Multiple Headers, or None.
  * "Tools to Include": All / Selected / All Except.
  * `supplyData` connects, runs `listTools` (paginated), and wraps each MCP tool as a `DynamicStructuredTool`
    named `buildMcpToolName(node.name, tool.name)` (prefixed). It returns
    `{ response: new StructuredToolkit(tools), closeFunction: () => client.close() }`.
  * `execute` (engine path) reads `item.json.tool` to pick the tool. It filters arguments to the tool's
    `inputSchema.properties` and calls `client.callTool`. It returns `{ response: result.content, structuredContent? }`.
    From v1.4, the MCP session is cached per execution (`McpClientsManager`, key `${executionId}:${node.name}`).
* **MCP Client** (non-tool action node) and **MCP Registry Client Tool** (one-click registry servers) also
  exist.
* **MCP Server Trigger** (`mcpTrigger` v1–2.1) uses `inputs: [{ type: 'ai_tool', displayName: 'Tools' }], outputs: []`.
  It exposes every connected tool sub-node to external MCP clients over SSE or Streamable HTTP. It has
  test and production URLs, a random path by default, and auth None / Bearer / Header. Per the docs, in
  queue mode all `/mcp*` traffic has to go to one replica.
* At the instance level, the server also exposes an **n8n MCP server**: tools such as `search_workflows`,
  `execute_workflow`, `test_workflow`, `get_workflow_details`, `publish_workflow`, and `workflow-builder` /
  `create_workflow_from_code` in `CLI/modules/mcp/tools/`. **`@n8n/mcp-apps`** adds MCP Apps UI resources.
  Its only app, `workflow-preview`, renders the created workflow inside MCP clients that support the
  ext-apps extension.

### 3.7 AI Agent Tool (multi-agent) and other tool types

* **AI Agent Tool** (`agentTool`, AgentToolV3) uses the same `getInputs`, but with `hasMainInput=false`:
  `inputs: ={{ … getInputs(false, hasOutputParser, needsFallback) }}`, `outputs: ['ai_tool']`, plus a
  `toolDescription`. A sub-agent cannot return engine requests to its parent, so it resolves its own
  tool calls **inline** (`resolveSubAgentRequest`). HITL is rejected there: *"Human-in-the-Loop nodes cannot
  be used inside a sub-agent. Move "{node}" to the top-level workflow."*
* **Message an Agent / Message an Agent Tool** (`n8n-nodes-base.messageAnAgent`, `usableAsTool: true`)
  calls a standalone n8n Agent (§5.2).
* **Vector store in `retrieve-as-tool` mode**, plus Calculator, Think, Wikipedia, SerpApi, SearXNG,
  WolframAlpha and Vector Store Tool.
* **Tool Executor** (hidden). It has `main` + `ai_tool` inputs and is *"Node to execute tools without an AI
  Agent"*. It is used by evaluations and the builder.

---

## 4. The AI Agent node

### 4.1 Versions

`LC/nodes/agents/Agent/Agent.node.js`:
`displayName: 'AI Agent'`, `name: 'agent'`, `defaultVersion: 3.1`, `codex.subcategories.AI: ['Agents','Root Nodes']`.

| typeVersion | Class | Behaviour |
|---|---|---|
| 1 – 1.9 | `AgentV1` | User picks `agent`: `toolsAgent`, `conversationalAgent`, `openAiFunctionsAgent`, `planAndExecuteAgent`, `reActAgent`, `sqlAgent`. Docs: the agent type setting is deprecated since 1.82.0 and the v1 node "will be removed from n8n 3.0". |
| 2 – 2.3 | `AgentV2` | Tools Agent only. LangChain `AgentExecutor.fromAgentAndTools({ … maxIterations: options.maxIterations ?? 10 })` runs **in-process**. Tools are invoked through their `supplyData` objects (§2.2). Streaming from 2.1. |
| 3, 3.1 | `AgentV3` | Tools Agent, **engine-driven tool loop** (§4.3), HITL, fallback model. 3.1 changes the prompt-type options. |

### 4.2 Parameters and options (v3)

* **Source for Prompt** (`promptType`):
  * `auto`: "Connected Chat Trigger Node". It reads `{{ $json["chatInput"] }}`.
  * `define`: the `text` parameter.
  * `guardrails`: reads `{{ $json["guardrailsInput"] }}` (from the Guardrails node).
* **Require Specific Output Format** (`hasOutputParser`, default false). It adds the Output Parser slot.
* **Enable Fallback Model** (`needsFallback`). It adds the Fallback Model slot.
* **Options** (`LC/…/ToolsAgent/options.js`, `V3/description.js`):

| Option | name | Default |
|---|---|---|
| System Message | `systemMessage` | `'You are a helpful assistant'` |
| Max Iterations | `maxIterations` | `10` |
| Return Intermediate Steps | `returnIntermediateSteps` | `false` |
| Automatically Passthrough Binary Images | `passthroughBinaryImages` | `true` |
| Automatically Passthrough Binary PDFs | `passthroughBinaryPdfs` | `false` |
| Tracing Metadata | `tracingMetadata` | key/type/value list |
| Enable Streaming | `enableStreaming` | `true` |
| Batch Processing | `batching.batchSize` / `delayBetweenBatches` | `1` / `0` |
| Force Tool Call on First Iteration | `forceToolCallOnFirstIteration` | `false` (uses `bindTools(tools, { tool_choice: 'any' })`) |
| Auto-save highlighted data | `autoSaveHighlightedData` | true |
| (hidden) Max Tokens To Read From Memory | `maxTokensFromMemory` | `0` = all |

Prompt assembly (`LC/…/ToolsAgent/common.js`):

```js
messages.push(['system', `{system_message}${options.outputParser ? '\n\n{formatting_instructions}' : ''}`]);
messages.push(['placeholder', '{chat_history}'], ['human', '{input}']);
if (hasBinaryData && (passthroughBinaryImages || passthroughBinaryPdfs)) messages.push(binaryMessage);   // image/PDF parts
messages.push(['placeholder', '{agent_scratchpad}']);
```

**Structured output** is implemented as a *tool*. When an output parser is connected, a tool named
`format_final_json_response`, with the parser's schema, is added. The formatting instruction says *"you MUST
use the `format_final_json_response` tool with your complete answer formatted according to the required
schema…"*.

**Fallback model.** `createToolCallingAgent({ llm: model, tools, prompt, streamRunnable: false })`, then
`agent.withFallbacks([fallbackAgent])`. Model-native tools (`model.metadata.tools`, for example OpenAI's
built-in web search) are appended to the tool list.

### 4.3 The tool-calling loop (v3): request and response through the engine

Each agent `execute` performs **one model step** per item (`runnableAgent.singleAction = true`).

1. `buildExecutionContext` fetches the model, optional fallback and memory through `getInputConnectionData`.
   `prepareItemContext` fetches the tools (calling each tool's `supplyData` just to get name, description
   and schema). It also rebuilds `steps` (the scratchpad) from the engine response.
2. `runAgent` invokes (or streams) the LangChain runnable. If the model returned a final answer, the
   result is `{ output, intermediateSteps? }`, memory is saved, and the item is emitted on `main`. If it
   returned **tool calls**, they are turned into engine actions
   (`LC/utils/agent-execution/createEngineRequests.js`):

   ```js
   return { actionType: 'ExecutionNodeAction',
            nodeName,                                 // foundTool.metadata.sourceNodeName → the tool's node
            input,                                    // tool args (+ { tool } for toolkits, + hitlParameters)
            type: 'ai_tool',
            id: toolCall.toolCallId,
            metadata: { itemIndex, hitl: hitlMetadata, toolName: toolCall.tool,
                        ...extractThinkingMetadata(…) } };      // anthropic thinking blocks, gemini thought signatures, deepseek reasoning_content
   …
   return { actions, metadata: buildResponseMetadata(response, itemIndex) };
   // buildResponseMetadata → { previousRequests: buildSteps(response, itemIndex), itemIndex, iterationCount: (response?.metadata?.iterationCount ?? 0) + 1 }
   ```

   `toolsAgentExecute` merges the requests of all items and **returns the `EngineRequest` instead of
   output data**:
   `if (request) { if (isExecuteFunctions(this)) return request; … }`.
3. The engine (`CORE/execution-engine/workflow-execute.js` → `requests-response.js#handleRequest`) does the
   following for each action:
   * looks up the tool node and sets `node.rewireOutputLogTo = 'ai_tool'`;
   * builds its input item as
     `mergedJson = { ...agentInputItem.json, ...action.input, toolCallId: action.id }`;
   * pre-creates `runData[tool][k]` with `inputOverride: { ai_tool: displayOutputData }` (this is where
     `$fromAI` reads from) and `source: [{ previousNode: <agent> }]`;
   * pushes the tool node onto the execution stack;
   * pushes the **agent again** with
     `metadata: { nodeWasResumed: true, subNodeExecutionData: { actions:[{action,nodeName,runIndex}], metadata } }`.
4. The tool nodes run as **ordinary node executions**: their own `execute()`, credentials, retries and
   hooks. An error in an `ai_tool` execution does not stop the workflow unless the node's `onError` is
   `stopWorkflow`:

   ```js
   const isAiToolExecution = executionNode.rewireOutputLogTo === NodeConnectionTypes.AiTool;
   const aiToolDefaultsToContinue = isAiToolExecution && executionData.node.onError !== 'stopWorkflow';
   … if (isAiToolExecution) nodeSuccessData = [[{ json: { error: executionError.message } }]];
   ```
5. When the agent is popped again, `collectSubNodeResults` builds the `EngineResponse`:

   ```js
   subNodeExecutionResults.metadata = subNodeExecutionData.metadata;
   for (const subNode of subNodeExecutionData.actions)
       subNodeExecutionResults.actionResponses.push({ data: runData[subNode.nodeName][subNode.runIndex], action: subNode.action });
   ```

   It then calls `nodeType.execute.call(context, subNodeExecutionResults)`. That is why `AgentV3.execute(response)`
   takes an argument.
6. The agent turns responses back into LangChain steps (`buildSteps.js`). Each step is
   `AIMessage(tool_calls)` + observation, where
   `observation = JSON.stringify(toolData.data.ai_tool[0].map(i => i.json))`, or
   `{"error": …, "errorType": …}`. `checkMaxIterations` throws
   `"Max iterations (N) reached. The agent could not complete the task within the allowed number of iterations."`
   once `response.metadata.iterationCount >= maxIterations`. Then the loop repeats from step 2.

Memory (`memoryManagement.js`) loads the chat history before each step. The final answer is saved together
with the tool steps, rebuilt as `AIMessage{tool_calls}` + `ToolMessage` pairs. `cleanupOrphanedMessages`
drops dangling tool messages when the window cuts a pair apart.

### 4.4 Streaming and the Chat Trigger

Streaming happens only when all of these hold (`CORE/…/base-execute-context.js`):

```js
isStreaming() {
    const hasHandlers = this.additionalData.hooks?.handlers?.sendChunk?.length > 0;
    const executionModeSupportsStreaming = ['manual', 'webhook', 'integrated', 'chat'];
    return hasHandlers && executionModeSupportsStreaming.includes(this.mode) && this.additionalData.streamingEnabled === true;
}
async sendChunk(type, itemIndex, content) {
    const metadata = { nodeId: this.node.id, nodeName: this.node.name, itemIndex, runIndex: this.runIndex, timestamp: Date.now() };
    await this.additionalData.hooks?.runHook('sendChunk', [{ type, content: typeof content === 'string' ? content : JSON.stringify(content), metadata }]);
}
```

The agent then uses LangChain `streamEvents(v2)` (`processEventStream.js`). It sends
`sendChunk('begin', i)`, then `('item', i, text)` for each `on_chat_model_stream`, then `('end', i)`.
Tool calls are collected from `on_chat_model_end`, and an engine request is returned as before. The node
shows a hint: *"You are using streaming responses. Make sure to set the response mode to "Streaming
Response" on the connected trigger node."*

**Chat Trigger** (`chatTrigger` v1–1.5):

* Modes: hosted chat page or embedded webhook (`Make Chat Publicly Available`, `Mode`).
* Auth: Basic, n8n user, or none.
* It emits `{ sessionId, action, chatInput }`. "Load Previous Session" can come from memory.
* **Response Mode**:
  * `streaming`: preferred. *"the connected Agent streams its reply to the widget directly"*.
  * `lastNode`: the last node must emit `{ output: '<reply>' }`.
  * `responseNode` / `responseNodes`: uses `respondToWebhook`, or the `@n8n/n8n-nodes-langchain.chat` node
    for multi-message replies.
* Version 1.5 adds `availableInChat` for **Chat Hub**: a ChatGPT-like UI listing "Personal agents" (model +
  instructions + tools + files) and "Workflow agents" (workflows with a chat trigger).

### 4.5 Human-in-the-loop (tool approval)

The approach is **gating a tool behind an approval node**, not a flag on the tool.

1. For every node with a `sendAndWait` operation (Slack, Telegram, Gmail, Discord, Teams, the n8n Chat
   node, …), the CLI synthesizes `<name>HitlTool` (`CLI/tool-generation/hitl-tools.js`). It has
   `inputs: [{ displayName: 'Tool', type: 'ai_tool', required: true }]` and
   `outputs: [{ displayName: 'Human review', type: 'ai_tool', filter: { nodes: ['@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.agentTool'] } }]`.
   Operation and response type are fixed (`sendAndWait` / `approval`). A templated message is added:
   `'=The agent wants to run this tool: {{ $tool.name }}\n\nInput:\n{{ $tool.parameters }}'`. It appears in
   the node creator under "Human review" (*"Request approval via services like Slack and Telegram before
   making tool calls"*).
2. Wiring: Agent ←(ai_tool)— **HITL node** ←(ai_tool)— gated tools. When the agent asks for its tools,
   `getInputConnectionData` sees `isHitlToolType` (`type.endsWith('HitlTool')`). It loads the gated tools and
   re-exposes each one under its **own name**, with a wrapped schema
   (`CORE/…/get-input-connection-data.js#createHitlToolkit`):

   ```js
   schema = z.object({ toolParameters: tool.schema.describe('Input parameters for the tool'),
                       hitlParameters: hitlNodeSchema.describe('Parameters for the Human-in-the-Loop layer') });
   new DynamicStructuredTool({ name: tool.name, description: tool.description, schema, func: async () => '',
       metadata: { sourceNodeName: hitlNode.name, gatedToolNodeName: tool.metadata?.sourceNodeName, originalSchema: tool.schema } });
   ```
3. When the model calls the tool, the engine action targets the **HITL node**, which runs the
   send-and-wait. The execution goes into the *waiting* state and resumes when the human replies.
4. On resume, `processHitlResponses` checks `json.approved`. If approved, it issues a new
   `pendingGatedToolRequest` that runs the real tool with the original args
   (`metadata.parentNodeName` = HITL node). If denied, it replaces the observation with:

   > `User rejected the tool call to {tool} (id: {id}). STOP what you are doing and wait for the user to tell you how to proceed. The tool is still available if needed.`
   > or, with chat feedback: `The user reviewed your planned tool call to {tool} (id: {id}) and provided feedback: "{chatInput}". …`

The docs list the supported review channels as Chat, Slack, Discord, Telegram, Microsoft Teams, Gmail,
WhatsApp Business Cloud, Google Chat and Outlook. The reviewer channel can differ from the user channel.

---

## 5. The newer packages

### 5.1 `@n8n/agents` (0.29.5): code-first agent SDK

`package.json`: *"AI agent SDK for n8n's code-first execution engine"*. It is built on the **Vercel AI SDK**
(`ai`, `@ai-sdk/{anthropic,openai,google,…}`, `@openrouter/ai-sdk-provider`), not LangChain. It also
depends on `@modelcontextprotocol/sdk`, OpenTelemetry, and the Daytona / n8n sandbox clients. Subpath
exports: `./tool`, `./catalog`, `./sandbox`, `./vector-stores/{postgres,pinecone,qdrant,supabase}`.

**Agent builder** (`AGENTS/sdk/agent.js`). Methods:
`model(providerOrIdOrConfig, modelName)`, `instructions(text)`, `tool(t)`, `deferredTool(t)`,
`providerTool(t)`, `vectorStore(store, {description})`, `skills(...)`, `memory(m)`, `fileStore`,
`middleware`, `inputGuardrail`, `outputGuardrail`, `eval(e)`, `checkpoint(storage)`,
`structuredOutput(schema)`, `reasoning(level)`, `promptCaching(cfg)`, `telemetry(t)`,
`toolCallConcurrency(n)`, `workspace(ws)`, `mcp(client)`, `configuration({maxIterations})`,
`on(event, handler)`. Runtime methods:
`generate(input, opts)`, `stream(input, opts)`, `resume(method, data)`, `resumePaused()`, `crashResume()`,
`approve(method)`, `deny(method)`, `abort()`, `close()`.

**Tool builder** (`AGENTS/sdk/tool.js`):

```js
new Tool('get_weather')
  .description('…').systemInstruction('…')
  .input(zodOrJsonSchema).output(schema)
  .handler(async (input, ctx) => …)
  .requireApproval() | .needsApprovalFn(async (input) => boolean)    // HITL
  .suspend(schema).resume(schema)                                   // generic interrupt/resume
  .toModelOutput(fn) .toMessage(fn) .endsTurnWhen(fn) .untrustedOutput() .handleCancellation() .providerOptions(o)
  .build();   // validates: name, description, input schema and handler required; approval and suspend are mutually exclusive
```

Approval is implemented by suspending the run:

```js
APPROVAL_SUSPEND_SCHEMA = z.object({ type: z.literal('approval'), toolName: z.string(), displayName: z.string().optional(),
                                     supportsSessionApproval: z.boolean().optional(), args: z.unknown() });
APPROVAL_RESUME_SCHEMA  = z.object({ approved: z.boolean(), scope: z.enum(['once', 'session']).optional() });
… if (needs) return await interruptCtx.suspend({ type: 'approval', toolName, args, … }, { resumeSchema: APPROVAL_RESUME_SCHEMA, … });
… if (!decision.approved) return { declined: true, message: `Tool "${currentTool.name}" was not approved` };
```

**Loop** (`AGENTS/runtime/loop/agent-runtime.js`, `MAX_LOOP_ITERATIONS = 100`):

```js
for (; state.iterationCount < state.maxIterations; state.iterationCount++) {
    await this.consumeAdditionalInput(…)            // mid-run user messages ("steering")
    if (await options?.shouldPause?.()) { persistSuspension(… 'paused'); return sink.finishSuspended(…) }
    const settlement = await this.runLoopIteration(prepared, sink, state);   // model call (+guardrails, empty-turn retries)
    if (settlement.suspended) return settlement.result;                      //   → tool batch (concurrency N) → suspensions persisted
    if (state.reachedStopCondition && !options?.onInputBoundary) break;
}
// runLoopIteration: if (turn.aiFinishReason !== 'tool-calls') → stop; else iterateToolCallsConcurrent → finishToolBatch
//                   (pending tool calls ⇒ persistSuspension + checkpoint) → completeToolTurn (step checkpoint)
```

* Events (`AgentEvent`): `agent_start, agent_end, turn_start, turn_end, tool_execution_start, tool_execution_end,
  subagent_started, subagent_completed, subagent_chunk, error`.
* Finish reasons include `stop`, `max-iterations`, `guardrail`, `paused`, `error`.
* Other built-ins: delegate-sub-agent tool, write-todos / planner tools, observational and episodic memory,
  a budget guardrail, evals (`correctness`, `helpfulness`, `tool-call-accuracy`, `json-validity`, …), and
  LangSmith / OTel telemetry.

### 5.2 n8n "Agents" (the product built on it)

Docs: *"Agents are autonomous assistants you build in n8n, separate from the workflow AI Agent node"*
(Preview; self-hosted from 2.32.3). They live under a project's **Agents** tab. **Create Agent** opens
the Agent Builder. The builder has the Agent tab (name, icon, model, instructions), **Tools → Add tool**
(n8n integrations, project workflows, custom JSON-schema tools, MCP servers), Capabilities (web search),
Skills, Knowledge, Memory (session memory by default, plus episodic), sub-agents, Channels (Slack,
Telegram, Linear) and Schedules. It also has **Preview** chat, a **Sessions** tab, **Approve / Reject**
for sensitive tools, and Publish / Revert / Unpublish.

The backend is `CLI/modules/agents/` (~150 files: builder, sessions, checkpoints, integrations, scheduling,
knowledge, sub-agents). The persisted definition is **declarative JSON**
(`API/agents/agent-json-config.schema.js`):

```js
AgentJsonConfigBaseSchema = z.object({
  name, description, model: 'provider/model-name', credential, instructions, personalisation,
  memory: { enabled, storage: 'n8n', observationalMemory?, episodicMemory? },
  subAgents: { maxChildren?, agents: [{ agentId, useWhen?, enabled? }], modelsByDifficulty? },
  tools: [ { type: 'custom',   id, requireApproval? }
         | { type: 'workflow', workflowId, workflow, name?, description?, requireApproval?, allOutputs?,
             inputs?: Record<string, { mode:'ai', description? } | { mode:'fixed', value } | { mode:'expression', value:'=…' }> }
         | { type: 'node', name, description?, node: { nodeType, nodeTypeVersion, nodeParameters, credentials? }, requireApproval? } ],
  skills, tasks, providerTools, integrations,
  mcpServers: [{ name, url, transport: 'sse'|'streamableHttp', authentication, credential?, toolFilter?: {mode:'allow'|'exclude', tools}, approval?, connectionTimeoutMs? }],
  vectorStores: [{ provider: 'pinecone'|'qdrant'|'supabase'|'postgres', name, credential, useWhen, embedding: { model, credential }, … }],
  config: { reasoning?, promptCaching?, webSearch?, toolCallConcurrency?, maxIterations? (1–200), guardrails?: { budget? } },
});
```

`buildFromJson` (`CLI/modules/agents/json-config/from-json-config.js`) turns this into
`new Agent(config.name).model(…).instructions(…).tool(…).mcp(…).vectorStore(…).memory(…)`.

A **node tool** is the same idea as "usableAsTool", but **without a workflow**
(`CLI/modules/agents/tools/node-tool-factory.js`). The schema comes from `$fromAI` placeholders in
`nodeParameters` (or from supplyData introspection). The handler executes **one node ephemerally**:

```js
new Tool(nodeNameToToolName(toolSchema.name)).description(…).input(await resolveInputSchema(toolSchema, ctx))
  .handler(async (input) => ctx.executor.executeInline({ nodeType, nodeTypeVersion, nodeParameters,
           credentialDetails, inputData: [{ json: input }], projectId })).build();
```

Workflows call agents through the **Message an Agent** node (`n8n-nodes-base.messageAnAgent`, v1–3.1,
`usableAsTool: true`). It takes `agentId` (or an `inlineAgent` config), `message`, an optional structured
output schema, and a session. It calls `this.executeAgent(...)` → `additionalData.executeAgent(source, message,
executionId, threadId, …, { nodeId, nodeName, runIndex, itemIndex, sendResponseChunk })`. Agent replies
are streamed back through the workflow's `sendChunk` hook.

### 5.3 `@n8n/instance-ai` (1.29.5): the n8n Assistant

README: *"Instance AI is the agent runtime behind the n8n Assistant experience… built around a deep-agent
loop: An orchestrator agent receives the user's request and maintains the plan… Domain tools read and update
n8n resources through backend adapters. Observational memory condenses long conversations. Workflow building
runs in a sandbox workspace, validates generated TypeScript, and submits the workflow through the n8n
backend."* It is built on `@n8n/agents`.

* Tool IDs (`dist/tools/tool-ids.js`): `workflows, executions, credentials, data-tables, workspace, research,
  n8n-docs, nodes, searchModels, ask-user, build-workflow, parse-file, agent-context, mcp-servers,
  conversation-history, activity, save_user_preference`.
* Orchestration tools: `create-tasks, task-control, complete-checkpoint, verify-built-workflow,
  report-verification-verdict, apply-workflow-credentials, build-agent, get-session`.
* Markdown skills: `agent-builder, workflow-builder, planning, progressive-building,
  debugging-executions, data-table-manager, intent-recognition, …`.
* It requires a sandbox (the n8n sandbox service or Daytona).

### 5.4 `@n8n/ai-workflow-builder` (1.44.4): prompt → workflow

**Yes, it generates workflow JSON from a prompt.** It has two architectures.

1. **Multi-agent LangGraph** (`multi-agent-workflow-subgraphs.js`, `agents/{supervisor,planner,responder}`,
   `subgraphs/discovery`). The tools mutate workflow JSON directly (`tools/builder-tools.js`):
   * read/discover: `get_documentation`, `search_nodes` (node-search), `get_node_details`,
     `get_node_parameter`, `get_workflow_overview`, `get_node_context`, `get_execution_schema`,
     `get_execution_logs`, `get_expression_data_mapping`, `web_fetch`;
   * mutate: `add_nodes` (with `nodeType`, `nodeVersion`, `name`, `initialParametersReasoning`,
     `initialParameters`, settings), `connect_nodes` (sub-node→root convention, auto-swap),
     `remove_connection`, `remove_node`, `rename_node`, `update_node_parameters` (natural-language
     `changes[]` applied by a parameter-updater LLM chain);
   * check: `validate_structure`, `validate_configuration`, `submit_questions`.
2. **Code builder**, the newer path (`code-builder/`). The LLM edits a **TypeScript file `/workflow.js`**
   written against `@n8n/workflow-sdk`, using:
   * Anthropic's `str_replace_based_edit_tool` (`text_editor_20250728`);
   * `batch_str_replace`;
   * `validate_workflow`, `search_nodes`, `get_node_types`, `get_suggested_nodes`.

   Limits: `MAX_AGENT_ITERATIONS = 50`, `MAX_VALIDATE_ATTEMPTS = 10`. Parsing works like this:
   `parseWorkflowCodeToBuilder(code) → builder.toJSON({ tidyUp: true }) → validateWorkflow(json)`.
   The SDK has `trigger()`, `node()`, `languageModel()`, `memory()`, `tool()`, `outputParser()`,
   `embedding()`, `vectorStore()`, `retriever()`, `textSplitter()`, `documentLoader()`, `fromAi()`,
   `expr()`, `nodeJson()`, `ifElse()`, `switchCase()`, `merge()`, `splitInBatches()`, `sticky()`. Sub-nodes go
   in a `subnodes: { model, memory, tools: [...], outputParser }` object rather than in edges. From the
   Agent's `builderHint`:

   ```ts
   const agent = node({ type: '@n8n/n8n-nodes-langchain.agent', version: 3.1,
     config: { name: 'AI Agent', parameters: { promptType: 'define', text: expr('{{ $json.prompt }}'), hasOutputParser: true,
               options: { systemMessage: 'You are an expert...' } },
               subnodes: { model, memory: memoryNode, outputParser: parser } } });
   // fallback model = flat array: subnodes: { model: [primaryModel, fallbackModel] } + needsFallback: true
   ```

   The same code path is exposed over n8n's MCP server as `create_workflow_from_code`, `update_workflow`
   and `get_sdk_reference`.

Every node description carries `builderHint` (`searchHint`, `relatedNodes`, `inputs`, `propertyHint`,
`extraTypeDefContent`). This is LLM-facing metadata on the node type.

---

## 6. Agent-creation UX in the editor

From the docs plus i18n strings in the editor bundle:

1. **Add a trigger.** The node creator's AI panel asks "When should this workflow run?" Pick **On chat
   message** (Chat Trigger), schedule, webhook, and so on. "AI Templates: See what's possible and get started
   5x faster".
2. **Add AI Agent.** It is under AI → "Agents" (*"Autonomous entities that interact and make decisions."*).
   The node renders wide, with bottom slots **Chat Model\***, **Memory**, **Tool** (plus **Output Parser**
   and **Fallback Model** when those parameters are on). Required slots show an issue until filled.
3. **Click "+" under a slot.** The node creator opens filtered to that connection type: "Language Models",
   "Memory", "Tools" (Recommended Tools, Other Tools = every `usableAsTool` app node), "Human review", or
   "MCP servers". The chosen node is dropped below the agent as a round sub-node and wired up. A tool's
   NDV has "Tool Description" (Set Automatically / Set Manually), and each field has the star
   **"Let the model define this parameter"** button (`$fromAI`).
4. **Test.** With a Chat Trigger, a **Chat** panel opens ("Type a message", "Send a message below to trigger
   the chat workflow", session id with **Reset**). Each message runs the workflow in manual mode, with
   streaming if enabled. A sub-node's NDV shows *"Output will appear here once the parent node is run"*. A
   tool can be tested alone through the `$fromAI` modal ("Test {nodeName}").
5. **Logs.** The bottom **Logs** panel ("Overview" / "Details") shows a tree: agent run → child entries for
   each model call, memory access and tool call. The tree is built from the sub-node run entries whose
   `source.previousNode` is the agent. The AI content block shows "Started at", "{count} Tokens", "Prompt:"
   and "Completion:". The agent's NDV output pane says *"Use these logs to see information on how the {node}
   node completed processing."* "View session" links to Agent sessions.
6. **Assistant.** Instead of all of the above, the user can ask the AI builder or n8n Assistant to build the
   workflow (§5.3–5.4), or create a standalone **Agent** in the Agents tab (§5.2).

---

## 7. Implications for Landflow

Landflow already has `ConnectionType = 'main' | 'ai_languageModel' | 'ai_tool' | 'ai_memory'`,
`PortDescriptor { type, displayName, required, maxConnections }`, `kind: 'subnode'`, `supplies`,
`usableAsTool` and `mode: "tool"` (`packages/protocol/src/types.ts`, `docs/protocol.md`). The proposals
below build on that.

### 7.1 Typed ports in a language-neutral descriptor

n8n's weak spots are dynamic ports as **JS expression strings** (`inputs: "={{ … getInputs.toString() … }}"`),
which non-TS SDKs cannot produce and tools cannot analyse statically, and slots told apart **by index**
(Chat Model vs Fallback Model). Recommendations:

```ts
type ConnectionType = 'main' | 'ai_languageModel' | 'ai_tool' | 'ai_memory'
  | 'ai_embedding' | 'ai_vectorStore' | 'ai_retriever' | 'ai_document' | 'ai_textSplitter'
  | 'ai_outputParser' | 'ai_reranker';                    // keep n8n's spelling for import/export compat

interface PortDescriptor {
  id: string;                    // NEW: stable slot key ("model", "fallbackModel", "tools") — edges reference id, not index
  type: ConnectionType;
  displayName?: string;
  required?: boolean;
  maxConnections?: number;       // 1 ⇒ host hands the node a single capability, else a list (n8n semantics)
  filter?: { nodes?: string[]; excludedNodes?: string[] };   // NEW: node-creator + validation filter
  displayOptions?: DisplayOptions; // NEW: declarative visibility, same syntax as properties (what n8n's builderHint already does)
}
```

* **Dynamic ports should be declarative.** Use `displayOptions` on ports, evaluated by the host the same way
  as for properties. Examples: `{ id:'outputParser', type:'ai_outputParser', displayOptions:{ show:{ hasOutputParser:[true] } } }`,
  and the vector-store pattern where the same node is a root in `insert` mode and a sub-node in
  `retrieve-as-tool` mode. If needed, add a `LoadPorts` RPC (like `LoadOptions`) as an escape hatch for truly
  computed ports.
* **Editor rules worth copying** (§1.2):
  * a node with only non-main outputs is a round sub-node;
  * a node with any non-main input is wide, with bottom slots;
  * main ports go left/right, `ai_*` inputs bottom, `ai_*` outputs top;
  * an edge needs the same type and opposite modes;
  * the "+" opens the creator filtered by `outputs ∋ type`, minus `filter`;
  * `maxConnections` disables "+";
  * a required empty slot raises an issue.
* **Edge shape:** `{ from:{ node, port:'out' }, to:{ node, port:'model' } }` with sub-node → root. Store the port
  type redundantly for validation. Provide an n8n importer that maps `connections[src][type][i]` to these
  port ids by order.
* **LLM-facing metadata.** Reserve `aiHints` (like n8n's `builderHint`) on nodes and properties now. An AI
  builder will need it.

### 7.2 A remote plugin as a **tool**

n8n's key move is that **tools are ordinary node executions**: synthetic `…Tool` variants, `$fromAI`, and
the engine running the node. This maps well onto Landflow because the **host already resolves expressions**:

1. **Synthesize, don't require.** For every `usableAsTool` node, the host registers `<type>Tool` with
   `inputs: []`, `outputs: [{ type:'ai_tool' }]` and an added `toolDescription` property (auto from
   resource and operation, or manual), the way `convertNodeToAiTool` does. Plugins write no tool code.
2. **Schema from placeholders.**
   * The host scans the node's parameters for `$fromAI(key, description, type, default)` (types
     `string|number|boolean|json`, key `^[A-Za-z0-9_-]{1,64}$`, conflicting duplicates are an error) and
     emits **JSON Schema** directly. Zod is not needed on the wire.
   * Add an optional descriptor field `toolInputSchema` (JSON Schema) for nodes that take free-form args,
     like the Code Tool's "Specify Input Schema".
   * The tool name is the sanitized **node name** (`[^a-zA-Z0-9_-]+ → _`, ≤ 64), unique per agent.
3. **Execution.** When the model calls the tool, the host resolves the node's parameters with
   `$fromAI` bound to the call's args. It then sends the normal `ExecuteRequest` with `mode: "tool"`,
   `inputs: [[{ json: { ...agentItem.json, ...args, toolCallId } }]]` (n8n's `mergedJson`). The result is
   `JSON.stringify(outputs[0].map(i => i.json))`. Binary is stripped with a warning. A tool error becomes
   the observation `{"error": "...", "errorType": "..."}`, and the workflow continues unless the node says
   stop (n8n's `aiToolDefaultsToContinue`).
4. **Toolkits.** A plugin that offers N tools behind one node (like the MCP Client Tool) needs two RPCs:
   `ListTools(node, params) → [{ name, description, inputSchema }]` and `Execute` with `input.tool = name`.
   Strongly consider letting a plugin **be an MCP server** (Streamable HTTP). The host then gets
   tools/list and tools/call for free, and Landflow can also expose its own tools through an MCP Server
   Trigger, as n8n does.
5. **Logging.** Each tool call is a run of the tool node:
   `runData[tool][k] = { source:[{ previousNode: agent, previousNodeRun }], inputOverride:{ ai_tool:[[{json:args}]] }, data:{ ai_tool: outputs } }`.
   This gives the logs tree for free.

### 7.3 A remote plugin as a **model, memory or embedding provider**

n8n's `supplyData` returns **live in-process objects** (LangChain classes). That cannot cross HTTP or gRPC.
Use **capability contracts** instead, keyed by `supplies`:

* **Config mode** (preferred, cheapest). The sub-node's `Supply` RPC returns *data*, not an object, and the
  host builds the client. This mirrors `supplyModel(this, { type: 'openai', baseUrl, apiKey, model, temperature })`:

  ```jsonc
  // SupplyResponse for supplies = "ai_languageModel"
  { "kind": "openai-compatible", "baseUrl": "https://…/v1", "apiKeyRef": "cred:xyz", "model": "gpt-…",
    "params": { "temperature": 0.2 }, "capabilities": { "tools": true, "vision": true, "streaming": true } }
  ```
* **Proxy mode** (custom providers). The plugin implements `Chat` (unary) and `ChatStream` (server-streaming)
  using n8n's ai-node-sdk shapes:
  * request: `{ messages:[{role, content:[{type:'text'|'image'|'tool-call'|'tool-result', …}]}], tools:[{name, description, inputSchema}], toolChoice, params }`;
  * response: `{ message, finishReason:'stop'|'tool-calls'|'length'|…, usage:{promptTokens, completionTokens, totalTokens} }`;
  * stream chunks: `text-delta | tool-call | reasoning | finish`.

  Keep an opaque `providerMetadata` field on assistant and tool-call messages. n8n has to carry Anthropic
  thinking signatures, Gemini thought signatures and DeepSeek `reasoning_content` across tool round-trips
  (`extractThinkingMetadata`, `buildSteps`).
* **Memory contract** (n8n `BaseChatHistory`): `GetMessages(sessionId)`, `AddMessages(sessionId, msgs)`,
  `Clear(sessionId)`. The host applies windowing (`WindowedChatMemory`) and cleans up orphaned tool messages.
* **Embeddings and vector stores:** `EmbedDocuments`, `EmbedQuery`, `Upsert`, `Search(queryVector|text, k, filter)`.
* **Parameter resolution:** resolve sub-node parameters against the root's **current item**, per item. n8n
  resolves them against item 0, which is a known footgun (memory session ids in batches). If that is too
  costly, document "item 0" explicitly.
* **Logging:** the host wraps each capability call the way `N8nLlmTracing` / `logWrapper` do. It writes a
  sub-node run entry with input `{ messages, estimatedTokens, options(redacted) }` and output
  `{ response, tokenUsage | tokenUsageEstimate }`, emits AI events, and streams `nodeExecuteBefore/After`
  to the UI.

### 7.4 A minimal agent tool-calling loop

Follow n8n **v3 (engine-driven)** rather than v2 (in-process `AgentExecutor`). Tools then run anywhere (a
remote plugin, a sub-workflow, MCP), every call gets its own run entry, retries and errors use the engine's
machinery, and HITL is just "an execution waits". Keep the agent state serializable so that, like
`@n8n/agents` checkpoints, a run can be persisted between iterations and resumed after a restart or an
approval.

```ts
// Host-side Agent node (built-in). One call = one model turn per item; returns either items or a ToolRequest.
interface AgentState {                       // persisted between turns (n8n: EngineResponse.metadata)
  messages: Message[];                       // system + history + user + assistant/tool turns (with providerMetadata)
  iteration: number;                         // n8n: metadata.iterationCount
  pending?: ToolCall[];                      // calls awaiting execution or approval
}
type ToolCall = { id: string; name: string; args: JsonObject; nodeId: string; providerMetadata?: unknown };

async function agentTurn(ctx, item, state: AgentState): Promise<{ done: true; output: Json } | { done: false; calls: ToolCall[] }> {
  const model  = await ctx.capability('model');            // port id, not index; fallback = ctx.capability('fallbackModel')
  const memory = await ctx.capability('memory');           // optional
  const tools  = await ctx.tools('tools');                 // [{ name, description, inputSchema, nodeId, requiresApproval }]
  if (state.iteration >= ctx.param('maxIterations', 10)) throw new Error(`Max iterations reached`);
  if (state.iteration === 0) state.messages = [system(ctx.param('systemMessage')), ...(await memory?.get(sessionId) ?? []), user(input)];
  const tools4model = ctx.outputParser ? [...tools, finalAnswerTool(ctx.outputParser.schema)] : tools;   // n8n: format_final_json_response
  const turn = await withFallback(model, fallback).chatStream({ messages: state.messages, tools: tools4model,
               toolChoice: state.iteration === 0 && ctx.param('forceToolCall') ? 'any' : 'auto' },
               chunk => ctx.sendChunk(chunk));             // begin/item/end + {nodeId,itemIndex,runIndex}
  state.messages.push(turn.message);
  const calls = turn.toolCalls.filter(c => c.name !== 'final_answer');
  if (calls.length === 0) {                                // final answer
    const output = ctx.outputParser ? parse(turn) : turn.text;
    await memory?.add(sessionId, [user(input), ...toolTurns(state), assistant(output)]);
    return { done: true, output };
  }
  return { done: false, calls: calls.map(c => ({ ...c, nodeId: tools.find(t => t.name === c.name)!.nodeId })) };
}

// Engine side (n8n: handleRequest + collectSubNodeResults)
async function runAgentNode(engine, agentNode, item) {
  let state: AgentState = { messages: [], iteration: 0 };
  for (;;) {
    const r = await agentTurn(ctx, item, state);
    if (r.done) return r.output;
    for (const call of r.calls) {                          // run in parallel with a concurrency cap (n8n: toolCallConcurrency)
      if (needsApproval(call)) {                           // gate: per-tool flag OR an approval sub-node (n8n HitlTool)
        await engine.persist(state);                       // execution → "waiting"
        const d = await engine.waitForDecision(call);      // { approved, scope: 'once'|'session', feedback? }
        if (!d.approved) { state.messages.push(toolResult(call, denialMessage(call, d.feedback))); continue; }
      }
      const res = await engine.executeNode(call.nodeId, { mode: 'tool', args: call.args, parentRun: agentNode.run, toolCallId: call.id });
      state.messages.push(toolResult(call, res.error ? { error: res.error.message } : res.items.map(i => i.json)));
    }
    state.iteration++;                                     // checkpoint here for crash-resume
  }
}
```

Rules taken from n8n:

* **Iteration cap** defaults to 10 for a workflow agent (n8n), up to 100 for the code SDK and 200 for
  Agent JSON config.
* **Denial text** tells the model to stop and wait. User feedback is passed through.
* **Tool errors are observations**, not workflow failures.
* **Memory saves tool turns** as assistant(tool_calls) + tool(result) pairs.
* **Streaming chunks** carry `nodeId / itemIndex / runIndex`, so a chat UI can multiplex several agents.
* **Sub-agents.** An "Agent as Tool" node (`inputs` without `main`, `outputs: ai_tool`) runs its own loop
  inline. Approvals inside a sub-agent need either suspension propagation or a ban, as n8n does.

### 7.5 Product layers to plan for

n8n now has **three** agent surfaces, and Landflow should decide early which it needs:

1. **Canvas agent**: a cluster node inside workflows (§1–4).
2. **Standalone agent**: a declarative JSON config (model, instructions, tools as
   `custom | workflow | node`, MCP servers, vector stores, memory, sub-agents, approvals, channels,
   schedules). It runs on a code-first SDK and is invoked from workflows through a "Message an Agent" node.
   Node tools run as **ephemeral single-node executions** (`executeInline`), which suits Landflow's
   stateless `Execute` RPC.
3. **AI builder**: an LLM that writes workflows. n8n's current approach is to have the model edit typed SDK
   code (`node()`, `languageModel()`, `subnodes:{…}`) that is parsed and validated into JSON. A typed Landflow
   workflow SDK plus `aiHints` on descriptors would allow the same.

## 8. Agents (Preview): the UI, explored live on n8n 2.44.6

This complements §5.2 (schema from source). Explored on a local n8n 2.44.6 (Docker) on 2026-10-25.
Landflow's take is in [../agents.md](../agents.md).

- **Entry.** The Overview has an **Agents (Preview)** tab. **Create agent** opens the builder at
  `/projects/:projectId/agents/:agentId`. It autosaves, but an untouched empty draft is discarded.
- **Header.**
  - Breadcrumb with the inline name.
  - "…" menu: Edit description, Favorite, Export / Import JSON, Publish history, Delete agent (confirmed in the page).
  - **Finish setup** checklist: Choose a model, Add tools, Add instructions.
  - **Test agent**, disabled until a model and instructions are set.
  - **Publish** (⇧P) split button with Unpublish.
  - A sparkle button opens the n8n Assistant (`/assistant`).
- **Tabs:**
  - *Build:* model & instructions · skills · triggers · capabilities · memory.
  - *Knowledge:* Advanced → external vector stores.
  - *Sessions:* auto refresh; "Sessions will appear here after you preview your agent".
  - *Settings:* monthly budget, cost cap per session, max parallel sub-agents (10, range 1–20),
    custom model routing (low / medium / high), memory model, reasoning, tool call concurrency (5),
    max iterations (1–200).
- **Model picker.** Pick a provider, then a credential, then a model. Providers: OpenAI, Anthropic, Google, Vertex,
  Microsoft Foundry, xAI, Groq, DeepSeek, Cohere, Mistral, NVIDIA, Moonshot, Qwen Cloud, MiniMax, AWS
  Bedrock, OpenRouter, Vercel AI Gateway. No Ollama.
- **Skills.** Three ways to add one:
  - upload a folder (`SKILL.md` plus an optional `references/` folder);
  - upload a single `SKILL.md`;
  - *Add manually:* When to use\*, What the skill does\* (max 65 536 chars), Allowed tools, references.
- **Triggers:**
  - **Channels:** Slack, Telegram, Linear, Discord. Telegram setup is three steps:
    1. a credential;
    2. access mode *Private* (with a required "Restrict to users" list) or *Public*, plus "New session after inactivity";
    3. Connect.
  - **Schedule:** What to do\*; Hourly / Daily / Weekly / Monthly / Custom (cron); a time and a time zone; Test agent.
- **Capabilities:**
  - **Add tool** has three tabs: All / MCP (78 vendor MCP servers plus a generic MCP Client) / n8n nodes. A node
    tool has two tabs:
    - Parameters: a description, plus the node's own form, where every field has a "let the model define it" (`$fromAI`) button;
    - Settings: "Require approval: Pause before this tool runs until a human approves it".
  - **Add workflow** lists workflows. Only those starting with *When Executed by Another Workflow*
    can be added; the others are greyed out with a tooltip.
  - **Add sub-agent** offers existing agents, plus *Create agent*.
  - **Web search** (off by default).
- **Memory.** Session memory is always on, and a Cross-session memory toggle adds memory across sessions.

**What Landflow kept and changed:**
- *Same as n8n:* the same build sections and the publish/version model; skills in the Agent Skills format;
  approval per tool; `$fromAI` per field.
- *Different:*
  - Ollama is a first-class provider.
  - The workflow trigger is called *When Called by an Agent*, and it declares typed arguments.
  - A *Message an Agent* node lets workflows call published agents.
  - A session token budget replaces the monthly cost cap.
  - Only Telegram so far, and no knowledge or web search yet.
