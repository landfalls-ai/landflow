package landflow

import (
	"encoding/json"
	"fmt"
	"io/fs"
)

// Wire types for the landflow.plugin/v1 protocol. They mirror
// packages/protocol/src/types.ts field for field and marshal to the same
// camelCase JSON. Optional fields carry `omitempty`; fields whose zero value is
// meaningful (minValue: 0, default: false, ...) are pointers or `any`.

// ProtocolVersion is the protocol identifier carried by manifests and requests.
const ProtocolVersion = "landflow.plugin/v1"

// SDK identity reported in every manifest.
const (
	SDKName    = "landflow-sdk-go"
	SDKVersion = "0.2.0"
)

// HTTP binding paths (HTTP_PATHS in types.ts).
const (
	PathWellKnown       = "/.well-known/landflow"
	PathManifest        = "/landflow/v1/manifest"
	PathExecute         = "/landflow/v1/execute"
	PathLoadOptions     = "/landflow/v1/load-options"
	PathTestCredentials = "/landflow/v1/test-credentials"
	PathHealth          = "/landflow/v1/health"
	// App webhook triggers (TriggerAppWebhook, docs/protocol.md §12).
	PathWebhookMethod = "/landflow/v1/webhook-method"
	PathWebhook       = "/landflow/v1/webhook"
	// PathMetrics serves Prometheus text (LANDFLOW_METRICS_PROMETHEUS); see docs/observability.md.
	PathMetrics = "/metrics"
	// PathMCP is the Streamable HTTP MCP face on the HTTP port (docs/protocol.md §15.2; mcpface.DefaultPath).
	PathMCP = "/mcp"
)

// Registry defaults.
const (
	DefaultAnnounceTTLSeconds = 30
	DefaultHeartbeatSeconds   = 10
	DefaultRegistryURL        = "http://127.0.0.1:3000"
	AnnouncePath              = "/api/plugins/announce"
)

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

// ConnectionType is the kind of edge a port accepts.
type ConnectionType string

const (
	ConnectionMain          ConnectionType = "main"
	ConnectionLanguageModel ConnectionType = "ai_languageModel"
	ConnectionTool          ConnectionType = "ai_tool"
	ConnectionMemory        ConnectionType = "ai_memory"
)

// PortDescriptor describes one input or output handle of a node.
type PortDescriptor struct {
	Type           ConnectionType `json:"type"`
	DisplayName    string         `json:"displayName,omitempty"`
	Required       bool           `json:"required,omitempty"`
	MaxConnections int            `json:"maxConnections,omitempty"`
}

// MainPort is a convenience for the common `{ "type": "main" }` port.
func MainPort() PortDescriptor { return PortDescriptor{Type: ConnectionMain} }

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// PropertyType selects the editor widget for a parameter.
type PropertyType string

const (
	PropString          PropertyType = "string"
	PropNumber          PropertyType = "number"
	PropBoolean         PropertyType = "boolean"
	PropOptions         PropertyType = "options"
	PropMultiOptions    PropertyType = "multiOptions"
	PropJSON            PropertyType = "json"
	PropCode            PropertyType = "code"
	PropCollection      PropertyType = "collection"
	PropFixedCollection PropertyType = "fixedCollection"
	PropColor           PropertyType = "color"
	PropDateTime        PropertyType = "dateTime"
	PropNotice          PropertyType = "notice"
	PropHidden          PropertyType = "hidden"
)

// PropertyOption is one choice of an options / multiOptions property.
// Value must be a string, number or bool.
type PropertyOption struct {
	Name        string `json:"name"`
	Value       any    `json:"value"`
	Description string `json:"description,omitempty"`
	Action      string `json:"action,omitempty"`
	Idempotent  bool   `json:"idempotent,omitempty"` // safe to repeat: overrides the node's Idempotent (brokers, MCP idempotentHint)
	// On an option of the `operation` property only (docs/protocol.md §15.1): MCP false keeps the operation out of
	// the plugin's MCP tools (landflow.Ptr(false)); OutputSchema and ToolAnnotations override the node's for its tool.
	MCP             *bool               `json:"mcp,omitempty"`
	OutputSchema    map[string]any      `json:"outputSchema,omitempty"`
	ToolAnnotations *McpToolAnnotations `json:"toolAnnotations,omitempty"`
}

// McpToolAnnotations are the MCP hints of a tool; the mapping derives them (docs/protocol.md §15.1) and a node or an
// operation option overrides the ones it sets (nil = derived).
type McpToolAnnotations struct {
	Title           string `json:"title,omitempty"`
	ReadOnlyHint    *bool  `json:"readOnlyHint,omitempty"`
	DestructiveHint *bool  `json:"destructiveHint,omitempty"`
	IdempotentHint  *bool  `json:"idempotentHint,omitempty"`
	OpenWorldHint   *bool  `json:"openWorldHint,omitempty"`
}

// DisplayOptions is n8n-style conditional visibility. Values are primitives.
type DisplayOptions struct {
	Show map[string][]any `json:"show,omitempty"`
	Hide map[string][]any `json:"hide,omitempty"`
}

// TypeOptions (PropertyTypeOptions in types.ts) tweaks how a property is rendered.
type TypeOptions struct {
	Rows                 *int     `json:"rows,omitempty"`
	Password             bool     `json:"password,omitempty"`
	Language             string   `json:"language,omitempty"` // javascript | json | python | sql | text | markdown
	MinValue             *float64 `json:"minValue,omitempty"`
	MaxValue             *float64 `json:"maxValue,omitempty"`
	NumberPrecision      *int     `json:"numberPrecision,omitempty"`
	MultipleValues       bool     `json:"multipleValues,omitempty"`
	LoadOptionsMethod    string   `json:"loadOptionsMethod,omitempty"`
	LoadOptionsDependsOn []string `json:"loadOptionsDependsOn,omitempty"`
}

// FixedCollectionGroup is a named group of sub-fields of a fixedCollection.
type FixedCollectionGroup struct {
	Name        string               `json:"name"`
	DisplayName string               `json:"displayName"`
	Values      []PropertyDescriptor `json:"values"`
}

// PropertyDescriptor is one field of a node's parameter form.
type PropertyDescriptor struct {
	Name             string                 `json:"name"`
	DisplayName      string                 `json:"displayName"`
	Type             PropertyType           `json:"type"`
	Default          any                    `json:"default,omitempty"` // omitted only when nil
	Description      string                 `json:"description,omitempty"`
	Placeholder      string                 `json:"placeholder,omitempty"`
	Hint             string                 `json:"hint,omitempty"`
	Required         bool                   `json:"required,omitempty"`
	NoDataExpression bool                   `json:"noDataExpression,omitempty"`
	Options          []PropertyOption       `json:"options,omitempty"`
	Values           []PropertyDescriptor   `json:"values,omitempty"`
	Groups           []FixedCollectionGroup `json:"groups,omitempty"`
	TypeOptions      *TypeOptions           `json:"typeOptions,omitempty"`
	DisplayOptions   *DisplayOptions        `json:"displayOptions,omitempty"`
}

// ---------------------------------------------------------------------------
// Node descriptor
// ---------------------------------------------------------------------------

// NodeKind is trigger | action | subnode.
type NodeKind string

const (
	KindTrigger NodeKind = "trigger"
	KindAction  NodeKind = "action"
	KindSubnode NodeKind = "subnode"
)

// TriggerSource tells the host how to wire up a trigger node.
type TriggerSource string

const (
	TriggerManual   TriggerSource = "manual"
	TriggerWebhook  TriggerSource = "webhook"
	TriggerSchedule TriggerSource = "schedule"
	TriggerChat     TriggerSource = "chat"
	// TriggerPoll: the host calls Execute with mode "poll" every pollInterval
	// seconds while the workflow is active (see PollIntervalProperty and
	// ExecuteContext.PollState).
	TriggerPoll TriggerSource = "poll"
	// TriggerAppWebhook: the node registers its own webhook at an external
	// service when the workflow is published (implement WebhookNode).
	TriggerAppWebhook TriggerSource = "appWebhook"
)

// Version is the set of supported type versions. It marshals as a bare number
// when it holds one version (`"version": 1`) and as an array otherwise.
type Version []int

// V builds a Version: V(1) or V(1, 2).
func V(versions ...int) Version { return Version(versions) }

// MarshalJSON implements json.Marshaler.
func (v Version) MarshalJSON() ([]byte, error) {
	if len(v) == 1 {
		return json.Marshal(v[0])
	}
	return json.Marshal([]int(v))
}

// UnmarshalJSON accepts either a number or an array of numbers.
func (v *Version) UnmarshalJSON(data []byte) error {
	var single int
	if err := json.Unmarshal(data, &single); err == nil {
		*v = Version{single}
		return nil
	}
	var many []int
	if err := json.Unmarshal(data, &many); err != nil {
		return fmt.Errorf("version must be a number or an array of numbers: %w", err)
	}
	*v = Version(many)
	return nil
}

// NodeDescriptor describes a node type (a subset of n8n's INodeTypeDescription).
type NodeDescriptor struct {
	Name            string               `json:"name"`
	DisplayName     string               `json:"displayName"`
	Description     string               `json:"description"`
	Version         Version              `json:"version"`
	DefaultVersion  int                  `json:"defaultVersion,omitempty"`
	Kind            NodeKind             `json:"kind"`
	TriggerSource   TriggerSource        `json:"triggerSource,omitempty"`
	Idempotent      bool                 `json:"idempotent,omitempty"` // safe to run twice: at-least-once delivery over brokers (docs/transports.md)
	Categories      []string             `json:"categories,omitempty"`
	Icon            string               `json:"icon,omitempty"`
	Color           string               `json:"color,omitempty"`
	Subtitle        string               `json:"subtitle,omitempty"`
	Inputs          []PortDescriptor     `json:"inputs"`
	Outputs         []PortDescriptor     `json:"outputs"`
	Properties      []PropertyDescriptor `json:"properties"`
	UsableAsTool    bool                 `json:"usableAsTool,omitempty"`
	ToolDescription string               `json:"toolDescription,omitempty"`
	// ToolInputSchema is an optional JSON Schema for the tool's arguments.
	// Without it the host derives one from the primitive properties. The
	// arguments become the input item's JSON and override same-named parameters.
	ToolInputSchema map[string]any `json:"toolInputSchema,omitempty"`
	// MCP false (landflow.Ptr(false)) keeps the whole node out of the plugin's MCP tools; OutputSchema (the schema of
	// one output item's json) gives its tools an outputSchema; ToolAnnotations override the derived hints.
	MCP              *bool               `json:"mcp,omitempty"`
	OutputSchema     map[string]any      `json:"outputSchema,omitempty"`
	ToolAnnotations  *McpToolAnnotations `json:"toolAnnotations,omitempty"`
	Supplies         ConnectionType      `json:"supplies,omitempty"`
	DocumentationURL string              `json:"documentationUrl,omitempty"`
	Keywords         []string            `json:"keywords,omitempty"`
	// Credentials lists the credential types (declared in PluginInfo.CredentialTypes)
	// this node can use.
	Credentials []NodeCredentialRequirement `json:"credentials,omitempty"`
}

// NodeCredentialRequirement names a credential type a node can use, by the
// local name of a credential type its plugin declares.
type NodeCredentialRequirement struct {
	Name     string `json:"name"`
	Required bool   `json:"required,omitempty"`
	// DisplayOptions asks for the credential only when the parameters match
	// (e.g. one credential per authentication method).
	DisplayOptions *DisplayOptions `json:"displayOptions,omitempty"`
}

// CredentialTypeDescriptor is the wire form of a credential type in
// PluginManifest.credentialTypes. Plugins declare CredentialType values
// instead; NewPlugin derives the descriptor (Testable is set when Test is).
type CredentialTypeDescriptor struct {
	Name             string               `json:"name"`
	DisplayName      string               `json:"displayName"`
	Description      string               `json:"description,omitempty"`
	Icon             string               `json:"icon,omitempty"`
	DocumentationURL string               `json:"documentationUrl,omitempty"`
	Properties       []PropertyDescriptor `json:"properties"`
	Testable         bool                 `json:"testable,omitempty"`
	// Extends names the credential types this one builds on ("oAuth2Api"):
	// the host merges their properties in and gives OAuth2 types a Connect
	// button (docs/protocol.md §7).
	Extends []string `json:"extends,omitempty"`
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

// SDKInfo identifies the SDK that built a manifest.
type SDKInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// PluginInfo identifies a plugin. NewPlugin fills Language and SDK.
type PluginInfo struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description,omitempty"`
	Language    string   `json:"language"`
	SDK         *SDKInfo `json:"sdk,omitempty"`
	// Icon: "lucide:<name>" | "emoji:<char>" | https/data URL | "file:<path in IconFS>".
	Icon string `json:"icon,omitempty"`
	// Color is the brand colour (hex, e.g. "#0d9488").
	Color    string `json:"color,omitempty"`
	Author   string `json:"author,omitempty"`
	Homepage string `json:"homepage,omitempty"`
	// IconFS resolves "file:" icons of the plugin and its nodes, typically an
	// embed.FS. NewPlugin inlines them as data: URLs and clears this field.
	IconFS fs.FS `json:"-"`
	// CredentialTypes are the kinds of secrets the plugin's nodes use. NewPlugin
	// moves them into the manifest's credentialTypes and clears this field.
	CredentialTypes []CredentialType `json:"-"`
}

// PluginManifest is served at GET /landflow/v1/manifest.
type PluginManifest struct {
	Protocol        string                     `json:"protocol"`
	Plugin          PluginInfo                 `json:"plugin"`
	Nodes           []NodeDescriptor           `json:"nodes"`
	CredentialTypes []CredentialTypeDescriptor `json:"credentialTypes,omitempty"`
	// Transports lists the binding kinds the plugin was started with
	// ("http", "grpc", broker kinds, "mcp"); MaxConcurrency is the calls one
	// instance takes at once (0/absent = unlimited). Hints for the host's
	// transport selector (docs/transports.md); set by Serve.
	Transports     []string `json:"transports,omitempty"`
	MaxConcurrency int      `json:"maxConcurrency,omitempty"`
}

// WellKnownPlugin is the subset of PluginInfo in the well-known document.
type WellKnownPlugin struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Version  string `json:"version"`
	Language string `json:"language"`
}

// WellKnownEndpoints lists the HTTP binding paths.
type WellKnownEndpoints struct {
	Manifest        string `json:"manifest"`
	Execute         string `json:"execute"`
	LoadOptions     string `json:"loadOptions"`
	Health          string `json:"health"`
	TestCredentials string `json:"testCredentials,omitempty"`
	// WebhookMethod and Webhook are listed when a node is an app webhook trigger.
	WebhookMethod string `json:"webhookMethod,omitempty"`
	Webhook       string `json:"webhook,omitempty"`
	// MCP is the Streamable HTTP MCP endpoint ("/mcp") when the face is on (docs/protocol.md §15.2).
	MCP string `json:"mcp,omitempty"`
}

// WellKnownDocument is served at GET /.well-known/landflow.
type WellKnownDocument struct {
	Protocol  string             `json:"protocol"`
	Plugin    WellKnownPlugin    `json:"plugin"`
	Endpoints WellKnownEndpoints `json:"endpoints"`
}

// ---------------------------------------------------------------------------
// Items & execution
// ---------------------------------------------------------------------------

// PairedItem links an output item to the input item it came from.
type PairedItem struct {
	Item  int `json:"item"`
	Input int `json:"input,omitempty"`
}

// Item is the unit of data flowing between nodes (n8n's INodeExecutionData).
type Item struct {
	JSON map[string]any `json:"json"`
	// Binary holds files by property name ("data" for a single file); see
	// binary.go and docs/protocol.md §11.
	Binary     map[string]BinaryRef `json:"binary,omitempty"`
	PairedItem *PairedItem          `json:"pairedItem,omitempty"`
}

// ExecutionMode is why the node is running.
type ExecutionMode string

const (
	ModeManual  ExecutionMode = "manual"
	ModeTrigger ExecutionMode = "trigger"
	ModeWebhook ExecutionMode = "webhook"
	ModeTool    ExecutionMode = "tool"
	ModeChat    ExecutionMode = "chat"
	// ModePoll is a scheduled poll of a TriggerPoll node.
	ModePoll ExecutionMode = "poll"
	// ModeMCP: started by an MCP client (the plugin's own /mcp face or the host's MCP server).
	ModeMCP ExecutionMode = "mcp"
)

// NodeRef identifies the workflow node being executed. Type is fully
// qualified ("go-crypto.hash").
type NodeRef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	TypeVersion int    `json:"typeVersion"`
}

// ExecuteRequest is the body of POST /landflow/v1/execute.
type ExecuteRequest struct {
	Protocol       string           `json:"protocol"`
	ExecutionID    string           `json:"executionId"`
	WorkflowID     string           `json:"workflowId,omitempty"`
	Mode           ExecutionMode    `json:"mode"`
	Node           NodeRef          `json:"node"`
	Parameters     map[string]any   `json:"parameters"`
	ItemParameters []map[string]any `json:"itemParameters"`
	Inputs         [][]Item         `json:"inputs"`
	// Credentials holds decrypted credential data keyed by credential type
	// local name: {"telegramApi": {"accessToken": "…"}}.
	Credentials map[string]any `json:"credentials,omitempty"`
	// PollState is the state the previous poll returned (poll triggers; nil
	// on the first poll).
	PollState map[string]any `json:"pollState,omitempty"`
	// ContinueOnFail is set when the node continues on error: emit
	// {"error": message} for a failing item instead of failing the call.
	ContinueOnFail bool `json:"continueOnFail,omitempty"`
	// IdempotencyKey is "<executionId>:<nodeId>:<runIndex>": the same for
	// every retry of this step (retry on fail, re-run after a host crash).
	// Empty from older hosts.
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	// BinaryAccess is where the node reads and writes the bytes of item files
	// during this call (nil when the host has no binary store).
	BinaryAccess *BinaryAccess `json:"binaryAccess,omitempty"`
}

// LogLevel is debug | info | warn | error.
type LogLevel string

const (
	LevelDebug LogLevel = "debug"
	LevelInfo  LogLevel = "info"
	LevelWarn  LogLevel = "warn"
	LevelError LogLevel = "error"
)

// LogEntry is one line in ExecuteResponse.logs.
type LogEntry struct {
	Level   LogLevel `json:"level"`
	Message string   `json:"message"`
}

// NodeErrorPayload is the wire form of a node failure.
type NodeErrorPayload struct {
	Message     string `json:"message"`
	Description string `json:"description,omitempty"`
	ItemIndex   *int   `json:"itemIndex,omitempty"`
}

// ExecuteResponse is the result of an execution. A node failure is reported
// in Error with HTTP 200.
type ExecuteResponse struct {
	Outputs [][]Item          `json:"outputs"`
	Logs    []LogEntry        `json:"logs,omitempty"`
	Error   *NodeErrorPayload `json:"error,omitempty"`
	// PollState is the state for the next poll (poll triggers, mode "poll" only).
	PollState map[string]any `json:"pollState,omitempty"`
}

// LoadOptionsRequest is the body of POST /landflow/v1/load-options.
type LoadOptionsRequest struct {
	NodeType   string         `json:"nodeType"`
	Method     string         `json:"method"`
	Parameters map[string]any `json:"parameters"`
	// Credentials has the same shape as ExecuteRequest.Credentials.
	Credentials map[string]any `json:"credentials,omitempty"`
}

// TestCredentialsRequest is the body of POST /landflow/v1/test-credentials.
type TestCredentialsRequest struct {
	// CredentialType is the local credential type name.
	CredentialType string         `json:"credentialType"`
	Data           map[string]any `json:"data"`
}

// TestCredentialsResponse reports whether the credential values work.
type TestCredentialsResponse struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

// LoadOptionsResponse carries the resolved dropdown choices.
type LoadOptionsResponse struct {
	Options []PropertyOption `json:"options"`
}

// HealthResponse is served at GET /landflow/v1/health.
type HealthResponse struct {
	Status   string `json:"status"` // ok | degraded
	UptimeMs int64  `json:"uptimeMs"`
	PluginID string `json:"pluginId"`
	Version  string `json:"version"`
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// AnnounceRequest registers (or renews) an endpoint with the host registry.
type AnnounceRequest struct {
	Protocol   string `json:"protocol"`
	Endpoint   string `json:"endpoint"`
	PluginID   string `json:"pluginId"`
	Version    string `json:"version"`
	TTLSeconds int    `json:"ttlSeconds,omitempty"`
	// InstanceID identifies the plugin process (random, see InstanceID): a new one tells the host to pull the
	// manifest again, even when the version is the same. Older SDKs leave it out.
	InstanceID string `json:"instanceId,omitempty"`
	// Transports and MaxConcurrency mirror the manifest hints (docs/transports.md), so the host's
	// selector knows them without a manifest pull. Older hosts ignore them.
	Transports     []string `json:"transports,omitempty"`
	MaxConcurrency int      `json:"maxConcurrency,omitempty"`
}

// AnnounceResponse is the registry's reply.
type AnnounceResponse struct {
	Accepted                 bool   `json:"accepted"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
	Message                  string `json:"message,omitempty"`
}

// WithdrawRequest removes an endpoint from the registry.
type WithdrawRequest struct {
	Endpoint string `json:"endpoint"`
	PluginID string `json:"pluginId,omitempty"`
}

// Ptr returns a pointer to v; handy for optional descriptor fields such as
// TypeOptions.MinValue: landflow.Ptr(1.0).
func Ptr[T any](v T) *T { return &v }

// PropertyTypeOptions is the types.ts name of TypeOptions.
type PropertyTypeOptions = TypeOptions
