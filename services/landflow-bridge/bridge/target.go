package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
	"github.com/landflow/landflow/sdks/go/transport"
)

// Target is the plugin behind the bridge, reached over gRPC or HTTP. Call forwards one logical RPC: body is the
// method's request JSON exactly as the HTTP binding would receive it (the brokered body, docs/protocol.md §14.3) and
// the result is the response JSON. A failure that is not a node error comes back as a *transport.DispatchError with
// the lferror code the host acts on (not_found, bad_request, capacity, unavailable, internal; expired and cancelled
// when ctx ended).
type Target interface {
	// URL is the configured address (for logs and health).
	URL() string
	// Manifest fetches the plugin's manifest as JSON (GetManifest / GET /landflow/v1/manifest).
	Manifest(ctx context.Context) (json.RawMessage, error)
	// Call forwards method with body; deadline (zero = none) travels as the gRPC deadline or x-landflow-deadline.
	Call(ctx context.Context, method transport.Method, body json.RawMessage, deadline time.Time) (json.RawMessage, error)
	Close() error
}

// NewTarget builds a Target for grpc://host:port or http(s)://host:port.
func NewTarget(raw string) (Target, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, ErrNoTarget
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("bridge: target %q must be grpc://host:port or http://host:port", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "grpc", "grpcs":
		return newGRPCTarget(u)
	case "http", "https":
		return newHTTPTarget(u)
	default:
		return nil, fmt.Errorf("bridge: target %q: unsupported scheme %q (grpc, http)", raw, u.Scheme)
	}
}

// manifestDoc is the manifest as the bridge serves it over the broker: the plugin's own document (nodes and
// credential types kept verbatim) in the field order the SDKs write, so the hash matches what a host re-serialises.
type manifestDoc struct {
	Protocol        string              `json:"protocol"`
	Plugin          landflow.PluginInfo `json:"plugin"`
	Transports      []string            `json:"transports,omitempty"`
	MaxConcurrency  int                 `json:"maxConcurrency,omitempty"`
	CredentialTypes []json.RawMessage   `json:"credentialTypes,omitempty"`
	Nodes           []json.RawMessage   `json:"nodes"`
}

// ManifestInfo is what the bridge reads out of the manifest.
type ManifestInfo struct {
	PluginID       string
	Version        string
	MaxConcurrency int
	Transports     []string
}

// decodeManifestInfo reads the fields the bridge needs. The plugin id is required.
func decodeManifestInfo(raw json.RawMessage) (ManifestInfo, error) {
	var doc struct {
		Protocol string `json:"protocol"`
		Plugin   struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"plugin"`
		Transports     []string `json:"transports"`
		MaxConcurrency int      `json:"maxConcurrency"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ManifestInfo{}, fmt.Errorf("bridge: manifest is not JSON: %w", err)
	}
	if doc.Plugin.ID == "" {
		return ManifestInfo{}, errors.New("bridge: manifest has no plugin.id")
	}
	if doc.Protocol != "" && doc.Protocol != transport.ProtocolVersion {
		return ManifestInfo{}, fmt.Errorf("bridge: manifest protocol %q is not %s", doc.Protocol, transport.ProtocolVersion)
	}
	return ManifestInfo{PluginID: doc.Plugin.ID, Version: doc.Plugin.Version, MaxConcurrency: doc.MaxConcurrency, Transports: doc.Transports}, nil
}

// withTransports returns the manifest with the bridged kinds added to its transports hint (the faces this plugin is
// reachable through now include the bridge's brokers), key order preserved.
func withTransports(raw json.RawMessage, kinds []string) (json.RawMessage, error) {
	var ordered orderedObject
	if err := json.Unmarshal(raw, &ordered); err != nil {
		return nil, err
	}
	var current []string
	if v, ok := ordered.get("transports"); ok {
		_ = json.Unmarshal(v, &current)
	}
	seen := map[string]bool{}
	merged := make([]string, 0, len(current)+len(kinds))
	for _, k := range append(append([]string{}, current...), kinds...) {
		if k != "" && !seen[k] {
			seen[k] = true
			merged = append(merged, k)
		}
	}
	value, err := json.Marshal(merged)
	if err != nil {
		return nil, err
	}
	ordered.set("transports", value)
	return json.Marshal(ordered)
}

// orderedObject keeps a JSON object's key order through a decode/encode round trip.
type orderedObject struct {
	keys   []string
	values map[string]json.RawMessage
}

func (o *orderedObject) get(key string) (json.RawMessage, bool) {
	v, ok := o.values[key]
	return v, ok
}

func (o *orderedObject) set(key string, value json.RawMessage) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *orderedObject) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return errors.New("manifest is not a JSON object")
	}
	o.values = map[string]json.RawMessage{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		key := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return err
		}
		o.set(key, value)
	}
	_, err = dec.Token()
	return err
}

func (o orderedObject) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		key, _ := json.Marshal(k)
		b.Write(key)
		b.WriteByte(':')
		b.Write(o.values[k])
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// retryAfterKey is the DispatchError detail carrying the plugin's Retry-After (a time.Duration) on a capacity refusal.
const retryAfterKey = "retryAfter"

// dispatchErr builds the coded error the core turns into lferror.
func dispatchErr(code transport.RemoteErrorCode, format string, args ...any) *transport.DispatchError {
	return &transport.DispatchError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// ctxErr maps a finished context onto expired / cancelled; nil when ctx is live.
func ctxErr(ctx context.Context) error {
	switch {
	case ctx.Err() == nil:
		return nil
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return dispatchErr(transport.CodeExpired, "deadline exceeded before the plugin answered")
	default:
		return dispatchErr(transport.CodeCancelled, "cancelled before the plugin answered")
	}
}

// decodeInto parses a brokered request body into the SDK's request struct (bad_request when it does not fit).
func decodeInto(body json.RawMessage, dst any) error {
	if len(body) == 0 {
		return dispatchErr(transport.CodeBadRequest, "request body is empty")
	}
	if err := json.Unmarshal(body, dst); err != nil {
		return dispatchErr(transport.CodeBadRequest, "malformed request body: %v", err)
	}
	return nil
}
