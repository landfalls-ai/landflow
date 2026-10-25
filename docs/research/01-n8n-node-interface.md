# 01 — n8n Node / Plugin Interface (reference for Landflow)

> Research target: **n8n 2.44.6** (Docker container `n8n`). Package versions inside the container:
> `n8n-workflow 2.44.2`, `n8n-core 2.44.4`, `n8n-nodes-base 2.44.4`, `@n8n/n8n-nodes-langchain 2.44.4`,
> `@n8n/ai-node-sdk 0.34.4`, `@n8n/node-engine-compatibility 0.12.4`, `@n8n/workflow-sdk 0.37.2`, `@n8n/engine 0.24.1`.
>
> **Source of truth.** The production image ships **no `.d.ts` files** (they are stripped). The exact same versions were
> downloaded from the npm registry into a scratch folder to read the type declarations. The compiled JS was diffed against the
> container (`n8n-workflow/dist/esm/interfaces.js` was identical). The runtime behaviour (loaders, dispatch, community install)
> was read from the container's dist JS. Every TypeScript block below is **copied verbatim** from
> `n8n-workflow/dist/esm/interfaces.d.ts` (or the file named next to it), trimmed only where marked `// …`.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [`INodeType`: the runtime contract](#2-inodetype--the-runtime-contract)
3. [`INodeTypeDescription`: the static descriptor](#3-inodetypedescription--the-static-descriptor)
4. [Connections, inputs/outputs and dynamic I/O](#4-connections-inputsoutputs-and-dynamic-io)
5. [`INodeProperties`: parameters and UI schema](#5-inodeproperties--parameters--ui-schema)
6. [Declarative (routing) vs programmatic style](#6-declarative-routing-vs-programmatic-style)
7. [Versioning: light versioning vs `VersionedNodeType`](#7-versioning)
8. [Credentials: `ICredentialType`](#8-credentials--icredentialtype)
9. [Execution context surface (`IExecuteFunctions` & friends)](#9-execution-context-surface)
10. [Data shapes: `INodeExecutionData[][]`, binary, errors](#10-data-shapes)
11. [Discovery and loading](#11-discovery--loading)
12. [New packages: `@n8n/ai-node-sdk`, `@n8n/node-engine-compatibility`, `@n8n/engine`, `@n8n/workflow-sdk`](#12-new-packages)
13. [Real example nodes (trimmed)](#13-real-examples)
14. [Implications for Landflow](#14-implications-for-landflow)

---

## 1. Mental model

* A **node type** is a JS class with a `description: INodeTypeDescription` (pure data, mostly JSON) plus **optional methods**:
  `execute` | `poll` | `trigger` | `webhook` | `supplyData`, plus `methods.*` (UI-time callbacks) and `webhookMethods` (lifecycle hooks
  for registering remote webhooks).
* A **node instance** in a workflow (`INode`) references the type by `type: "<package>.<name>"` + `typeVersion: number` and stores
  `parameters` (values for the `properties` schema) and `credentials` (references by id/name).
* The **editor UI never runs node code**. It reads only the serialized descriptions (`/types/nodes.json`). When it needs dynamic data
  (dropdown options, search lists, resource-mapper columns, button actions, credential tests), it makes REST calls to the backend. The backend
  instantiates the node class and calls `methods.loadOptions[x]` and so on.
* Data flows between nodes as **items**: `INodeExecutionData = { json, binary?, pairedItem?, error? }`. A node returns
  `INodeExecutionData[][]`, an array per **output index**, each holding an array of items.
* Credentials are separate typed plugins (`ICredentialType`). They can **declaratively** inject auth into HTTP requests (`authenticate`) and
  self-test (`test`).

---

## 2. `INodeType`: the runtime contract

```ts
// n8n-workflow/dist/esm/interfaces.d.ts
export interface SupplyData {
    metadata?: IDataObject;
    response: unknown;
    closeFunction?: CloseFunction;
    hints?: NodeExecutionHint[];
}
export type NodeOutput = INodeExecutionData[][] | NodeExecutionWithMetadata[][] | EngineRequest | null;
export interface INodeType {
    description: INodeTypeDescription;
    supplyData?(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData>;
    execute?(this: IExecuteFunctions, response?: EngineResponse): Promise<NodeOutput>;
    /**
     * A function called when a node receives a chat message. Allows it to react
     * to the message before it gets executed.
     */
    onMessage?(context: IExecuteFunctions, data: INodeExecutionData): Promise<NodeOutput>;
    poll?(this: IPollFunctions): Promise<INodeExecutionData[][] | null>;
    trigger?(this: ITriggerFunctions): Promise<ITriggerResponse | undefined>;
    webhook?(this: IWebhookFunctions): Promise<IWebhookResponseData>;
    methods?: {
        loadOptions?: {
            [key: string]: (this: ILoadOptionsFunctions) => Promise<INodePropertyOptions[]>;
        };
        listSearch?: {
            [key: string]: (this: ILoadOptionsFunctions, filter?: string, paginationToken?: string) => Promise<INodeListSearchResult>;
        };
        credentialTest?: {
            [functionName: string]: ICredentialTestFunction;
        };
        resourceMapping?: {
            [functionName: string]: (this: ILoadOptionsFunctions) => Promise<ResourceMapperFields>;
        };
        localResourceMapping?: {
            [functionName: string]: (this: ILocalLoadOptionsFunctions) => Promise<ResourceMapperFields>;
        };
        actionHandler?: {
            [functionName: string]: (this: ILoadOptionsFunctions, payload: IDataObject | string | undefined) => Promise<NodeParameterValueType>;
        };
    };
    webhookMethods?: {
        [name in WebhookType]?: {
            [method in WebhookSetupMethodNames]: (this: IHookFunctions) => Promise<boolean>;
        };
    };
    /**
     * Defines custom operations for nodes that do not implement an `execute` method, such as declarative nodes.
     * This function will be invoked instead of `execute` for a specific resource and operation.
     * Should be either `execute` or `customOperations` defined for a node, but not both.
     */
    customOperations?: {
        [resource: string]: {
            [operation: string]: (this: IExecuteFunctions) => Promise<NodeOutput>;
        };
    };
}

export type WebhookType = 'default' | 'setup';
export type WebhookSetupMethodNames = 'checkExists' | 'create' | 'delete';

export interface ITriggerResponse {
    closeFunction?: CloseFunction;
    manualTriggerFunction?: () => Promise<void>;
    manualTriggerResponse?: Promise<INodeExecutionData[][]>;
}
export interface IWebhookResponseData {
    workflowData?: INodeExecutionData[][];
    webhookResponse?: any;
    noWebhookResponse?: boolean;
    /** Input the trigger wants connected sub-nodes to receive, also when they run on a worker. */
    toolInput?: IDataObject;
}
export interface INodeListSearchResult {
    results: INodeListSearchItems[];
    paginationToken?: string;
}
export interface ResourceMapperFields {
    fields: ResourceMapperField[];
    emptyFieldsNotice?: string;
}
export type ICredentialTestFunction = (this: ICredentialTestFunctions, credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>) => Promise<INodeCredentialTestResult>;
export interface INodeCredentialTestResult {
    status: 'OK' | 'Error';
    message: string;
}
```

### Method semantics

| Method | Called when | Context (`this`) | Returns |
|---|---|---|---|
| `execute` | Regular action node runs (once per node run, **with all input items**) | `IExecuteFunctions` | `INodeExecutionData[][]` (one array per output), or an `EngineRequest` (ask the engine to run sub-nodes and call back with `EngineResponse`) |
| `poll` | Polling trigger. The node sets `description.polling: true`, and the loader auto-injects a `pollTimes` fixedCollection parameter. | `IPollFunctions` | items, or `null` when nothing is new. State lives in `getWorkflowStaticData('node')`. |
| `trigger` | Long-lived trigger on workflow activation (cron, MQ consumer, IMAP…) | `ITriggerFunctions` (`emit(data)`, `emitError`, `saveFailedExecution`) | `{ closeFunction, manualTriggerFunction }` |
| `webhook` | An HTTP request hits a webhook declared in `description.webhooks` | `IWebhookFunctions` (`getBodyData`, `getHeaderData`, `getRequestObject`, `getResponseObject` …) | `{ workflowData, webhookResponse, noWebhookResponse }` |
| `webhookMethods.default.{checkExists,create,delete}` | Activation and deactivation: register the n8n URL with a third party, such as the GitHub hooks API | `IHookFunctions` (`getNodeWebhookUrl('default')`, static data) | `boolean` |
| `supplyData` | **Sub-node** (AI model, memory, tool, vector store…). The parent asks for an object via `getInputConnectionData(type, i)`. | `ISupplyDataFunctions` | `{ response: <any JS object>, closeFunction? }`. **Not JSON-serializable**: it's an in-process object (for example a LangChain model). |
| `methods.loadOptions[name]` | UI asks for options of a property with `typeOptions.loadOptionsMethod: name` | `ILoadOptionsFunctions` (current params + creds + http) | `INodePropertyOptions[]` |
| `methods.listSearch[name]` | Resource-locator `list` mode with `typeOptions.searchListMethod: name` | `ILoadOptionsFunctions` | `{ results, paginationToken }` (searchable, paginated) |
| `methods.credentialTest[name]` | Credential "Test" button, when the node's `credentials[].testedBy = name` | `ICredentialTestFunctions` | `{status, message}` |
| `methods.resourceMapping[name]` | `resourceMapper` property with `typeOptions.resourceMapper.resourceMapperMethod: name` | `ILoadOptionsFunctions` | `{ fields: ResourceMapperField[] }` |
| `methods.actionHandler[name]` | `button` property with `typeOptions.buttonConfig.action` | `ILoadOptionsFunctions` | a parameter value |
| `customOperations[resource][operation]` | Lets a declarative node implement single operations in code | `IExecuteFunctions` | items |

### Engine dispatch order (from `n8n-core/dist/execution-engine/workflow-execute.js`, `runNode`)

```js
if (nodeType.execute || customOperation) return await this.executeNode(...);
if (nodeType.poll)    return await this.executePollNode(...);
if (nodeType.trigger) return await this.executeTriggerNode(...);
if (nodeType.supplyData) throw new UnexpectedError(`The node "${node.type}" has a "supplyData" method but no "execute" method.`);
const isDeclarativeNode = nodeType.description.requestDefaults !== undefined;
if (nodeType.webhook && !isDeclarativeNode) return { data: inputData.main };   // webhook nodes just pass through in-run
return await this.executeDeclarativeNodeInTest(...);   // → RoutingNode (routing-based HTTP execution)
```

So a node with **no** `execute` / `poll` / `trigger` / `webhook` is executed by the generic **`RoutingNode`**, the declarative engine.

### New "context-API" base class (in transition)

n8n is introducing an alternative to the `this`-bound methods: an abstract class whose methods receive the context as an argument:

```ts
export declare abstract class Node {
    get [NODE_CLASS_TAG](): true;
    abstract description: INodeTypeDescription;
    execute?(context: IExecuteFunctions, response?: EngineResponse): Promise<INodeExecutionData[][] | EngineRequest>;
    webhook?(context: IWebhookFunctions): Promise<IWebhookResponseData>;
    poll?(context: IPollFunctions): Promise<INodeExecutionData[][] | null>;
}
export declare function isNodeClassInstance(nodeType: unknown): nodeType is Node;
```

`EngineRequest` / `EngineResponse` let a node **yield** to the engine ("execute node X with this input, then call me back"). The AI
Agent uses it to run tools as real workflow nodes:

```ts
type ExecuteNodeAction<T> = {
    actionType: 'ExecutionNodeAction';
    nodeName: string;
    input: IDataObject;
    type: NodeConnectionType;
    id: string;
    metadata: T;
};
export type EngineRequest<T = object> = { actions: Array<EngineAction<T>>; metadata: T; };
export type EngineResponse<T = unknown> = { actionResponses: Array<EngineResult<T>>; metadata: T; };
```

---

## 3. `INodeTypeDescription`: the static descriptor

```ts
type NodeGroupType = 'input' | 'output' | 'organization' | 'schedule' | 'transform' | 'trigger';
export type IconRef = `fa:${string}` | `node:${string}`;
export type IconFile = `file:${string}.png` | `file:${string}.svg` | ExpressionString;
export type Icon = IconRef | Themed<IconFile> | IconFile;
export type Themed<T> = T | { light: T; dark: T; };

export interface INodeTypeBaseDescription {
    displayName: string;
    name: string;
    icon?: Icon;
    iconColor?: ThemeIconColor;
    iconUrl?: Themed<string>;
    iconBasePath?: string;
    badgeIconUrl?: Themed<string>;
    group: NodeGroupType[];
    description: string;
    documentationUrl?: string;
    subtitle?: string;
    defaultVersion?: number;
    codex?: CodexData;
    parameterPane?: 'wide';
    hidden?: true;
    deprecated?: true;
    usableAsTool?: true | UsableAsToolDescription;
    builderHint?: IBuilderHint;
    schemaPath?: string;
}
export type UsableAsToolDescription = {
    replacements?: Partial<Omit<INodeTypeBaseDescription, 'usableAsTool'>>;
};

export interface INodeTypeDescription extends INodeTypeBaseDescription {
    version: number | number[];
    defaults: NodeDefaults;
    eventTriggerDescription?: string;
    activationMessage?: string;
    inputs: Array<NodeConnectionType | INodeInputConfiguration> | ExpressionString;
    requiredInputs?: string | number[] | number;
    inputNames?: string[];
    outputs: Array<NodeConnectionType | INodeOutputConfiguration> | ExpressionString;
    outputNames?: string[];
    properties: INodeProperties[];
    credentials?: INodeCredentialDescription[];
    maxNodes?: number;
    polling?: true | undefined;
    supportsCORS?: true | undefined;
    requestDefaults?: DeclarativeRestApiSettings.HttpRequestOptions;
    requestOperations?: IN8nRequestOperations;
    hooks?: {
        [key: string]: INodeHookDescription[] | undefined;
        activate?: INodeHookDescription[];
        deactivate?: INodeHookDescription[];
    };
    webhooks?: IWebhookDescription[];
    translation?: { [key: string]: object; };
    mockManualExecution?: true;
    triggerPanel?: TriggerPanelDefinition | boolean;
    extendsCredential?: string;
    hints?: NodeHint[];
    communityNodePackageVersion?: string;
    waitingNodeTooltip?: string;
    __loadOptionsMethods?: string[];
    skipNameGeneration?: boolean;
    features?: NodeFeaturesDefinition;
    builderHint?: IBuilderHint;
    sensitiveOutputFields?: string[];
}

export type NodeDefaults = Partial<{
    /** @deprecated Use iconColor instead */
    color: string;
    name: string;
}>;

export type TriggerPanelDefinition = {
    hideContent?: boolean | string;
    header?: string;
    executionsHelp?: string | { active: string; inactive: string; };
    activationHint?: string | { active: string; inactive: string; };
};

export type CodexData = {
    categories?: string[];
    subcategories?: { [category: string]: string[]; };
    resources?: {
        credentialDocumentation?: DocumentationLink[];
        primaryDocumentation?: DocumentationLink[];
    };
    alias?: string[];
};

export type NodeHint = {
    message: string;
    type?: 'info' | 'warning' | 'danger';
    location?: 'outputPane' | 'inputPane' | 'ndv';
    displayCondition?: string;
    whenToDisplay?: 'always' | 'beforeExecution' | 'afterExecution';
    group?: NodeHintGroup;
};

export interface INodeCredentialDescription {
    name: string;
    required?: boolean;
    displayName?: string;
    disabledOptions?: ICredentialsDisplayOptions;
    displayOptions?: ICredentialsDisplayOptions;
    testedBy?: ICredentialTestRequest | string;
}

export interface IWebhookDescription {
    [key: string]: IHttpRequestMethods | WebhookResponseMode | boolean | string | undefined;
    httpMethod: IHttpRequestMethods | string;
    isFullPath?: boolean;
    name: WebhookType;               // 'default' | 'setup'
    path: string;
    responseBinaryPropertyName?: string;
    responseContentType?: string;
    responsePropertyName?: string;
    responseMode?: WebhookResponseMode | string;
    responseData?: WebhookResponseData | string;
    restartWebhook?: boolean;
    nodeType?: 'webhook' | 'form' | 'mcp';
    ndvHideUrl?: string | boolean;
    ndvHideMethod?: string | boolean;
}
export type WebhookResponseMode = 'onReceived' | 'lastNode' | 'responseNode' | 'formPage' | 'hostedChat' | 'streaming';
export type WebhookResponseData = 'allEntries' | 'firstEntryJson' | 'firstEntryBinary' | 'noData';

// features: version-gated booleans, readable at runtime via this.isNodeFeatureEnabled(name)
export type FeatureCondition = { '@version': Array<number | DisplayCondition>; };
export type NodeFeaturesDefinition = Record<string, FeatureCondition>;
```

### Field cheat sheet

| Field | Meaning / notes |
|---|---|
| `name` | Machine id, **unprefixed** in the class (`"set"`). The registry exposes it as `"<packageName>.<name>"` (`n8n-nodes-base.set`), and the prefix is added at load time. |
| `displayName`, `description`, `subtitle` | UI strings. `subtitle` is usually an expression: `'={{$parameter["operation"] + ": " + $parameter["resource"]}}'`. |
| `group` | Coarse category. `'trigger'` marks trigger nodes (also used by tooling); `'schedule'` marks schedule triggers. |
| `version` / `defaultVersion` | `version` is a number or an array (light versioning). `defaultVersion` sits on the base description of a `VersionedNodeType` and sets the version new nodes get. |
| `defaults.name` | Default instance name on the canvas. |
| `inputs` / `outputs` | Array of connection types/configs, **or** an expression string evaluated per node instance (see §4). |
| `inputNames` / `outputNames` | Labels, for example `outputNames: ['true','false']` on If. |
| `requiredInputs` | Which inputs must have data before the node runs (Merge). |
| `credentials` | Which credential types the node accepts, conditionally shown via `displayOptions` (for example per `authentication` value). |
| `properties` | Parameter schema (§5). |
| `polling: true` | Poll trigger. Loader injects `pollTimes`. |
| `webhooks` | Declares HTTP endpoints the node owns. `path` can be an expression; `isFullPath` controls whether the webhookId prefix is used. |
| `supportsCORS` | Webhook nodes. Loader injects an `allowedOrigins` option. |
| `triggerPanel`, `eventTriggerDescription`, `activationMessage` | UX for trigger "listen for test event" panel. |
| `requestDefaults`, `requestOperations` | Declarative-style defaults (baseURL, headers) and pagination. |
| `codex` | Categories/subcategories/aliases/doc links for the node picker. Usually comes from the sibling `X.node.json` file. |
| `usableAsTool` | At registry build, n8n **clones** the description into `<name>Tool` with `inputs: []`, `outputs: ['ai_tool']`, `displayName + ' Tool'`, and injects a `toolDescription` param. `replacements` can override fields. |
| `hidden` / `deprecated` | Hide from the picker, or block adding the node or version. |
| `maxNodes` | Max instances per workflow (for example 1 for some triggers). |
| `hints` | Static UI hints. Runtime hints come from `this.addExecutionHints()`. |
| `features` | Named, version-gated feature flags. The node checks them with `this.isNodeFeatureEnabled('x')`. |
| `sensitiveOutputFields` | Dot-paths in `item.json` that are always redacted. |
| `builderHint` | Hints for n8n's AI workflow builder and the workflow-sdk type generator. |
| `__loadOptionsMethods` | **Added by the loader**: the names of `methods.loadOptions`, so the UI knows they exist without code. |
| `communityNodePackageVersion` | **Added by the loader** for community packages. |

---

## 4. Connections, inputs/outputs and dynamic I/O

```ts
export declare const NodeConnectionTypes: {
    readonly AiAgent: 'ai_agent';
    readonly AiChain: 'ai_chain';
    readonly AiDocument: 'ai_document';
    readonly AiEmbedding: 'ai_embedding';
    readonly AiLanguageModel: 'ai_languageModel';
    readonly AiMemory: 'ai_memory';
    readonly AiOutputParser: 'ai_outputParser';
    readonly AiRetriever: 'ai_retriever';
    readonly AiReranker: 'ai_reranker';
    readonly AiTextSplitter: 'ai_textSplitter';
    readonly AiTool: 'ai_tool';
    readonly AiVectorStore: 'ai_vectorStore';
    readonly Main: 'main';
};
export type NodeConnectionType = (typeof NodeConnectionTypes)[keyof typeof NodeConnectionTypes];
export type AINodeConnectionType = Exclude<NodeConnectionType, typeof NodeConnectionTypes.Main>;

export interface INodeFilter { nodes?: string[]; excludedNodes?: string[]; }
export interface INodeInputConfiguration {
    category?: string;
    displayName?: string;
    required?: boolean;
    type: NodeConnectionType;
    filter?: INodeFilter;
    maxConnections?: number;
}
export interface INodeOutputConfiguration {
    category?: 'error';
    displayName?: string;
    maxConnections?: number;
    required?: boolean;
    type: NodeConnectionType;
    filter?: INodeFilter;
}
export type ExpressionString = `={{${string}}}`;
```

* **`main`** carries item data. All `ai_*` types are **capability links**: the sub-node (`supplyData`) hands a live object to the parent,
  which calls `this.getInputConnectionData('ai_languageModel', i)`. A node is a **sub-node** when its `outputs` contain any non-`main` type
  (`isSubNodeType()` in `node-helpers.js`). Sub-nodes have `inputs: []` (or more ai inputs) and do not take part in the item flow.
* `category: 'error'` on an output marks the **error output** (used with `onError: 'continueErrorOutput'`).
* Workflow connection JSON: `connections[sourceNodeName][connectionType][outputIndex] = [{ node, type, index }]`.

```ts
export interface IConnection { node: string; type: NodeConnectionType; index: number; }
export type NodeInputConnections = Array<IConnection[] | null>;
export interface INodeConnections { [key: string]: NodeInputConnections; }
export interface IConnections { [key: string]: INodeConnections; }
```

### Dynamic (expression-based) inputs/outputs

`inputs`/`outputs` may be a `={{ … }}` string. n8n **stringifies a JS function into the expression**, and it is evaluated against the
node's parameters (`$parameter`) both in the browser and on the backend (`NodeHelpers.getNodeInputs/getNodeOutputs`). Real example, Switch V3:

```js
const configuredOutputs = (parameters) => {
    const mode = parameters.mode;
    if (mode === 'expression') {
        return Array.from({ length: parameters.numberOutputs }, (_, i) => ({ type: 'main', displayName: i.toString() }));
    } else {
        const rules = parameters.rules?.values ?? [];
        const ruleOutputs = rules.map((rule, index) => ({ type: 'main', displayName: rule.outputKey || index.toString() }));
        if (parameters.options?.fallbackOutput === 'extra') {
            ruleOutputs.push({ type: 'main', displayName: parameters.options?.renameFallbackOutput || 'Fallback' });
        }
        return ruleOutputs;
    }
};
// in description:
inputs: [NodeConnectionTypes.Main],
outputs: `={{(${configuredOutputs})($parameter)}}`,
```

The AI Agent V3 does the same for `inputs`. It inlines `getInputs.toString()` and adds `ai_languageModel` / `ai_memory` / `ai_tool` /
`ai_outputParser` inputs depending on `$parameter.hasOutputParser` and `$parameter.needsFallback`. The manifest (`types/nodes.json`)
stores this **as JavaScript source text inside a string**, so any consumer must run a JS expression engine. That is a portability trap for Landflow (see §14).

---

## 5. `INodeProperties`: parameters and UI schema

```ts
export interface INodeProperties {
    displayName: string;
    name: string;
    type: NodePropertyTypes;
    typeOptions?: INodePropertyTypeOptions;
    default: NodeParameterValueType;
    description?: string;
    hint?: string;
    builderHint?: IParameterBuilderHint;
    disabledOptions?: IDisplayOptions;
    displayOptions?: IDisplayOptions;
    envFeatureFlag?: Uppercase<string>;
    options?: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection>;
    placeholder?: string;
    isNodeSetting?: boolean;
    noDataExpression?: boolean;
    required?: boolean;
    routing?: INodePropertyRouting;
    credentialTypes?: Array<'extends:oAuth2Api' | 'extends:oAuth1Api' | 'has:authenticate' | 'has:genericAuth'>;
    extractValue?: INodePropertyValueExtractor;
    modes?: INodePropertyMode[];
    requiresDataPath?: 'single' | 'multiple';
    doNotInherit?: boolean;
    validateType?: FieldType;
    ignoreValidationDuringExecution?: boolean;
    allowArbitraryValues?: boolean;
    resolvableField?: boolean;
}

export interface INodePropertyOptions {           // entries of type 'options' / 'multiOptions'
    name: string;
    value: string | number | boolean;
    action?: string;
    description?: string;
    disabled?: boolean;
    builderHint?: IParameterBuilderHint;
    routing?: INodePropertyRouting;
    outputConnectionType?: NodeConnectionType;
    inputSchema?: any;
    displayOptions?: IDisplayOptions;
    disabledOptions?: undefined;
    envFeatureFlag?: Uppercase<string>;
}
export interface INodePropertyCollection {        // entries of type 'fixedCollection'
    displayName: string;
    name: string;
    values: INodeProperties[];
    builderHint?: IParameterBuilderHint;
}
```

### 5.1 Property `type` values

```ts
export type NodePropertyTypes = 'boolean' | 'button' | 'collection' | 'color' | 'dateTime' | 'fixedCollection' | 'hidden' | 'icon' | 'json' | 'callout' | 'notice' | 'multiOptions' | 'number' | 'options' | 'string' | 'credentialsSelect' | 'resourceLocator' | 'curlImport' | 'resourceMapper' | 'filter' | 'assignmentCollection' | 'credentials' | 'workflowSelector' | 'agentSelector';
```

| `type` | Stored value shape | Meaning |
|---|---|---|
| `string` | `string` | Text input. `typeOptions`: `password`, `rows` (textarea), `editor` (`codeNodeEditor` \| `jsEditor` \| `htmlEditor` \| `sqlEditor` \| `cssEditor`), `sqlDialect`, `multipleValues`, `loadOptionsMethod` (turns into an autocomplete). |
| `number` | `number` | Numeric input. `minValue`, `maxValue`, `numberPrecision`. |
| `boolean` | `boolean` | Toggle. |
| `options` | `string\|number\|boolean` | Single-select from `options: INodePropertyOptions[]`, or dynamic via `typeOptions.loadOptionsMethod` + `loadOptionsDependsOn`. **`resource`/`operation` are just `options` params by convention.** |
| `multiOptions` | `array` | Multi-select, static or `loadOptionsMethod`. |
| `collection` | `object` | "Add option" bag of optional sub-properties (`options: INodeProperties[]`). Only the fields the user adds are stored. |
| `fixedCollection` | `{ [groupName]: object \| object[] }` | Named groups (`options: INodePropertyCollection[]`, each with `values`). `typeOptions.multipleValues` repeats them, `sortable` allows reordering. |
| `json` | `string` (JSON text) | JSON editor. |
| `color` | `string` | Color picker (`showAlpha`). |
| `dateTime` | `string` (ISO) | Date/time picker (`dateOnly`). |
| `hidden` | any | Not shown. Used for internal values, often version-stamped. |
| `notice` | (none) | Static info box. `displayName` is the text. |
| `callout` | (none) | Richer notice with `typeOptions.calloutAction` (for example opening a template). |
| `button` | (none) | Runs `typeOptions.buttonConfig.action` (a `methods.actionHandler` name, or `askAiCodeGeneration`). |
| `curlImport` | (none) | "Import cURL" helper that fills other params (HTTP Request). |
| `credentialsSelect` | `string` | Pick a **credential type** (filtered by `credentialTypes: ['extends:oAuth2Api', 'has:authenticate', …]`). Used by HTTP Request "predefined credential". |
| `credentials` | `string` | Embedded credential picker inside the parameter panel (used by Evaluation nodes). |
| `resourceLocator` | `{ __rl: true, mode, value, cachedResultName?, cachedResultUrl? }` | Multi-mode picker. `modes: INodePropertyMode[]` with `type: 'list'` (backed by `methods.listSearch` via `typeOptions.searchListMethod`) or `'string'` (ID/URL with `validation` regex and `extractValue` regex). |
| `resourceMapper` | `ResourceMapperValue` | Column mapping UI for DB/CRM rows. Schema fetched via `methods.resourceMapping[resourceMapperMethod]`. Mode: `add` \| `update` \| `upsert` \| `map`. |
| `filter` | `FilterValue` | Condition builder (`leftValue / operator / rightValue`, `and/or`), used by If/Filter/Switch. |
| `assignmentCollection` | `{ assignments: [{id,name,value,type}] }` | Name/value/type list (Set / Edit Fields v3.3+). |
| `workflowSelector` | resourceLocator-like | Pick another workflow (Execute Workflow node). |
| `agentSelector` | string | Pick an n8n agent ("Message an Agent"). |
| `icon` | `{type:'icon'\|'emoji', value}` | Icon/emoji picker (Chat Trigger). |

Structured value shapes:

```ts
export interface INodeParameterResourceLocator {
    __rl: true;
    mode: ResourceLocatorModes;            // 'id' | 'url' | 'list' | string
    value: Exclude<NodeParameterValue, boolean>;
    cachedResultName?: string;
    cachedResultUrl?: string;
    __regex?: string;
}
export type ResourceMapperValue = {
    mappingMode: string;
    value: { [key: string]: string | number | boolean | null; } | null;
    matchingColumns: string[];
    schema: ResourceMapperField[];
    attemptToConvertTypes: boolean;
    convertFieldsToString: boolean;
};
export type FilterValue = { options: FilterOptionsValue; conditions: FilterConditionValue[]; combinator: FilterTypeCombinator; };
export type AssignmentCollectionValue = { assignments: AssignmentValue[]; };
export type AssignmentValue = { id: string; name: string; value: NodeParameterValue; type?: string; };
export type NodeParameterValue = string | number | boolean | undefined | null;
export type NodeParameterValueType = NodeParameterValue | INodeParameters | INodeParameterResourceLocator | ResourceMapperValue | FilterValue | AssignmentCollectionValue | IconOrEmoji | NodeParameterValue[] | INodeParameters[] | INodeParameterResourceLocator[] | ResourceMapperValue[];
```

### 5.2 `typeOptions`

```ts
export interface INodePropertyTypeOptions {
    buttonConfig?: { action?: string | NodePropertyAction; label?: string; hasInputField?: boolean; inputFieldMaxLength?: number; };
    containerClass?: string;
    sectionHeader?: boolean;
    alwaysOpenEditWindow?: boolean;
    codeAutocomplete?: CodeAutocompleteTypes;
    editor?: EditorType;
    editorIsReadOnly?: boolean;
    sqlDialect?: SQLDialect;
    loadOptionsDependsOn?: string[];
    loadOptionsMethod?: string;
    loadOptions?: ILoadOptions;          // declarative load-options: { routing: { request, output, operations } }
    maxValue?: number;
    minValue?: number;
    multipleValues?: boolean;
    multipleValueButtonText?: string;
    numberPrecision?: number;
    fixedCollection?: { itemTitle?: string; layout?: 'inline'; };
    password?: boolean;
    copyButton?: boolean;
    redactJsonLeaves?: boolean;
    resolveCredentialJsonLeaves?: boolean;
    ignoreCredentialExpressionResolveError?: boolean;
    rows?: number;
    showAlpha?: boolean;
    sortable?: boolean;
    expirable?: boolean;
    dateOnly?: boolean;
    resourceMapper?: ResourceMapperTypeOptions;
    filter?: FilterTypeOptions;
    assignment?: AssignmentTypeOptions;
    minRequiredFields?: number;
    maxAllowedFields?: number;
    hideOptionalFields?: boolean;
    addOptionalFieldButtonText?: string;
    showEvenWhenOptional?: boolean;
    calloutAction?: CalloutAction;
    binaryDataProperty?: boolean;
    [key: string]: any;                  // open-ended! values may be expressions, e.g. filter.version: '={{ $nodeVersion >= 2.4 ? 4 : 1 }}'
}

export interface INodePropertyMode {           // resourceLocator modes
    displayName: string;
    name: string;
    type: 'string' | 'list';
    hint?: string;
    validation?: Array<INodePropertyModeValidation | { (this: IExecuteSingleFunctions, value: string): void; }>;
    placeholder?: string;
    url?: string;
    extractValue?: INodePropertyValueExtractor;    // { type: 'regex', regex }
    initType?: string;
    entryTypes?: { [name: string]: { selectable?: boolean; hidden?: boolean; queryable?: boolean; data?: { request?: IHttpRequestOptions; output?: INodeRequestOutput; }; }; };
    search?: INodePropertyRouting;
    typeOptions?: INodePropertyModeTypeOptions;    // searchListMethod, searchable, searchFilterRequired, slowLoadNotice, allowNewResource …
}
```

### 5.3 `displayOptions`: conditional visibility

```ts
export interface IDisplayOptions {
    hide?: {
        [key: string]: Array<NodeParameterValue | DisplayCondition> | undefined;
    };
    show?: {
        '@version'?: Array<number | DisplayCondition>;
        '@feature'?: Array<string | DisplayCondition>;
        '@tool'?: boolean[];
        [key: string]: Array<NodeParameterValue | DisplayCondition> | undefined;
    };
    showOnDeployment?: DeploymentCondition;   // 'cloud' | 'hosted'
    /** @deprecated Use showOnDeployment instead */
    hideOnCloud?: boolean;
}
export type DisplayCondition =
    | { _cnd: { eq: NodeParameterValue } } | { _cnd: { not: NodeParameterValue } }
    | { _cnd: { gte: number | string } }   | { _cnd: { lte: number | string } }
    | { _cnd: { gt: number | string } }    | { _cnd: { lt: number | string } }
    | { _cnd: { between: { from: number | string; to: number | string } } }
    | { _cnd: { startsWith: string } }     | { _cnd: { endsWith: string } }
    | { _cnd: { includes: string } }       | { _cnd: { regex: string } }
    | { _cnd: { exists: true } };
```

Semantics, from `NodeHelpers.displayParameter`:
* Keys are **sibling parameter names**. A key starting with `/` is an **absolute path from the root** (`'/includeOtherFields': [false]`),
  which lets properties nested in collections refer to top-level params.
* Each key holds an array of allowed values (OR within the array). Keys are ANDed. `hide` wins over `show`.
* Pseudo-keys: `@version` (node `typeVersion`), `@feature` (from `description.features`), `@tool` (rendered as an AI tool or not).
* `_cnd` operators make numeric/version ranges possible, for example `'@version': [{ _cnd: { gte: 3.4 } }]`.
* **Hidden parameters are not stored/validated** (`getNodeParameters(..., returnNoneDisplayed=false)` strips them). The same property `name`
  may be declared several times with mutually exclusive `displayOptions` (Set V2 declares `include` twice for different versions).
* `disabledOptions` uses the same shape but greys the field out.

### 5.4 Other common flags

* `default` is **required** and is the stored value when the user hasn't touched the field. n8n saves only non-default values in the workflow
  JSON, so changing a default changes old workflows. That is one reason for versioning.
* `required`: validation (node issues shown on canvas).
* `noDataExpression: true`: the field can't be an expression (used for `resource`/`operation`/`mode`, which drive the UI).
* `isNodeSetting: true`: rendered in the "Settings" tab instead of "Parameters".
* `requiresDataPath`: the field expects a JSON path into the input item (drag-and-drop from the input panel).
* **Expressions**: any string value that starts with `=` is an expression: `'={{ $json.id }}'`, `'=Bearer {{$credentials.token}}'`.
  Available in expressions: `$json`, `$binary`, `$parameter`, `$credentials` (credential/declarative contexts), `$node`, `$input`, `$now`, `$vars`,
  `$nodeVersion`, `$value` (resource-locator URL), `$response` (declarative output) and others.

### 5.5 `routing` (per property or per option, declarative)

```ts
export interface INodePropertyRouting {
    operations?: IN8nRequestOperations;          // pagination
    output?: INodeRequestOutput;                 // post-processing
    request?: DeclarativeRestApiSettings.HttpRequestOptions;   // merged into the request
    send?: INodeRequestSend;                     // put THIS param's value into body/query
}
export interface INodeRequestSend {
    preSend?: PreSendAction[];
    paginate?: boolean | string;
    property?: string;
    propertyInDotNotation?: boolean;
    type?: 'body' | 'query';
    value?: string;
}
export interface INodeRequestOutput {
    maxResults?: number | string;
    postReceive?: PostReceiveAction[];
}
export type PostReceiveAction =
    ((this: IExecuteSingleFunctions, items: INodeExecutionData[], response: IN8nHttpFullResponse) => Promise<INodeExecutionData[]>)
    | IPostReceiveBinaryData | IPostReceiveFilter | IPostReceiveLimit | IPostReceiveRootProperty
    | IPostReceiveSet | IPostReceiveSetKeyValue | IPostReceiveSort;
export type PreSendAction = (this: IExecuteSingleFunctions, requestOptions: IHttpRequestOptions) => Promise<IHttpRequestOptions>;
// e.g. { type: 'rootProperty', properties: { property: 'data' } }, { type: 'limit', properties: { maxResults: '={{$parameter.limit}}' } }

export interface IN8nRequestOperations {
    pagination?: IN8nRequestOperationPaginationGeneric | IN8nRequestOperationPaginationOffset
        | ((this: IExecutePaginationFunctions, requestOptions: DeclarativeRestApiSettings.ResultOptions) => Promise<INodeExecutionData[]>);
}
export interface IN8nRequestOperationPaginationOffset extends IN8nRequestOperationPaginationBase {
    type: 'offset';
    properties: { limitParameter: string; offsetParameter: string; pageSize: number; rootProperty?: string; type: 'body' | 'query'; };
}
```

Note: `preSend`, function-form `postReceive` and function-form pagination are **JS functions**. When the description is serialized to
`types/nodes.json` they become `null` (verified: Npm node's `postReceive: [null]`). The UI doesn't need them. Only the backend
`RoutingNode`, holding the live class instance, does.

---

## 6. Declarative (routing) vs programmatic style

| | Declarative | Programmatic |
|---|---|---|
| Code | No `execute`. `description.requestDefaults` + `routing` on properties/options | `execute()` (or `trigger`/`poll`/`webhook`/`supplyData`) |
| Engine | `RoutingNode` (n8n-core) builds one HTTP request per item from `requestDefaults` ⊕ selected option's `routing.request` ⊕ each visible param's `routing.send`, applies credential `authenticate`, paginates, runs `postReceive` | Your code |
| Good for | REST CRUD wrappers ("resource/operation" APIs) | Anything else: triggers, non-HTTP protocols, data transforms, AI sub-nodes, complex flows |
| Versioning | Light versioning only (`version: [1,2]` + `@version`). The docs say full `VersionedNodeType` isn't supported for declarative nodes. | Light or full |
| Escape hatches | `customOperations[resource][operation]` (code for one operation), function `preSend`/`postReceive`/pagination | n/a |
| Auto-injected | Loader appends a `requestOptions` collection (batching, ignore SSL, proxy, timeout) via `applyDeclarativeNodeOptionParameters` | none |

Declarative example (n8n-nodes-base **Npm**, trimmed, real):

```js
class Npm {
    description = {
        displayName: 'Npm',
        name: 'npm',
        icon: 'file:npm.svg',
        group: ['input'],
        version: 1,
        subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
        description: 'Consume NPM registry API',
        defaults: { name: 'npm' },
        usableAsTool: true,
        inputs: [NodeConnectionTypes.Main],
        outputs: [NodeConnectionTypes.Main],
        credentials: [{ name: 'npmApi', required: false }],
        requestDefaults: { baseURL: '={{ $credentials.registryUrl }}' },
        properties: [
            { displayName: 'Resource', name: 'resource', type: 'options', noDataExpression: true,
              options: [ { name: 'Package', value: 'package' }, { name: 'Distribution Tag', value: 'distTag' } ],
              default: 'package' },
            {
                displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true,
                default: 'getMetadata',
                displayOptions: { show: { resource: ['package'] } },
                options: [
                    {
                        name: 'Get Metadata', value: 'getMetadata',
                        action: 'Returns all the metadata for a package at a specific version',
                        routing: { request: { method: 'GET',
                            url: '=/{{ encodeURIComponent($parameter.packageName) }}/{{ $parameter.packageVersion }}' } },
                    },
                    {
                        name: 'Get Versions', value: 'getVersions',
                        routing: {
                            request: { method: 'GET', url: '=/{{ encodeURIComponent($parameter.packageName) }}' },
                            output: { postReceive: [ async function (items) { /* reshape json.time → [{version, published_at}] */ } ] },
                        },
                    },
                    // …
                ],
            },
            // …packageFields, distTagOperations, distTagFields
        ],
    };
}
```

---

## 7. Versioning

**Light versioning**: one class, `version: [3, 3.1, 3.2, 3.3, 3.4, 3.5]`, with branches by `displayOptions['@version']` in the
schema and `this.getNode().typeVersion` in code. Each workflow node stores `typeVersion` and keeps it forever. New nodes get the latest
version (or `defaultVersion`).

**Full versioning**: `VersionedNodeType`:

```ts
// n8n-workflow/dist/esm/versioned-node-type.d.ts
export declare class VersionedNodeType implements IVersionedNodeType {
    currentVersion: number;
    nodeVersions: IVersionedNodeType['nodeVersions'];
    description: INodeTypeBaseDescription;
    constructor(nodeVersions: IVersionedNodeType['nodeVersions'], description: INodeTypeBaseDescription);
    getLatestVersion(): number;
    getNodeType(version?: number): INodeType;
}
// interfaces.d.ts
export interface IVersionedNodeType {
    nodeVersions: { [key: number]: INodeType; };
    currentVersion: number;
    description: INodeTypeBaseDescription;
    getNodeType: (version?: number) => INodeType;
}
```

Real (Set node):

```js
class Set extends VersionedNodeType {
    constructor() {
        const baseDescription = {
            displayName: 'Set', name: 'set', icon: 'node:edit-fields', iconColor: 'blue', group: ['input'],
            description: 'Add or edit fields on an input item and optionally remove other fields',
            defaultVersion: 3.5,
        };
        const nodeVersions = {
            1: new SetV1(baseDescription), 2: new SetV1(baseDescription),
            3: new SetV2(baseDescription), 3.1: new SetV2(baseDescription), 3.2: new SetV2(baseDescription),
            3.3: new SetV2(baseDescription), 3.4: new SetV2(baseDescription), 3.5: new SetV2(baseDescription),
        };
        super(nodeVersions, baseDescription);
    }
}
```

In the manifest, **each distinct implementation becomes one entry** with the same `name` and its own `version` array
(Set appears twice: `version: [3,3.1,…,3.5]` and `version: [1,2]`, both with `defaultVersion: 3.5`). The loader copies
`name` and `codex` from the base onto every version (`getVersionedNodeTypeAll`). The engine resolves
`nodeTypes.getByNameAndVersion(type, typeVersion)`.

---

## 8. Credentials: `ICredentialType`

```ts
export interface ICredentialType {
    name: string;
    displayName: string;
    icon?: Icon;
    iconColor?: ThemeIconColor;
    iconUrl?: Themed<string>;
    iconBasePath?: string;
    extends?: string[];                    // inherit e.g. ['oAuth2Api'] → OAuth2 flow + fields
    properties: INodeProperties[];         // same schema language as node params
    documentationUrl?: string;
    methods?: {
        loadOptions?: {
            [method: string]: (credentials: ICredentialDataDecryptedObject, filter?: string, paginationToken?: string) => Promise<INodeListSearchResult>;
        };
    };
    __overwrittenProperties?: string[];
    __skipManagedCreation?: boolean;
    __showManagedOAuthScopes?: boolean;
    authenticate?: IAuthenticate;
    preAuthentication?: (this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) => Promise<IDataObject>;
    test?: ICredentialTestRequest;
    genericAuth?: boolean;
    httpRequestNode?: ICredentialHttpRequestNode;
    supportedNodes?: string[];
    restrictToSupportedNodes?: true;
    hideDomainRestrictionFields?: boolean;
    hidden?: boolean;
}

export interface IAuthenticateGeneric extends IAuthenticateBase {
    type: 'generic';
    properties: IRequestOptionsSimplifiedAuth;     // { auth?, body?, headers?, qs?, url?, skipSslCertificateValidation? }
}
export type IAuthenticate =
    ((credentials: ICredentialDataDecryptedObject, requestOptions: IHttpRequestOptions) => Promise<IHttpRequestOptions>)
    | IAuthenticateGeneric;

export interface ICredentialTestRequest {
    request: DeclarativeRestApiSettings.HttpRequestOptions;
    rules?: IAuthenticateRuleResponseCode[] | IAuthenticateRuleResponseSuccessBody[];
}
export interface IAuthenticateRuleResponseCode extends IAuthenticateRuleBase {
    type: 'responseCode';
    properties: { value: number; message: string; };
}
export interface IAuthenticateRuleResponseSuccessBody extends IAuthenticateRuleBase {
    type: 'responseSuccessBody';
    properties: { message: string; key: string; value: any; };
}
```

Real example (fully declarative, JSON-serializable):

```js
class NpmApi {
    name = 'npmApi';
    displayName = 'Npm API';
    documentationUrl = 'npm';
    properties = [
        { displayName: 'Access Token', name: 'accessToken', type: 'string', typeOptions: { password: true }, default: '' },
        { displayName: 'Registry Url', name: 'registryUrl', type: 'string', default: 'https://registry.npmjs.org' },
    ];
    authenticate = { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } } };
    test = { request: { baseURL: '={{$credentials.registryUrl}}', url: '/-/whoami' } };
}
```

How it's used:
* Node declares `credentials: [{ name: 'npmApi', required: true, displayOptions: {...} }]`.
* In code: `await this.getCredentials('npmApi')` (decrypted object), or better
  `this.helpers.httpRequestWithAuthentication.call(this, 'npmApi', options)`, which applies `authenticate` (and OAuth refresh) automatically.
* Declarative nodes get `authenticate` applied automatically by `RoutingNode`.
* Test: `credential.test` (declarative request + rules) **or** node-side `methods.credentialTest[fn]` referenced by `credentials[].testedBy`.
* `supportedNodes` is **computed by the loader** (inverted from node `credentials` lists) and written into `known/credentials.json`.
* When a function-form `authenticate` is serialized for the UI, the loader replaces it with `{}` via a custom `toJSON`.
* OAuth2/OAuth1 come from base credential types `oAuth2Api` / `oAuth1Api` via `extends`. n8n runs the redirect flow itself.

---

## 9. Execution context surface

All contexts share `FunctionsBase`:

```ts
export interface FunctionsBase {
    logger: Logger;
    customData: IWorkflowExecutionCustomData;
    getCredentials<T extends object = ICredentialDataDecryptedObject>(type: string, itemIndex?: number): Promise<T>;
    getCredentialsProperties(type: string): INodeProperties[];
    getExecutionId(): string;
    getNode(): INode;
    getWorkflow(): IWorkflowMetadata;
    getWorkflowSettings(): IWorkflowSettings;
    getWorkflowStaticData(type: string): IDataObject;     // 'node' | 'global': persisted state (poll cursors, webhook ids)
    getTimezone(): string;
    getRestApiUrl(): string;
    getInstanceBaseUrl(): string;
    getInstanceId(): string;
    getSignedResumeUrl(parameters?: Record<string, string>): string;
    getChildNodes(nodeName: string, options?: { includeNodeParameters?: boolean; }): NodeTypeAndVersion[];
    getParentNodes(nodeName: string, options?: { includeNodeParameters?: boolean; connectionType?: NodeConnectionType; depth?: number; }): NodeTypeAndVersion[];
    getKnownNodeTypes(): IDataObject;
    getMode?: () => WorkflowExecuteMode;
    getActivationMode?: () => WorkflowActivateMode;
    getChatTrigger: () => INode | null;
    isNodeFeatureEnabled(featureName: string): boolean;
    getExecutionContext: () => IExecutionContext | undefined;
    listAgents?(): Promise<Array<{ id: string; name: string; }>>;
    /** @deprecated */
    prepareOutputData(outputData: INodeExecutionData[]): Promise<INodeExecutionData[][]>;
}
```

`IExecuteFunctions` (key parts):

```ts
type BaseExecutionFunctions = FunctionsBaseWithRequiredKeys<'getMode'> & {
    continueOnFail(): boolean;
    setMetadata(metadata: ITaskMetadata): void;
    evaluateExpression(expression: string, itemIndex: number): NodeParameterValueType;
    getContext(type: ContextType): IContextObject;
    getExecuteData(): IExecuteData;
    getWorkflowDataProxy(itemIndex: number): IWorkflowDataProxyData;
    getInputSourceData(inputIndex?: number, connectionType?: NodeConnectionType): ISourceData;
    getExecutionCancelSignal(): AbortSignal | undefined;
    onExecutionCancellation(handler: () => unknown): void;
    onExecutionFinish?(handler: () => unknown): void;
    logAiEvent(eventName: AiEvent, msg?: string): void;
};
export type IExecuteFunctions = ExecuteFunctions.GetNodeParameterFn & BaseExecutionFunctions & {
    executeWorkflow(workflowInfo: IExecuteWorkflowInfo, inputData?: INodeExecutionData[], parentCallbackManager?: CallbackManager, options?: {...}): Promise<ExecuteWorkflowData>;
    executeAgent(agentInfo: ExecuteAgentInfo, message: string, executionId: string, itemIndex: number): Promise<ExecuteAgentData>;
    getInputConnectionData(connectionType: AINodeConnectionType, itemIndex: number, inputIndex?: number): Promise<unknown>;
    getInputData(inputIndex?: number, connectionType?: NodeConnectionType): INodeExecutionData[];
    getNodeInputs(): INodeInputConfiguration[];
    getNodeOutputs(): INodeOutputConfiguration[];
    putExecutionToWait(waitTill: Date, options?: { acceptsResumeRequest?: boolean; }): Promise<void>;
    sendMessageToUI(message: any): void;
    sendResponse(response: IExecuteResponsePromiseData): Promise<void>;
    sendChunk(type: ChunkType, itemIndex: number, content?: IDataObject | string): void;
    isStreaming(): boolean;
    isToolExecution(): boolean;
    addInputData(...): { index: number; };
    addOutputData(...): void;
    addExecutionHints(...hints: NodeExecutionHint[]): void;
    nodeHelpers: NodeHelperFunctions;
    helpers: RequestHelperFunctions & BaseHelperFunctions & BinaryHelperFunctions & DeduplicationHelperFunctions
        & FileSystemHelperFunctions & SSHTunnelFunctions & DataTableProxyFunctions & CredentialCheckProxyFunctions & {
        normalizeItems(items: INodeExecutionData | INodeExecutionData[]): INodeExecutionData[];
        constructExecutionMetaData(inputData: INodeExecutionData[], options: { itemData: IPairedItemData | IPairedItemData[]; }): NodeExecutionWithMetadata[];
        assertBinaryData(itemIndex: number, parameterData: string | IBinaryData): IBinaryData;
        getBinaryDataBuffer(itemIndex: number, parameterData: string | IBinaryData): Promise<Buffer>;
        detectBinaryEncoding(buffer: Buffer): string;
        copyInputItems(items: INodeExecutionData[], properties: string[]): IDataObject[];
    };
    startJob<T = unknown, E = unknown>(jobType: string, settings: unknown, itemIndex: number): Promise<Result<T, E>>;
    // …
};

// getNodeParameter: resolves expressions for the given item, applies defaults, supports dot paths ('options.timeout', 'fields.values')
getNodeParameter(parameterName: string, itemIndex: number, fallbackValue?: any, options?: IGetNodeParameterOptions): NodeParameterValueType | object;
export interface IGetNodeParameterOptions {
    contextNode?: INode;
    ensureType?: EnsureTypeOptions;      // 'string' | 'number' | 'boolean' | 'object' | 'array' | 'json'
    extractValue?: boolean;              // resourceLocator → plain value (applies mode's extractValue regex)
    rawExpressions?: boolean;            // don't evaluate '={{…}}'
    skipValidation?: boolean;
}

export interface RequestHelperFunctions {
    httpRequest(requestOptions: IHttpRequestOptions): Promise<any>;
    httpRequestWithAuthentication(this: IAllExecuteFunctions, credentialsType: string, requestOptions: IHttpRequestOptions, additionalCredentialOptions?: IAdditionalCredentialOptions): Promise<any>;
    requestWithAuthenticationPaginated(this: IAllExecuteFunctions, requestOptions: IRequestOptions, itemIndex: number, paginationOptions: PaginationOptions, credentialsType?: string, ...): Promise<any[]>;
    /** @deprecated */ request(...): Promise<any>;
    /** @deprecated */ requestWithAuthentication(...): Promise<any>;
    /** @deprecated */ requestOAuth1(...): Promise<any>;
    /** @deprecated */ requestOAuth2(...): Promise<any>;
    refreshOAuth2Token(this: IAllExecuteFunctions, credentialsType: string, oAuth2Options?: IOAuth2Options): Promise<any>;
    getSecureEgressFilter(useDefaultSsrfPolicy?: UseDefaultSsrfPolicy): NodeEgressFilter;   // SSRF policy for custom clients
}
export interface BaseHelperFunctions {
    createDeferredPromise: <T = void>() => IDeferredPromise<T>;
    returnJsonArray(jsonData: IDataObject | IDataObject[]): INodeExecutionData[];
}
export interface BinaryHelperFunctions {
    prepareBinaryData(binaryData: Buffer | Readable, filePath?: string, mimeType?: string): Promise<IBinaryData>;
    setBinaryDataBuffer(data: IBinaryData, binaryData: Buffer): Promise<IBinaryData>;
    binaryToBuffer(body: Buffer | Readable): Promise<Buffer>;
    binaryToString(body: Buffer | Readable, encoding?: BufferEncoding): Promise<string>;
    getBinaryPath(binaryDataId: string): string;
    getBinaryStream(binaryDataId: string, chunkSize?: number): Promise<Readable>;
    createBinarySignedUrl(binaryData: IBinaryData, expiresIn?: string): string;
    getBinaryMetadata(binaryDataId: string): Promise<{ fileName?: string; mimeType?: string; fileSize: number; }>;
    // …
}
export interface IHttpRequestOptions {
    url: string;
    baseURL?: string;
    headers?: IDataObject;
    method?: IHttpRequestMethods;
    body?: FormData | GenericValue | GenericValue[] | Buffer | URLSearchParams;
    qs?: IDataObject;
    arrayFormat?: 'indices' | 'brackets' | 'repeat' | 'comma';
    auth?: { username: string; password: string; sendImmediately?: boolean; };
    disableFollowRedirect?: boolean;
    maxRedirects?: number;
    encoding?: 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream';
    skipSslCertificateValidation?: boolean;
    returnFullResponse?: boolean;
    ignoreHttpStatusErrors?: boolean | IgnoreStatusErrorConfig;
    proxy?: { host: string; port: number; auth?: { username: string; password: string; }; protocol?: string; };
    timeout?: number;
    maxResponseBodyBytes?: number;
    json?: boolean;
    abortSignal?: GenericAbortSignal;
    sendCredentialsOnCrossOriginRedirect?: boolean;
    allowedDomains?: string;
    agentOptions?: Omit<AgentOptions, 'socket' | 'lookup'>;
}
```

Other contexts (abridged): `ITriggerFunctions` (`emit(data, responsePromise?, donePromise?, deduplicationKey?)`, `emitError`, `saveFailedExecution`,
`helpers` incl. `SchedulingFunctions` for cron). `IPollFunctions` (`getPollBudgetMs()`, `__emit`). `IWebhookFunctions` (`getBodyData`,
`getHeaderData`, `getQueryData`, `getParamsData`, `getRequestObject` (express.Request), `getResponseObject` (express.Response), `getWebhookName`,
plus OAuth identity helpers).
`IHookFunctions` (`getNodeWebhookUrl`, `getWebhookDescription`). `ILoadOptionsFunctions` (`getNodeParameter(name)`,
`getCurrentNodeParameter(s)`, `helpers` = request + SSH + data tables). `ISupplyDataFunctions` (subset of execute + `cloneWith`).
`IExecuteSingleFunctions` (per-item variant used by declarative `preSend`/`postReceive`).

### Errors

```ts
// n8n-workflow/dist/esm/errors/node-operation.error.d.ts
export declare class NodeOperationError extends NodeError {
    type: string | undefined;
    constructor(node: INode, error: Error | string | JsonObject, options?: NodeOperationErrorOptions);
}
// node-api.error.d.ts
export interface NodeOperationErrorOptions {
    message?: string; description?: string; runIndex?: number; itemIndex?: number; level?: ErrorLevel;
    messageMapping?: { [key: string]: string; }; functionality?: Functionality; type?: string;
    metadata?: { subExecution?: RelatedExecution; parentExecution?: RelatedExecution; };
    failure?: Failure;
}
export declare class NodeApiError extends NodeError {
    httpCode: string | null;
    constructor(node: INode, errorResponse: JsonObject, { message, description, httpCode, parseXml, runIndex, itemIndex, level, functionality, messageMapping, failure, }?: NodeApiErrorOptions);
}
```

Canonical programmatic loop (the pattern used across n8n-nodes-base):

```ts
async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
  const items = this.getInputData();
  const out: INodeExecutionData[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const id = this.getNodeParameter('id', i) as string;            // expression resolved for item i
      const res = await this.helpers.httpRequestWithAuthentication.call(this, 'myApi', { method: 'GET', url: `https://api.x/${id}` });
      out.push(...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(res), { itemData: { item: i } }));
    } catch (error) {
      if (this.continueOnFail()) { out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } }); continue; }
      throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
    }
  }
  return [out];   // one output
}
```

---

## 10. Data shapes

```ts
export interface INodeExecutionData {
    [key: string]: IDataObject | IBinaryKeyData | INodeExecutionRedactionInfo | IPairedItemData | IPairedItemData[] | NodeApiError | NodeOperationError | number | string | undefined;
    json: IDataObject;
    binary?: IBinaryKeyData;                 // { [propertyName]: IBinaryData }
    error?: NodeApiError | NodeOperationError;
    pairedItem?: IPairedItemData | IPairedItemData[] | number;   // lineage → which input item produced this
    metadata?: { subExecution: RelatedExecution; };
    evaluationData?: Record<string, GenericValue>;
    redaction?: INodeExecutionRedactionInfo;
    sendMessage?: ChatNodeMessage;
    /** @deprecated */ index?: number;
}
export interface IPairedItemData { item: number; input?: number; sourceOverwrite?: ISourceData; }
export interface IBinaryData {
    [key: string]: string | number | undefined;
    data: string;          // base64, or a storage reference when external binary mode is on
    mimeType: string;
    fileType?: BinaryFileType;
    fileName?: string;
    directory?: string;
    fileExtension?: string;
    fileSize?: string;
    bytes?: number;
    id?: string;           // binary-data-service id ("filesystem:…", "s3:…")
}
export interface IDataObject { [key: string]: GenericValue | IDataObject | GenericValue[] | IDataObject[]; }

// workflow node instance
export interface INode {
    id: string; name: string; typeVersion: number; type: string; position: [number, number];
    disabled?: boolean; notes?: string; notesInFlow?: boolean;
    retryOnFail?: boolean; maxTries?: number; waitBetweenTries?: number;
    alwaysOutputData?: boolean; executeOnce?: boolean; onError?: OnError; continueOnFail?: boolean;
    parameters: INodeParameters; credentials?: INodeCredentials; webhookId?: string;
    extendsCredential?: string; rewireOutputLogTo?: NodeConnectionType;
    forceCustomOperation?: { resource: string; operation: string; };
    // …
}
```

**Return shape `INodeExecutionData[][]`**: outer index = output port, inner = items. `[[]]` means "ran, emitted nothing".
`null` from `poll` means "no new data, don't start an execution". Retry, `continueOnFail`, `alwaysOutputData`, `executeOnce` and `onError` are **engine-level node settings**
stored on `INode`, not in the node's own `properties`.

---

## 11. Discovery and loading

### 11.1 Package format: `package.json` `n8n` field

```ts
// n8n-core/dist/nodes-loader/types.d.ts
export declare namespace n8n {
    interface PackageJson {
        name: string;
        version: string;
        n8n?: {
            credentials?: string[];
            nodes?: string[];
            n8nNodesApiVersion?: number | string;
        };
        author?: { name?: string; email?: string; };
    }
}
```

Current starter template (`n8n-io/n8n-nodes-starter/package.json`):

```json
{
  "name": "n8n-nodes-<...>",
  "keywords": ["n8n-community-node-package"],
  "files": ["dist"],
  "n8n": {
    "n8nNodesApiVersion": 1,
    "strict": true,
    "credentials": [
      "dist/credentials/GithubIssuesApi.credentials.js",
      "dist/credentials/GithubIssuesOAuth2Api.credentials.js"
    ],
    "nodes": [
      "dist/nodes/GithubIssues/GithubIssues.node.js",
      "dist/nodes/Example/Example.node.js"
    ]
  },
  "devDependencies": { "@n8n/node-cli": "*" },
  "peerDependencies": { "n8n-workflow": "*" }
}
```

Conventions the loader relies on:
* **File name to class name**: `loadClass` takes `path.parse(sourcePath).name.split('.')[0]`, so `Github.node.js` must export class `Github`.
  The class is instantiated in a `vm` context: `new (require('<file>').Github)()` (`loadClassInIsolation`). This isn't a security sandbox. The script just gets the host's `require`.
* **Codex file**: `<File>.node.json` next to `<File>.node.js` (read via `module.require(filePath + 'on')`) supplies `categories`, `subcategories`,
  `alias` and `resources` if `description.codex` is absent.
* **Icons**: `icon: 'file:foo.svg'` is rewritten to `iconUrl: 'icons/<packageName>/<relative path>'` and must sit inside the package dir. `fa:<name>` and `node:<name>` are built-in refs.
* `n8nNodesApiVersion` is checked by `checkNodesApiVersion()` against `N8N_NODES_API_VERSION = '1.0'` (`@n8n/constants`). Missing means legacy level 1.
  Malformed or newer means the package is **skipped** with a warning.
* `strict: true` isn't read by the runtime loader. It's a flag for the `@n8n/node-cli` lint/verification tooling.
* Community packages must be named `n8n-nodes-*` or `@scope/n8n-nodes-*` (enforced by `parseNpmPackageName` and by `scanDirectoryForPackages` globs).
  Verified packages have **no runtime dependencies** and must be published from GitHub Actions with provenance.

### 11.2 Loader classes (n8n-core)

```ts
// n8n-workflow: the abstract contract
export interface NodeLoader {
    packageName: string;
    known: KnownNodesAndCredentials;
    types: { nodes: INodeTypeDescription[]; credentials: ICredentialType[]; };
    loadAll(): Promise<void>;
    getNode(nodeType: string): LoadedClass<INodeType | IVersionedNodeType>;
    getCredential(credentialType: string): LoadedClass<ICredentialType>;
    reset(): void;
    releaseTypes(): void;
    ensureTypesLoaded(): Promise<void>;
    resolveSourcePath(sourcePath: string): string;
}
export type LoadingDetails = { className: string; sourcePath: string; };
export type CredentialLoadingDetails = LoadingDetails & { supportedNodes?: string[]; extends?: string[]; };
export type KnownNodesAndCredentials = {
    nodes: Record<string, NodeLoadingDetails>;
    credentials: Record<string, CredentialLoadingDetails>;
};

// n8n-core/dist/nodes-loader/*.d.ts
export declare abstract class DirectoryLoader implements NodeLoader {
    readonly directory: string;
    isLazyLoaded: boolean;
    loadedNodes: INodeTypeNameVersion[];
    nodeTypes: INodeTypeData;
    credentialTypes: ICredentialTypeData;
    known: KnownNodesAndCredentials;
    types: Types;
    readonly nodesByCredential: Record<string, string[]>;
    constructor(directory: string, excludeNodes?: string[], includeNodes?: string[]);
    abstract packageName: string;
    abstract loadAll(): Promise<void>;
    loadNodeFromFile(filePath: string, packageVersion?: string): void;
    getNode(nodeType: string): LoadedClass<INodeType | IVersionedNodeType>;
    loadCredentialFromFile(filePath: string): void;
    getCredential(credentialType: string): LoadedClass<ICredentialType>;
    getCredentialsForNode(object: IVersionedNodeType | INodeType): INodeCredentialDescription[];
    getVersionedNodeTypeAll(object: IVersionedNodeType | INodeType): INodeType[];
    static applyDeclarativeNodeOptionParameters(nodeType: INodeType): void;
    // …
}
export declare class PackageDirectoryLoader extends DirectoryLoader { packageJson: n8n.PackageJson; packageName: string; loadAll(): Promise<void>; }
export declare class LazyPackageDirectoryLoader extends PackageDirectoryLoader { loadAll(): Promise<void>; }
export declare class CustomDirectoryLoader extends DirectoryLoader { packageName: string; loadAll(): Promise<void>; }
export declare function scanDirectoryForPackages(nodeModulesDir: string, options?: { excludeNodes?: string[]; includeNodes?: string[]; }): Promise<NodeLoader[]>;
```

What each one does (from the dist JS):

* **`PackageDirectoryLoader.loadAll()`** reads `package.json`. For every path in `n8n.nodes` it calls `loadNodeFromFile` (instantiates the class, adds codex,
  fixes icon paths, records `__loadOptionsMethods`, injects polling/CORS/declarative params, runs `validateNodeDescription`, and pushes **every version's
  description** into `types.nodes`). It does the same for credentials, then `inferSupportedNodes()`.
* **`LazyPackageDirectoryLoader.loadAll()`** tries to read four prebuilt JSON files instead of importing any code:
  ```js
  this.known.nodes       = await this.readJSON('dist/known/nodes.json');
  this.known.credentials = await this.readJSON('dist/known/credentials.json');
  this.types.nodes       = await this.readJSON('dist/types/nodes.json');
  this.types.credentials = await this.readJSON('dist/types/credentials.json');
  ```
  It applies include/exclude filters and sets `isLazyLoaded = true`. If anything fails it falls back to the eager `super.loadAll()`.
  The node class is `require`d only on first `getNode(type)` (via `known.nodes[type].sourcePath`).
* **`CustomDirectoryLoader`** globs `**/*.node.js` and `**/*.credentials.js` under a directory. Package name is `CUSTOM`, and
  every node gets the "Custom Nodes" codex category.
* **`scanDirectoryForPackages(dir)`** globs `n8n-nodes-*` and `@*/n8n-nodes-*` (depth 1/2) and builds a `LazyPackageDirectoryLoader` for each,
  skipping packages that fail the nodes-API-version check.

### 11.3 The lazy-loading manifests

Generated at **build time** by the `n8n-generate-metadata` bin of `n8n-core` (it runs `PackageDirectoryLoader` once and dumps):

| File | Content | Example (n8n-nodes-base 2.44.4) |
|---|---|---|
| `dist/known/nodes.json` | `{ [unprefixedName]: { className, sourcePath } }` | 445 entries. `"set": { "className": "Set", "sourcePath": "dist/nodes/Set/Set.node.js" }` |
| `dist/known/credentials.json` | `{ [name]: { className, sourcePath, extends?, supportedNodes? } }` | 411 entries. `"githubOAuth2Api": { …, "extends": ["oAuth2Api"], "supportedNodes": ["github","githubTrigger"] }` |
| `dist/types/nodes.json` | `INodeTypeDescription[]`: **one entry per version implementation**, JSON-serialized (functions dropped or nulled, `__loadOptionsMethods` stripped) | 504 entries, 8.8 MB |
| `dist/types/credentials.json` | `ICredentialType[]` (function `authenticate` becomes `{}`) | 411 entries |
| `dist/methods/defined.json`, `referenced.json` | loadOptions methods each node defines or references (lint aid) | |

A second generator, `n8n-generate-node-defs`, uses `@n8n/workflow-sdk` to emit `dist/node-definitions/nodes/<pkg>/<node>/v*.ts` plus
`*.schema.js`: per-version TypeScript types and zod schemas of node parameters, used by n8n's AI workflow builder and the SDK. Nodes can also ship
**output JSON Schemas** in `__schema__/v<semver>/<resource>/<operation>.json` (resolved by `resolveOutputSchemaPath`).

### 11.4 Startup sequence (`n8n/dist/load-nodes-and-credentials.js`)

1. `loadNodesFromNodeModules(<n8n>/.. and <n8n>/node_modules, 'n8n-nodes-base')`, then the same for `@n8n/n8n-nodes-langchain`, both with `LazyPackageDirectoryLoader`.
2. `loadNodesFromCustomDirectories()`: `CustomDirectoryLoader` over `~/.n8n/custom` (`instanceSettings.customExtensionDir`) plus every
   path in env `N8N_CUSTOM_EXTENSIONS` (`;`-separated).
3. `moduleRegistry.nodeLoaders`: backend modules can contribute **any object implementing `NodeLoader`**, so a loader doesn't have to be filesystem-based.
   Installed community packages are loaded by the community-packages module from `~/.n8n/nodes/node_modules/<pkg>` (`nodesDownloadDir`).
4. `postProcessLoaders()` → `rebuildRegistry()`:
   * prefixes names: `types.nodes[].name = `${packageName}.${name}``, `known.nodes['<pkg>.<name>']`, `supportedNodes` likewise;
   * injects credential domain-restriction fields;
   * `createAiTools()`: for every `usableAsTool` node, adds a `<name>Tool` clone (`outputs: ['ai_tool']`);
   * `createHitlTools()` (human-in-the-loop tool variants);
   * applies `NODES_EXCLUDE` / `NODES_INCLUDE` (env, JSON arrays of full type names);
   * `injectCustomApiCallOptions()` adds a "Custom API Call" operation to nodes whose credential supports generic auth;
   * runs post-processors.
5. `FrontendService.generateTypes()` writes the merged `types/nodes.json`, `types/node-versions.json` and `types/credentials.json` into `staticCacheDir`.
   They're served to the editor at `GET /types/nodes.json` (auth-protected). Icons are served at `/icons/{@scope/}<package>/<path>.svg|png`.
6. Runtime type lookup: `getNode('n8n-nodes-base.set')` splits at the **first `.`** into package + node, then `loaders[pkg].getNode('set')`, which `require`s the file lazily.
7. Dev hot reload: `@parcel/watcher` on loader dirs (or `POST /rest/dev/reload`) triggers `loader.reset(); loadAll(); postProcessLoaders()` and a push of
   `nodeDescriptionUpdated` to the UI.

UI-time REST endpoints that call into node code:
`POST /rest/node-types` (full descriptions by name/version),
`POST /rest/dynamic-node-parameters/options` (`loadOptions`),
`…/resource-locator-results` (`listSearch`), `…/resource-mapper-fields` (`resourceMapping`),
`…/local-resource-mapper-fields` (`localResourceMapping`), `…/action-result` (`actionHandler`).

### 11.5 Community node installation (`modules/community-packages/community-packages.service.js`)

* Validates the name (`n8n-nodes-` prefix, scope pattern, not reserved). Checks npm status. If a checksum is given, `verifyIntegrity` against the registry.
* `downloadPackage`: `npm pack <pkg>@<ver>` into `~/.n8n/nodes`, untar to `~/.n8n/nodes/node_modules/<pkg>`, **strip dev/peer/optional deps** from its
  package.json, then `npm install --ignore-scripts=true --install-strategy=shallow --package-lock=false`, and record the dependency in `~/.n8n/nodes/package.json`.
* `loadNodesAndCredentials.loadPackage(pkg)` uses an eager `PackageDirectoryLoader`. Installed packages and nodes are persisted in the DB
  (TypeORM entities `InstalledPackages`, `InstalledNodes`). `N8N_REINSTALL_MISSING_PACKAGES` reinstalls them on boot.
* Config env: `N8N_COMMUNITY_PACKAGES_ENABLED`, `N8N_COMMUNITY_PACKAGES_REGISTRY` (custom registry is a licensed feature),
  `N8N_UNVERIFIED_PACKAGES_ENABLED`, `N8N_VERIFIED_PACKAGES_ENABLED`, `N8N_COMMUNITY_PACKAGES_PREVENT_LOADING`, `N8N_COMMUNITY_PACKAGES_AUTH_TOKEN`.
  The "verified" catalog is fetched from n8n's API with `aiNodeSdkVersion = 1` and `nodesApiVersion` as compatibility filters.
* **Everything runs in-process**: community node code runs in the n8n main/worker process with full Node.js access.

---

## 12. New packages

### `@n8n/ai-node-sdk` (0.34.4, "Preview")

"Public SDK for building AI nodes in n8n … creating chat model and memory nodes **without LangChain dependencies**." Community packages declare
it as a `peerDependency` next to `n8n-workflow`. It re-exports from `@n8n/ai-utilities`:

```ts
export { BaseChatModel } from '@n8n/ai-utilities';
export type { ChatModel, ChatModelConfig } from '@n8n/ai-utilities';
export { BaseChatHistory, BaseChatMemory, WindowedChatMemory, type WindowedChatMemoryConfig } from '@n8n/ai-utilities';
export { supplyMemory, type SupplyMemoryOptions } from '@n8n/ai-utilities';
export { supplyModel, type SupplyModelOptions, type OpenAiModel } from '@n8n/ai-utilities';
export type { Message, MessageContent, MessageRole, Tool, ToolCall, ToolResult, GenerateResult, StreamChunk, TokenUsage, FinishReason, ... } from '@n8n/ai-utilities';
export { parseSSEStream, getParametersJsonSchema } from '@n8n/ai-utilities';
```

Pattern: a normal `INodeType` with `inputs: []`, `outputs: [NodeConnectionTypes.AiLanguageModel]`, and
`supplyData()` returns `supplyModel(this, { type: 'openai', baseUrl, apiKey, model, temperature })` (OpenAI-compatible shortcut) or
`supplyModel(this, new MyChatModel(...))` where `MyChatModel extends BaseChatModel` and implements `generate(messages)` / `stream(messages)`.
Memory nodes return `supplyMemory(this, new WindowedChatMemory(new MyHistory(...)))`. Purpose: a **stable, framework-neutral AI provider
interface** (messages, tool calls, streaming) so community AI nodes don't bind to n8n's LangChain internals. The community-packages config
carries `aiNodeSdkVersion = 1` as a compatibility level.

### `@n8n/node-engine-compatibility` (0.12.4)

"Adapts v1 nodes and workflows to the **Engine v2** execution model." n8n is building a new, durable, step-based engine (`@n8n/engine`,
"workflow execution engine (v2)", modes `N8N_ENGINE_MODE=in-process|remote` with a control plane and a data plane over HTTP).
In Engine v2 a workflow is a plain graph:

```ts
// @n8n/engine
export type StepType = 'trigger' | 'v1-node' | 'wait' | 'subworkflow' | 'batch';
export interface GraphNode { id: string; name: string; type: StepType; config?: StepConfig; }
export interface GraphEdge { from: string; to: string; outputIndex: number; inputIndex: number; isBackEdge?: boolean; }
export interface WorkflowGraph { nodes: GraphNode[]; edges: GraphEdge[]; }
export type StepSlots = JsonValue[];                    // JSON-only I/O per step
export interface StepExecutionRequest { node: GraphNode; inputs: StepSlots; context: StepExecutionContext; respond: ResponseEmitter; }
export type StepExecutionResult = { outputs: StepSlots; wait?: never } | { wait: WaitDeclaration; outputs?: never };
export interface IStepExecutor { execute(request: StepExecutionRequest): Promise<StepExecutionResult>; }
export type WaitDeclaration = { resumeAt: string; outputsAtDeadline: StepSlots; acceptsResumeRequest: boolean; /* … */ };
```

The compat package provides `V1WorkflowConverter` (classic `IWorkflowBase` JSON to `WorkflowGraph`), `V1StepExecutor implements IStepExecutor`
(runs a classic `INodeType.execute` for a step by rebuilding a v1 `ExecuteContext`), `fromStepInputs/toStepOutputs`
(`StepSlots` to and from `INodeExecutionData[][]`), and `toV1RunExecutionData`. The direction n8n is heading in is a **JSON-in/JSON-out step executor
interface** with existing nodes wrapped as `'v1-node'` steps.

### `@n8n/workflow-sdk` (0.37.2)

"TypeScript SDK for programmatically creating n8n workflows": a fluent `WorkflowBuilder().addTrigger(manual()).then(httpRequest({...}))`,
JSON↔code generation, validation, and the `generate-types` used to build per-node typed definitions from `types/nodes.json`. It is
for **authoring workflows**, not nodes. The node-description field `builderHint` feeds it.

---

## 13. Real examples

### 13.1 Edit Fields (Set) v3.x: description head (trimmed from `SetV2.node.js`)

```js
const versionDescription = {
    displayName: 'Edit Fields (Set)',
    name: 'set',
    iconColor: 'blue',
    group: ['input'],
    version: [3, 3.1, 3.2, 3.3, 3.4, 3.5],
    description: 'Modify, add, or remove item fields',
    subtitle: '={{$parameter["mode"]}}',
    defaults: { name: 'Edit Fields' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    properties: [
        {
            displayName: 'Mode', name: 'mode', type: 'options', noDataExpression: true,
            options: [
                { name: 'Manual Mapping', value: 'manual', description: 'Edit item fields one by one', action: 'Edit item fields one by one' },
                { name: 'JSON', value: 'raw', description: 'Customize item output with JSON', action: 'Customize item output with JSON' },
            ],
            default: 'manual',
        },
        { displayName: 'Duplicate Item', name: 'duplicateItem', type: 'boolean', default: false, isNodeSetting: true },
        {
            displayName: 'Duplicate Item Count', name: 'duplicateCount', type: 'number', default: 0,
            typeOptions: { minValue: 0 }, isNodeSetting: true,
            displayOptions: { show: { duplicateItem: [true] } },
        },
        // manual mode (v3.3+):
        { displayName: 'Fields to Set', name: 'assignments', type: 'assignmentCollection', default: {},
          displayOptions: { show: { mode: ['manual'] }, hide: { '@version': [3, 3.1, 3.2] } } },
        {
            displayName: 'Include Other Input Fields', name: 'includeOtherFields', type: 'boolean', default: false,
            displayOptions: { hide: { '@version': [3, 3.1, 3.2] } },
        },
        {
            displayName: 'Fields to Include', name: 'includeFields', type: 'string', default: '',
            requiresDataPath: 'multiple',
            displayOptions: { show: { include: ['selected'], '/includeOtherFields': [true] }, hide: { '@version': [3, 3.1, 3.2] } },
        },
        {
            displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add option', default: {},
            options: [
                { displayName: 'Include Binary File', name: 'includeBinary', type: 'boolean', default: true,
                  displayOptions: { hide: { '@version': [{ _cnd: { gte: 3.4 } }] } } },
                // …
            ],
        },
    ],
};

class SetV2 {
    constructor(baseDescription) { this.description = { ...baseDescription, ...versionDescription }; }
    async execute() {
        const items = this.getInputData();
        const mode = this.getNodeParameter('mode', 0);
        const returnData = [];
        for (let i = 0; i < items.length; i++) {
            const options = this.getNodeParameter('options', i, {});
            const node = this.getNode();
            if (node.typeVersion >= 3.3) { /* version-specific behaviour */ }
            const newItem = await setNode[mode].execute.call(this, items[i], i, options, rawData, node);
            returnData.push(newItem);
        }
        return [returnData];
    }
}
```

Codex `Set.node.json`:

```json
{ "node": "n8n-nodes-base.set", "nodeVersion": "1.0", "codexVersion": "1.0",
  "categories": ["Core Nodes"],
  "subcategories": { "Core Nodes": ["Data Transformation"] },
  "alias": ["Set", "JS", "JSON", "Filter", "Transform", "Map"],
  "resources": { "primaryDocumentation": [{ "url": "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.set/" }] } }
```

### 13.2 HTTP Request: versioned base and V3 head

```js
class HttpRequest extends VersionedNodeType {
    constructor() {
        const baseDescription = {
            displayName: 'HTTP Request', name: 'httpRequest', icon: 'node:http-request', iconColor: 'blue',
            group: ['output'], subtitle: '={{$parameter["requestMethod"] + ": " + $parameter["url"]}}',
            description: 'Makes an HTTP request and returns the response data',
            defaultVersion: 4.5,
            builderHint: { searchHint: 'Prefer dedicated integration nodes over HTTP Request — …' },
        };
        const nodeVersions = { 1: new HttpRequestV1(baseDescription), 2: new HttpRequestV2(baseDescription),
            3: new HttpRequestV3(baseDescription), 4: …, 4.1: …, 4.2: …, 4.3: …, 4.4: …, 4.5: new HttpRequestV3(baseDescription) };
        super(nodeVersions, baseDescription);
    }
}
// HttpRequestV3
this.description = {
    ...baseDescription,
    subtitle: '={{$parameter["method"] + ": " + $parameter["url"]}}',
    version: [3, 4, 4.1, 4.2, 4.3, 4.4, 4.5],
    defaults: { name: 'HTTP Request', color: '#0004F5' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'httpSslAuth', required: true, displayOptions: { show: { provideSslCertificates: [true] } } }],
    usableAsTool: { replacements: { codex: { subcategories: { Tools: ['Recommended Tools'] } } } },
    properties: mainProperties,   // includes curlImport, credentialsSelect (credentialTypes: ['extends:oAuth2Api','extends:oAuth1Api','has:authenticate']), …
};
```

### 13.3 Resource locator with `listSearch` (GitHub `owner`)

```js
{
    displayName: 'Repository Owner', name: 'owner', type: 'resourceLocator',
    default: { mode: 'list', value: '' }, required: true,
    modes: [
        { displayName: 'Repository Owner', name: 'list', type: 'list', placeholder: 'Select an owner...',
          typeOptions: { searchListMethod: 'getUsers', searchable: true, searchFilterRequired: true } },
        { displayName: 'Link', name: 'url', type: 'string', placeholder: 'e.g. https://github.com/n8n-io',
          extractValue: { type: 'regex', regex: 'https:\\/\\/(?:[^/]+)\\/([-_0-9a-zA-Z]+)' },
          validation: [{ type: 'regex', properties: { regex: 'https:\\/\\/([^/]+)\\/([-_0-9a-zA-Z]+)(?:.*)', errorMessage: 'Not a valid Github URL' } }] },
        { displayName: 'By Name', name: 'name', type: 'string', placeholder: 'e.g. n8n-io',
          url: '=https://github.com/{{$value}}' },
    ],
    displayOptions: { hide: { operation: ['invite', 'getUserIssues'] } },
}
// node class: methods = { listSearch: { getUsers, getRepositories, getWorkflows, getRefs } }
```

### 13.4 Webhook trigger lifecycle (GitHub Trigger)

```js
webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
// …
webhookMethods = {
    default: {
        async checkExists() { const data = this.getWorkflowStaticData('node'); /* GET /repos/:o/:r/hooks/:id */ },
        async create()      { const url = this.getNodeWebhookUrl('default'); /* POST hook, store id+secret in static data */ },
        async delete()      { /* DELETE hook, clear static data */ },
    },
};
async webhook() { /* verify signature, return { workflowData: [this.helpers.returnJsonArray(body)] } */ }
```

---

## 14. Implications for Landflow

### 14.1 What to copy (proven, and worth mirroring nearly 1:1)

1. **Descriptor/implementation split.** A node is a static, data-only `description` plus a few optional handlers. The UI renders entirely
   from descriptors and calls back to the host for dynamic bits. This is exactly what lets plugins live out of process.
2. **Field names** (adopt verbatim so n8n knowledge, docs and even importers carry over):
   `name`, `displayName`, `description`, `icon`/`iconUrl`, `group`, `version` (number | number[]), `defaultVersion`, `subtitle`, `defaults.name`,
   `inputs`, `outputs`, `inputNames`/`outputNames`, `credentials[{name, required, displayOptions, testedBy}]`, `properties`,
   `polling`, `webhooks[{name, httpMethod, path, responseMode, isFullPath}]`, `triggerPanel`, `codex{categories, subcategories, alias}`,
   `usableAsTool`, `hints`, `maxNodes`, `hidden`/`deprecated`.
   Property level: `displayName`, `name`, `type`, `default`, `required`, `description`, `hint`, `placeholder`, `options`, `typeOptions`,
   `displayOptions{show, hide}` with `@version` and `_cnd`, `noDataExpression`, `isNodeSetting`, `modes` (resourceLocator), `routing`.
3. **Property type vocabulary**: start with `string | number | boolean | options | multiOptions | collection | fixedCollection | json | dateTime |
   color | hidden | notice | resourceLocator | resourceMapper | filter | assignmentCollection | credentialsSelect | button`. That covers almost every
   n8n node. The stored value shapes (`{__rl, mode, value}`, `FilterValue`, `AssignmentCollectionValue`, `ResourceMapperValue`) are worth copying exactly.
4. **Item model**: `{ json, binary?, pairedItem?, error? }` and `outputs[][]` (array per output port). Lineage (`pairedItem`) is what makes
   "drag field from an earlier node" and `$('Node').item` work. Design it in from day 1.
5. **Per-instance `typeVersion` pinning** plus light versioning via `@version` display conditions. Workflows store
   `{ type: "<pkg>.<name>", typeVersion }`, and the host resolves `(type, version) → handler`.
6. **Credentials as their own typed plugins** with a property schema, a **declarative `authenticate`** (`{type:'generic', properties:{headers|qs|body|auth}}`
   with `{{$credentials.x}}` templates), a **declarative `test`** request plus rules, `extends` for OAuth2/OAuth1 bases, and the host handling OAuth flows and
   token refresh. Secrets never leave the host except when injected into a request. With remote plugins this is the big win: the host can
   perform authenticated HTTP *on behalf of* the plugin, or pass decrypted creds only for that call.
7. **Two-file manifest idea** (`known` = cheap index `name → where to load`, `types` = full descriptors). This maps cleanly to remote discovery:
   `GET /manifest` returns `{ nodes: Descriptor[], credentials: CredentialDescriptor[] }`, cached by the host and keyed by plugin version/ETag.
8. **Package-level compatibility level** (`n8nNodesApiVersion`): every Landflow plugin manifest should declare `landflowApiVersion: "1.0"`. The host
   skips or warns on newer majors, the same way `checkNodesApiVersion` does.
9. **Engine v2 direction**: n8n itself is moving toward `IStepExecutor.execute({ node, inputs: JsonValue[], context }) → { outputs } | { wait }`,
   which is JSON-only, step-addressable and durable. That shape is a good gRPC/HTTP `Execute` RPC for Landflow plugins.

### 14.2 What to simplify or avoid

| n8n trait | Problem for a polyglot, out-of-process design | Landflow alternative |
|---|---|---|
| Dynamic `inputs`/`outputs` as **stringified JS functions** in `={{ … }}` | Non-TS plugins can't author them, and the host must run arbitrary JS from plugins | Declarative rules: `outputs: { from: "parameter", path: "rules.values", item: { type: "main", displayName: "{{outputKey}}" }, append: [...] }`, **or** a `resolveIO(parameters)` RPC on the plugin (cached, debounced) |
| Functions inside descriptors (`preSend`, `postReceive`, pagination fn, `extractValue` fn, validation fn) silently become `null` in JSON | Descriptor isn't truly data | Rule: **descriptors must be 100% JSON**. Anything dynamic is a *named* RPC method (`methods.<kind>.<name>`), the same way n8n already does `loadOptionsMethod: 'getUsers'`. |
| `this`-bound context with 100+ helpers (binary FS, SSH tunnels, data tables, deduplication…) | Can't expose over the wire, and huge SDK surface per language | Small explicit request object: `{ items, parameters (already resolved per item), credentials?, node{name,typeVersion}, workflow{id}, execution{id,mode}, staticData }`, plus a **host callback channel** for `httpRequest(withAuth)`, `binary.put/get`, `log`, `emit`, `setStaticData` |
| Parameters resolved lazily in-process (`getNodeParameter(name, i)` evaluates expressions on demand) | Expression engine would have to live in every SDK | Host resolves expressions **before** the call and sends `parameters[itemIndex]` (or resolved-once for non-item params). Offer `rawExpressions` opt-in per property if needed. |
| `supplyData` returns live JS objects (LangChain models) | Not serializable | Model AI capabilities as **typed RPC contracts** (`ChatModel.generate/stream`, `Memory.load/save`, `Tool.call`). That is the direction `@n8n/ai-node-sdk` is taking (framework-neutral `BaseChatModel`, `ChatMemory`). |
| 24 property types, open-ended `typeOptions: {[k:string]: any}`, many `__private` fields | Hard to validate cross-language | Publish a **JSON Schema** for the descriptor and validate on registration. Close `typeOptions` per type. |
| `name` unprefixed in class, prefixed at load (`pkg.name`), and split at the first `.` | Ambiguity with dotted package names | Use a fully-qualified id from the start: `"<pluginId>/<nodeName>"` or `"<pluginId>:<nodeName>"`, and keep `name` local |
| Codex in a separate `*.node.json`, icons via file paths rewritten to `/icons/<pkg>/…` | Filesystem coupling | Inline `codex` in the descriptor. Icons as `iconUrl` (absolute URL on the plugin server or data URI) or a built-in icon ref. |
| Loading = `require()` in a `vm` context with host `require` (no isolation). Community nodes run in-process. | Security, plus crashes take down the host | Out-of-process plugins by design (HTTP/gRPC), optionally sandboxed in-proc TS plugins later |
| Full `VersionedNodeType` (one entry per implementation, sharing `name`) | Fine conceptually | Keep: descriptor list may contain multiple entries with the same `name` and disjoint `version` arrays, plus a top-level `defaultVersion` |

### 14.3 Minimal language-neutral descriptor (proposal)

Everything below is plain JSON, so any SDK (Go, Python, Rust…) can emit it from `GET /landflow/manifest` or a gRPC `Describe()`:

```jsonc
{
  "landflowApiVersion": "1.0",
  "plugin": { "id": "acme-crm", "version": "1.4.2", "displayName": "Acme CRM", "homepage": "…" },
  "nodes": [
    {
      "name": "contact",                       // local; FQ id = "acme-crm/contact"
      "displayName": "Acme Contact",
      "description": "Create and fetch Acme contacts",
      "icon": { "url": "https://plugin.host/icons/contact.svg" },   // or { "builtin": "user" }
      "group": ["transform"],                  // + "trigger" for triggers
      "version": [1, 1.1],
      "defaultVersion": 1.1,
      "kind": "action",                        // action | trigger.poll | trigger.webhook | trigger.stream | subnode
      "inputs":  [{ "type": "main" }],
      "outputs": [{ "type": "main", "displayName": "Success" }, { "type": "main", "displayName": "Error", "category": "error" }],
      "dynamicIO": null,                       // or { "method": "resolveOutputs", "dependsOn": ["rules"] }
      "credentials": [{ "name": "acmeApi", "required": true, "displayOptions": { "show": { "auth": ["apiKey"] } } }],
      "codex": { "categories": ["Sales"], "alias": ["crm", "contact"] },
      "usableAsTool": true,
      "polling": null,                         // { "defaultInterval": "5m" } when kind = trigger.poll
      "webhooks": null,                        // [{ "name": "default", "httpMethod": "POST", "path": "acme", "responseMode": "onReceived" }]
      "properties": [
        { "name": "operation", "displayName": "Operation", "type": "options", "noDataExpression": true, "default": "get",
          "options": [ { "name": "Get", "value": "get", "action": "Get a contact" }, { "name": "Create", "value": "create" } ] },
        { "name": "contactId", "displayName": "Contact", "type": "resourceLocator", "required": true,
          "default": { "__rl": true, "mode": "list", "value": "" },
          "modes": [
            { "name": "list", "displayName": "From list", "type": "list", "typeOptions": { "searchListMethod": "searchContacts", "searchable": true } },
            { "name": "id", "displayName": "By ID", "type": "string",
              "validation": [{ "type": "regex", "properties": { "regex": "^[0-9]+$", "errorMessage": "Numeric id" } }] }
          ],
          "displayOptions": { "show": { "operation": ["get"], "@version": [{ "_cnd": { "gte": 1.1 } }] } } },
        { "name": "fields", "displayName": "Fields", "type": "collection", "default": {},
          "options": [ { "name": "email", "displayName": "Email", "type": "string", "default": "" } ] }
      ],
      "methods": {                              // names only: callable via RPC, never code
        "loadOptions": ["getTags"],
        "listSearch": ["searchContacts"],
        "resourceMapping": [],
        "credentialTest": [],
        "actionHandler": []
      },
      "outputSchema": { "type": "object", "properties": { "id": { "type": "string" } } }   // optional, per op
    }
  ],
  "credentials": [
    {
      "name": "acmeApi", "displayName": "Acme API",
      "extends": [],                            // e.g. ["oAuth2Api"]
      "properties": [ { "name": "apiKey", "displayName": "API Key", "type": "string", "typeOptions": { "password": true }, "default": "" } ],
      "authenticate": { "type": "generic", "properties": { "headers": { "Authorization": "=Bearer {{$credentials.apiKey}}" } } },
      "test": { "request": { "baseURL": "https://api.acme.com", "url": "/me" } }
    }
  ]
}
```

RPC surface a plugin implements (HTTP or gRPC, mirroring n8n's method families):

| RPC | n8n analogue | Payload (all JSON) |
|---|---|---|
| `Describe()` | `types/nodes.json` + `types/credentials.json` | → manifest above (cache by `plugin.version`/ETag) |
| `Execute(node, typeVersion, items[], parameters[], credentials?, context)` | `execute` / `RoutingNode` | → `{ outputs: Item[][] , hints?, wait? }` (`Item = {json, binary?: {ref,…}, pairedItem?, error?}`) |
| `Poll(node, typeVersion, parameters, cursor)` | `poll` + static data | → `{ items: Item[][] \| null, cursor }` |
| `Webhook(node, request{method,headers,query,body}, parameters, staticData)` | `webhook` | → `{ workflowData?, response? }` |
| `WebhookLifecycle(node, op: checkExists\|create\|delete, webhookUrl, parameters, staticData)` | `webhookMethods` | → `{ ok, staticData }` |
| `Trigger.Start/Stop` (server-streaming `emit`) | `trigger` + `emit` / `closeFunction` | stream of `Item[][]` |
| `LoadOptions(method, currentParameters, credentials?)` | `methods.loadOptions` | → `[{name, value, description?}]` |
| `ListSearch(method, filter?, paginationToken?, …)` | `methods.listSearch` | → `{ results, paginationToken? }` |
| `ResourceMapping(method, …)` | `methods.resourceMapping` | → `{ fields: ResourceMapperField[] }` |
| `ResolveIO(parameters)` (optional) | expression-based `inputs`/`outputs` | → `{ inputs, outputs }` |
| `CredentialTest(name, data)` (optional; prefer declarative `test`) | `methods.credentialTest` | → `{ status: 'OK'\|'Error', message }` |
| Host callbacks: `HttpRequest(withCredential?)`, `Binary.Put/Get`, `Log` | `this.helpers.*` | keep tiny and versioned |

**Discovery**: the host keeps a registry of plugin endpoints (static config, DNS-SD/mDNS, or a `/.well-known/landflow-plugin` URL). On (re)connect it
calls `Describe()`, validates against the descriptor JSON Schema, checks `landflowApiVersion`, prefixes ids with `plugin.id`, and rebuilds the
merged catalog (the equivalent of `rebuildRegistry()` + `FrontendService.generateTypes()`). Then it serves one merged `/api/node-types` to the Next.js
editor and pushes a `nodeDescriptionUpdated` event on change (n8n's hot-reload signal). Resolution at runtime is
`(fqType, typeVersion) → plugin endpoint + local name + version entry`. Lazy loading in n8n terms is free here, because the manifest *is* the index and code is only
reached through `Execute`.

**Keep host-side (never per-plugin):** the expression engine, displayOptions evaluation, default/required validation, retry/continueOnFail/
alwaysOutputData/executeOnce/onError node settings, OAuth flows and token refresh, credential encryption, declarative `routing` execution
(a host-side "RoutingNode" lets simple REST plugins ship **zero code**, just a manifest), `usableAsTool` → AI-tool wrapping, binary storage.
