package transport

// The Landflow messaging envelope: a CloudEvents 1.0 event (docs/transports.md
// "One envelope", docs/protocol.md §14.3). Byte-compatible with
// packages/transports/src/envelope.ts.
//
// Every brokered request, reply, cancel, announce and withdraw is one event.
// Binary mode (the broker has headers): attributes are headers under their
// bare names, the body is the bytes. Structured mode: one JSON document
// {specversion, id, …, data} (or data_base64 for an encrypted body) with
// content-type application/cloudevents+json. DecodeWire tells them apart by the
// presence of specversion in the headers. The body is the HTTP binding's JSON
// for the method (ExecuteRequest → ExecuteResponse, …).

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	CESpecVersion         = "1.0"
	CETypePrefix          = "dev.landflow.plugin.v1."
	StructuredContentType = "application/cloudevents+json; charset=utf-8"
	JSONContentType       = "application/json"
	EncryptedContentType  = "application/octet-stream"
	// EncAESGCM is the only lfenc value this version knows.
	EncAESGCM = "aes-256-gcm"
)

// Method is one of the logical RPC methods, named as in docs/protocol.md.
type Method string

const (
	MethodGetManifest     Method = "GetManifest"
	MethodExecute         Method = "Execute"
	MethodLoadOptions     Method = "LoadOptions"
	MethodTestCredentials Method = "TestCredentials"
	MethodHealth          Method = "Health"
	MethodWebhookMethod   Method = "WebhookMethod"
	MethodReceiveWebhook  Method = "ReceiveWebhook"
)

// Methods lists every Method.
var Methods = []Method{MethodGetManifest, MethodExecute, MethodLoadOptions, MethodTestCredentials, MethodHealth, MethodWebhookMethod, MethodReceiveWebhook}

var methodSegments = map[Method]string{
	MethodGetManifest:     "getmanifest",
	MethodExecute:         "execute",
	MethodLoadOptions:     "loadoptions",
	MethodTestCredentials: "testcredentials",
	MethodHealth:          "health",
	MethodWebhookMethod:   "webhookmethod",
	MethodReceiveWebhook:  "receivewebhook",
}

var methodsBySegment = func() map[string]Method {
	m := make(map[string]Method, len(methodSegments))
	for method, segment := range methodSegments {
		m[segment] = method
	}
	return m
}()

// MethodSegment is the lower-case CloudEvents type segment of a method.
func MethodSegment(method Method) string { return methodSegments[method] }

// RequestType is the CloudEvents type of a method's request.
func RequestType(method Method) string { return CETypePrefix + methodSegments[method] + ".request" }

// ResponseType is the CloudEvents type of a method's response.
func ResponseType(method Method) string { return CETypePrefix + methodSegments[method] + ".response" }

const (
	CancelType   = CETypePrefix + "cancel"
	AnnounceType = CETypePrefix + "announce"
	WithdrawType = CETypePrefix + "withdraw"
)

// TypeKind is what a CloudEvents type means.
type TypeKind string

const (
	KindRequest  TypeKind = "request"
	KindResponse TypeKind = "response"
	KindCancel   TypeKind = "cancel"
	KindAnnounce TypeKind = "announce"
	KindWithdraw TypeKind = "withdraw"
)

// ParsedType is the meaning of a type; Method is set for requests and responses.
type ParsedType struct {
	Kind   TypeKind
	Method Method
}

// ParseType reads a type; ok is false for a type this version does not know.
func ParseType(typ string) (ParsedType, bool) {
	if !strings.HasPrefix(typ, CETypePrefix) {
		return ParsedType{}, false
	}
	rest := typ[len(CETypePrefix):]
	switch rest {
	case "cancel":
		return ParsedType{Kind: KindCancel}, true
	case "announce":
		return ParsedType{Kind: KindAnnounce}, true
	case "withdraw":
		return ParsedType{Kind: KindWithdraw}, true
	}
	dot := strings.LastIndexByte(rest, '.')
	if dot < 0 {
		return ParsedType{}, false
	}
	method, ok := methodsBySegment[rest[:dot]]
	if !ok {
		return ParsedType{}, false
	}
	switch rest[dot+1:] {
	case "request":
		return ParsedType{Kind: KindRequest, Method: method}, true
	case "response":
		return ParsedType{Kind: KindResponse, Method: method}, true
	}
	return ParsedType{}, false
}

// LfExtensions are the Landflow extensions. lfsig is computed over all the
// others, so it is listed but never part of the canonical form.
var LfExtensions = []string{"lfreplyto", "lfcorrelation", "lfdeadline", "lfattempt", "lfidempotency", "lfdelivery", "lfmanifest", "lferror", "lfenc", "lfkeyid", "lfsig"}

// KnownAttributes are the attribute names the envelope knows, in canonical
// order; anything else in the headers is ignored on decode (never signed,
// never trusted).
var KnownAttributes = append([]string{"specversion", "id", "source", "type", "subject", "time", "datacontenttype", "traceparent", "tracestate"}, LfExtensions...)

var knownAttributeSet = func() map[string]bool {
	m := make(map[string]bool, len(KnownAttributes))
	for _, name := range KnownAttributes {
		m[name] = true
	}
	return m
}()

// DeliveryMode is the delivery the sender asks for (lfdelivery).
type DeliveryMode string

const (
	AtMostOnce  DeliveryMode = "at-most-once"
	AtLeastOnce DeliveryMode = "at-least-once"
)

// RemoteErrorCode is an error code a plugin puts in lferror on a response; the
// client maps them to RemoteError.
type RemoteErrorCode string

const (
	CodeManifestMismatch RemoteErrorCode = "manifest_mismatch"
	CodeExpired          RemoteErrorCode = "expired"
	CodeBadRequest       RemoteErrorCode = "bad_request"
	CodeNotFound         RemoteErrorCode = "not_found"
	CodeInternal         RemoteErrorCode = "internal"
	CodeCancelled        RemoteErrorCode = "cancelled"
	CodeUnavailable      RemoteErrorCode = "unavailable"
	CodeTooLarge         RemoteErrorCode = "too_large"
	// CodeCapacity: the plugin refused the call at once because it is at its
	// concurrency limit with a full queue; it never ran (docs/transports.md
	// "capacity"). Not in the TS enum yet; a TS client surfaces it as a
	// RemoteError with this code.
	CodeCapacity RemoteErrorCode = "capacity"
)

// Attributes are the decoded attributes of an event. All values are strings on
// the wire; LfDeadline and LfAttempt are numeric strings. Empty means absent.
type Attributes struct {
	SpecVersion     string
	ID              string
	Source          string
	Type            string
	Subject         string
	Time            string
	DataContentType string
	TraceParent     string
	TraceState      string
	LfReplyTo       string
	LfCorrelation   string
	LfDeadline      string
	LfAttempt       string
	LfIdempotency   string
	LfDelivery      DeliveryMode
	LfManifest      string
	LfError         RemoteErrorCode
	LfEnc           string
	LfKeyID         string
	LfSig           string
}

// Get returns an attribute by its wire name ("" when absent or unknown).
func (a *Attributes) Get(name string) string {
	switch name {
	case "specversion":
		return a.SpecVersion
	case "id":
		return a.ID
	case "source":
		return a.Source
	case "type":
		return a.Type
	case "subject":
		return a.Subject
	case "time":
		return a.Time
	case "datacontenttype":
		return a.DataContentType
	case "traceparent":
		return a.TraceParent
	case "tracestate":
		return a.TraceState
	case "lfreplyto":
		return a.LfReplyTo
	case "lfcorrelation":
		return a.LfCorrelation
	case "lfdeadline":
		return a.LfDeadline
	case "lfattempt":
		return a.LfAttempt
	case "lfidempotency":
		return a.LfIdempotency
	case "lfdelivery":
		return string(a.LfDelivery)
	case "lfmanifest":
		return a.LfManifest
	case "lferror":
		return string(a.LfError)
	case "lfenc":
		return a.LfEnc
	case "lfkeyid":
		return a.LfKeyID
	case "lfsig":
		return a.LfSig
	}
	return ""
}

// Set sets an attribute by its wire name; unknown names are ignored.
func (a *Attributes) Set(name, value string) {
	switch name {
	case "specversion":
		a.SpecVersion = value
	case "id":
		a.ID = value
	case "source":
		a.Source = value
	case "type":
		a.Type = value
	case "subject":
		a.Subject = value
	case "time":
		a.Time = value
	case "datacontenttype":
		a.DataContentType = value
	case "traceparent":
		a.TraceParent = value
	case "tracestate":
		a.TraceState = value
	case "lfreplyto":
		a.LfReplyTo = value
	case "lfcorrelation":
		a.LfCorrelation = value
	case "lfdeadline":
		a.LfDeadline = value
	case "lfattempt":
		a.LfAttempt = value
	case "lfidempotency":
		a.LfIdempotency = value
	case "lfdelivery":
		a.LfDelivery = DeliveryMode(value)
	case "lfmanifest":
		a.LfManifest = value
	case "lferror":
		a.LfError = RemoteErrorCode(value)
	case "lfenc":
		a.LfEnc = value
	case "lfkeyid":
		a.LfKeyID = value
	case "lfsig":
		a.LfSig = value
	}
}

// Deadline is lfdeadline as a time (zero when absent or malformed).
func (a *Attributes) Deadline() time.Time {
	if a.LfDeadline == "" {
		return time.Time{}
	}
	var ms int64
	for _, c := range a.LfDeadline {
		if c < '0' || c > '9' {
			return time.Time{}
		}
		ms = ms*10 + int64(c-'0')
	}
	return time.UnixMilli(ms)
}

// Headers returns the attributes as wire headers (strings), without empty values.
func (a *Attributes) Headers() map[string]string {
	headers := make(map[string]string, len(KnownAttributes))
	for _, name := range KnownAttributes {
		if value := a.Get(name); value != "" {
			headers[name] = value
		}
	}
	return headers
}

// RawEvent is an event with its body still as bytes: what the security layer
// signs, verifies, encrypts and decrypts.
type RawEvent struct {
	Attributes Attributes
	Body       []byte
}

// WireSize is the size accounting of an encoded event, so the core can refuse
// what a broker cannot carry before publishing.
type WireSize struct {
	HeaderBytes int
	BodyBytes   int
	TotalBytes  int
}

// EnvelopeReason says why an EnvelopeError happened.
type EnvelopeReason string

const (
	ReasonMalformed   EnvelopeReason = "malformed"
	ReasonUnsupported EnvelopeReason = "unsupported"
	ReasonTooLarge    EnvelopeReason = "too_large"
)

// EnvelopeError: the event cannot be encoded or decoded. The core drops such
// events and counts them.
type EnvelopeError struct {
	Reason  EnvelopeReason
	Message string
}

func (e *EnvelopeError) Error() string { return e.Message }

func envelopeErr(reason EnvelopeReason, format string, args ...any) *EnvelopeError {
	return &EnvelopeError{Reason: reason, Message: fmt.Sprintf(format, args...)}
}

var (
	idRE          = regexp.MustCompile(`^[\x21-\x7e]{1,128}$`)
	sourceRE      = regexp.MustCompile(`^landflow://(host/[A-Za-z0-9._-]{1,128}|plugin/[A-Za-z0-9._-]{1,128}/[A-Za-z0-9._-]{1,128})$`)
	typeRE        = regexp.MustCompile(`^dev\.landflow\.plugin\.v1\.[a-z]+(\.(request|response))?$`)
	digitsRE      = regexp.MustCompile(`^\d{1,16}$`)
	timeRE        = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$`)
	subjectRE     = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
	traceparentRE = regexp.MustCompile(`^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$`)
	replyToRE     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,256}$`)
	attemptRE     = regexp.MustCompile(`^\d{1,6}$`)
	idempotencyRE = regexp.MustCompile(`^[\x21-\x7e]{1,256}$`)
	manifestRE    = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
	keyIDRE       = regexp.MustCompile(`^[0-9a-f]{8,32}$`)
	sigRE         = regexp.MustCompile(`^[0-9a-f]{64}$`)
	errorCodeRE   = regexp.MustCompile(`^[a-z_]{1,32}$`)
	pluginSrcRE   = regexp.MustCompile(`^landflow://plugin/([^/]+)/([^/]+)$`)
)

// printable reports whether s is printable single-line ASCII (0x20–0x7e), so
// it survives any broker's header encoding untouched.
func printable(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// HostSource is the source of a host process.
func HostSource(instanceID string) string { return "landflow://host/" + instanceID }

// PluginSource is the source of a plugin process.
func PluginSource(pluginID, instanceID string) string {
	return "landflow://plugin/" + pluginID + "/" + instanceID
}

// ParsePluginSource reads pluginID and instanceID of a landflow://plugin/… source; ok is false for a host source.
func ParsePluginSource(source string) (pluginID, instanceID string, ok bool) {
	m := pluginSrcRE.FindStringSubmatch(source)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// ValidateOptions tunes ValidateAttributes and DecodeWire.
type ValidateOptions struct {
	// Strict refuses unknown attributes instead of dropping them (for tests).
	Strict bool
}

// ValidateAttributes is the strict attribute validation: every required
// attribute present and well-formed, every known optional one well-formed,
// values printable ASCII. Unknown attributes are dropped.
func ValidateAttributes(input map[string]string, opts ValidateOptions) (Attributes, error) {
	bad := func(name, why string) error { return envelopeErr(ReasonMalformed, "attribute %q %s", name, why) }
	str := func(name string, required bool, re *regexp.Regexp, max int) (string, error) {
		value, present := input[name]
		if !present || value == "" {
			if required {
				return "", bad(name, "is required")
			}
			return "", nil
		}
		if len(value) > max || !printable(value) || (re != nil && !re.MatchString(value)) {
			return "", bad(name, "is malformed")
		}
		return value, nil
	}
	if opts.Strict {
		for name := range input {
			if !knownAttributeSet[name] {
				return Attributes{}, bad(name, "is not a known attribute")
			}
		}
	}
	var out Attributes
	var err error
	if out.SpecVersion, err = str("specversion", true, nil, 4096); err != nil {
		return Attributes{}, err
	}
	if out.SpecVersion != CESpecVersion {
		return Attributes{}, envelopeErr(ReasonUnsupported, "specversion %q is not supported", out.SpecVersion)
	}
	if out.Type, err = str("type", true, typeRE, 4096); err != nil {
		return Attributes{}, err
	}
	if _, ok := ParseType(out.Type); !ok {
		return Attributes{}, envelopeErr(ReasonUnsupported, "type %q is not supported", out.Type)
	}
	if out.DataContentType, err = str("datacontenttype", true, nil, 4096); err != nil {
		return Attributes{}, err
	}
	if out.DataContentType != JSONContentType && out.DataContentType != EncryptedContentType {
		return Attributes{}, envelopeErr(ReasonUnsupported, "datacontenttype %q is not supported", out.DataContentType)
	}
	delivery, err := str("lfdelivery", false, nil, 4096)
	if err != nil {
		return Attributes{}, err
	}
	if delivery != "" && delivery != string(AtMostOnce) && delivery != string(AtLeastOnce) {
		return Attributes{}, bad("lfdelivery", "is malformed")
	}
	enc, err := str("lfenc", false, nil, 4096)
	if err != nil {
		return Attributes{}, err
	}
	if enc != "" && enc != EncAESGCM {
		return Attributes{}, envelopeErr(ReasonUnsupported, "lfenc %q is not supported", enc)
	}
	if (enc != "") != (out.DataContentType == EncryptedContentType) {
		return Attributes{}, bad("lfenc", "does not match datacontenttype")
	}
	code, err := str("lferror", false, errorCodeRE, 4096)
	if err != nil {
		return Attributes{}, err
	}
	required := []struct {
		name string
		re   *regexp.Regexp
	}{{"id", idRE}, {"source", sourceRE}, {"time", timeRE}}
	for _, r := range required {
		value, err := str(r.name, true, r.re, 4096)
		if err != nil {
			return Attributes{}, err
		}
		out.Set(r.name, value)
	}
	optional := []struct {
		name string
		re   *regexp.Regexp
		max  int
	}{
		{"subject", subjectRE, 4096},
		{"traceparent", traceparentRE, 4096},
		{"tracestate", nil, 1024},
		{"lfreplyto", replyToRE, 4096},
		{"lfcorrelation", idRE, 4096},
		{"lfdeadline", digitsRE, 4096},
		{"lfattempt", attemptRE, 4096},
		{"lfidempotency", idempotencyRE, 4096},
		{"lfmanifest", manifestRE, 4096},
		{"lfkeyid", keyIDRE, 4096},
		{"lfsig", sigRE, 4096},
	}
	for _, o := range optional {
		value, err := str(o.name, false, o.re, o.max)
		if err != nil {
			return Attributes{}, err
		}
		out.Set(o.name, value)
	}
	out.LfDelivery = DeliveryMode(delivery)
	out.LfEnc = enc
	out.LfError = RemoteErrorCode(code)
	return out, nil
}

// WireMode is the CloudEvents mode: binary (headers) or structured (one JSON document).
type WireMode string

const (
	ModeBinary     WireMode = "binary"
	ModeStructured WireMode = "structured"
)

// EncodeWire encodes a raw event (attributes + body bytes, already
// encrypted/signed) for the wire.
func EncodeWire(event RawEvent, mode WireMode) (WireEvent, WireSize, error) {
	headers := event.Attributes.Headers()
	if mode == ModeBinary {
		headers["content-type"] = event.Attributes.DataContentType
		wire := WireEvent{Headers: headers, Body: event.Body}
		return wire, SizeOf(wire), nil
	}
	var doc bytes.Buffer
	doc.WriteByte('{')
	for _, name := range KnownAttributes {
		value := event.Attributes.Get(name)
		if value == "" {
			continue
		}
		doc.WriteString(`"` + name + `":`)
		doc.Write(marshalJSString(value))
		doc.WriteByte(',')
	}
	if event.Attributes.LfEnc != "" {
		doc.WriteString(`"data_base64":"`)
		doc.WriteString(base64.StdEncoding.EncodeToString(event.Body))
		doc.WriteString(`"}`)
	} else if len(event.Body) == 0 {
		doc.WriteString(`"data":null}`)
	} else {
		if !json.Valid(event.Body) {
			return WireEvent{}, WireSize{}, envelopeErr(ReasonMalformed, "plain body is not valid JSON")
		}
		var compact bytes.Buffer
		_ = json.Compact(&compact, event.Body)
		doc.WriteString(`"data":`)
		doc.Write(compact.Bytes())
		doc.WriteByte('}')
	}
	wire := WireEvent{Headers: map[string]string{"content-type": StructuredContentType}, Body: doc.Bytes()}
	return wire, SizeOf(wire), nil
}

// SizeOf counts headers + body bytes of a wire event (header names and values as UTF-8).
func SizeOf(wire WireEvent) WireSize {
	headerBytes := 0
	for name, value := range wire.Headers {
		headerBytes += len(name) + len(value)
	}
	return WireSize{HeaderBytes: headerBytes, BodyBytes: len(wire.Body), TotalBytes: headerBytes + len(wire.Body)}
}

// DecodeOptions tunes DecodeWire.
type DecodeOptions struct {
	// MaxBytes refuses events bigger than this (the driver's MaxMessageBytes, or a core-side ceiling). 0 = no limit.
	MaxBytes int
	Strict   bool
}

// DecodeWire decodes a wire event in either mode (binary when the headers
// carry specversion, structured otherwise) into attributes and body bytes,
// validating strictly. It returns an *EnvelopeError; the core drops such events
// and counts them.
func DecodeWire(wire WireEvent, opts DecodeOptions) (RawEvent, error) {
	size := SizeOf(wire)
	if opts.MaxBytes > 0 && size.TotalBytes > opts.MaxBytes {
		return RawEvent{}, envelopeErr(ReasonTooLarge, "event is %d bytes, over the limit of %d", size.TotalBytes, opts.MaxBytes)
	}
	headers := make(map[string]string, len(wire.Headers))
	for name, value := range wire.Headers {
		headers[strings.ToLower(name)] = value
	}
	validate := ValidateOptions{Strict: opts.Strict}
	if _, binary := headers["specversion"]; binary {
		contentType, hasCT := headers["content-type"]
		delete(headers, "content-type")
		attributes, err := ValidateAttributes(headers, validate)
		if err != nil {
			return RawEvent{}, err
		}
		if hasCT && strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]) != attributes.DataContentType {
			return RawEvent{}, envelopeErr(ReasonMalformed, "content-type does not match datacontenttype")
		}
		return RawEvent{Attributes: attributes, Body: wire.Body}, nil
	}
	if ct, ok := headers["content-type"]; ok && !strings.HasPrefix(ct, "application/cloudevents+json") {
		return RawEvent{}, envelopeErr(ReasonUnsupported, "content-type %q is not a CloudEvents document", ct)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(wire.Body, &document); err != nil || document == nil {
		if err == nil || bytes.HasPrefix(bytes.TrimSpace(wire.Body), []byte("null")) {
			return RawEvent{}, envelopeErr(ReasonMalformed, "structured event is not a JSON object")
		}
		if json.Valid(wire.Body) {
			return RawEvent{}, envelopeErr(ReasonMalformed, "structured event is not a JSON object")
		}
		return RawEvent{}, envelopeErr(ReasonMalformed, "structured event is not valid JSON")
	}
	data, hasData := document["data"]
	dataBase64, hasBase64 := document["data_base64"]
	delete(document, "data")
	delete(document, "data_base64")
	strs := make(map[string]string, len(document))
	for name, raw := range document {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return RawEvent{}, envelopeErr(ReasonMalformed, "attribute %q is not a string", name)
		}
		strs[name] = s
	}
	attributes, err := ValidateAttributes(strs, validate)
	if err != nil {
		return RawEvent{}, err
	}
	var body []byte
	if attributes.LfEnc != "" {
		var b64 string
		if !hasBase64 || hasData || json.Unmarshal(dataBase64, &b64) != nil {
			return RawEvent{}, envelopeErr(ReasonMalformed, "an encrypted structured event carries data_base64 only")
		}
		body, err = base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return RawEvent{}, envelopeErr(ReasonMalformed, "data_base64 is not base64")
		}
	} else {
		if hasBase64 {
			return RawEvent{}, envelopeErr(ReasonMalformed, "a plain structured event carries data, not data_base64")
		}
		if hasData && !bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			// The data as the sender serialised it (compact JS JSON): the same bytes JSON.stringify(data) gives, so the body digest matches.
			var compact bytes.Buffer
			if err := json.Compact(&compact, data); err != nil {
				return RawEvent{}, envelopeErr(ReasonMalformed, "data is not valid JSON")
			}
			body = compact.Bytes()
		}
	}
	return RawEvent{Attributes: attributes, Body: body}, nil
}

// ParseBody parses a plain (decrypted) body as JSON into v; an empty body is
// null (v is left untouched).
func ParseBody(body []byte, v any) error {
	if len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, v); err != nil {
		return envelopeErr(ReasonMalformed, "body is not valid JSON: %v", err)
	}
	return nil
}

// SerializeBody serialises v the way JSON.stringify does (compact, no HTML
// escaping), so bodies hash identically on both sides. json.RawMessage and
// []byte that is valid JSON pass through compacted.
func SerializeBody(v any) ([]byte, error) {
	switch raw := v.(type) {
	case nil:
		return []byte("null"), nil
	case json.RawMessage:
		return compactJSON(raw)
	case []byte:
		return compactJSON(raw)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("transport: serialise body: %w", err)
	}
	return unescapeLineSeparators(bytes.TrimRight(buf.Bytes(), "\n")), nil
}

var (
	escU2028 = []byte{'\\', 'u', '2', '0', '2', '8'}
	rawU2028 = []byte{0xe2, 0x80, 0xa8}
	rawU2029 = []byte{0xe2, 0x80, 0xa9}
)

// unescapeLineSeparators turns the U+2028 / U+2029 escapes encoding/json
// writes back into the raw characters JSON.stringify leaves in place, so both
// sides serialise a body to the same bytes. It walks the JSON strings and skips
// other escapes, so an escaped backslash followed by "u2028" is left alone.
func unescapeLineSeparators(in []byte) []byte {
	if !bytes.Contains(in, escU2028[:5]) {
		return in
	}
	out := make([]byte, 0, len(in))
	inString := false
	for i := 0; i < len(in); i++ {
		c := in[i]
		if !inString {
			if c == '"' {
				inString = true
			}
			out = append(out, c)
			continue
		}
		switch c {
		case '"':
			inString = false
			out = append(out, c)
		case '\\':
			if i+5 < len(in) && bytes.Equal(in[i:i+5], escU2028[:5]) && (in[i+5] == '8' || in[i+5] == '9') {
				if in[i+5] == '8' {
					out = append(out, rawU2028...)
				} else {
					out = append(out, rawU2029...)
				}
				i += 5
				continue
			}
			if i+1 < len(in) {
				out = append(out, c, in[i+1])
				i++
			} else {
				out = append(out, c)
			}
		default:
			out = append(out, c)
		}
	}
	return out
}

// compactJSON re-serialises raw JSON the way JSON.parse + JSON.stringify would:
// compact, strings re-encoded without HTML escaping (so "\u003c" becomes "<"),
// numbers in ES6 format (1.0 → 1, 1e2 → 100). Key order is kept. That is what a
// JavaScript host does with the manifest a Go plugin serves, so hashes agree.
func compactJSON(raw []byte) ([]byte, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return []byte("null"), nil
	}
	if !json.Valid(raw) {
		return nil, envelopeErr(ReasonMalformed, "body is not valid JSON")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var out bytes.Buffer
	needComma := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, envelopeErr(ReasonMalformed, "body is not valid JSON: %v", err)
		}
		switch v := tok.(type) {
		case json.Delim:
			switch v {
			case '{', '[':
				if needComma {
					out.WriteByte(',')
				}
				out.WriteByte(byte(v))
				needComma = false
				continue
			default: // '}' or ']'
				out.WriteByte(byte(v))
				needComma = true
				continue
			}
		}
		if needComma {
			out.WriteByte(',')
		}
		switch v := tok.(type) {
		case string:
			out.Write(marshalJSString(v))
		case json.Number:
			f, err := strconv.ParseFloat(v.String(), 64)
			switch {
			case err != nil:
				out.WriteString(v.String())
			case f == 0:
				out.WriteString("0") // JSON.stringify(-0) is "0"
			default:
				num, _ := json.Marshal(f)
				out.Write(num)
			}
		case bool:
			if v {
				out.WriteString("true")
			} else {
				out.WriteString("false")
			}
		case nil:
			out.WriteString("null")
		}
		needComma = true
	}
	// Object keys: the decoder yields "key" then value as two tokens; fix the comma between them into a colon.
	return fixObjectColons(out.Bytes()), nil
}

// fixObjectColons turns the comma the token loop wrote between an object key
// and its value into a colon. It walks the (already compact) JSON with a
// per-depth flag, so strings containing commas are left alone.
func fixObjectColons(in []byte) []byte {
	type frame struct {
		object  bool
		awaitKV int // 0: expecting key, 1: expecting colon (written as ','), 2: expecting value end
	}
	var stack []frame
	out := make([]byte, 0, len(in))
	inString := false
	for i := 0; i < len(in); i++ {
		c := in[i]
		if inString {
			out = append(out, c)
			if c == '\\' && i+1 < len(in) {
				i++
				out = append(out, in[i])
			} else if c == '"' {
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
			out = append(out, c)
			if n := len(stack); n > 0 && stack[n-1].object && stack[n-1].awaitKV == 0 {
				stack[n-1].awaitKV = 1
			}
		case '{':
			stack = append(stack, frame{object: true})
			out = append(out, c)
		case '[':
			stack = append(stack, frame{})
			out = append(out, c)
		case '}', ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			out = append(out, c)
			if n := len(stack); n > 0 && stack[n-1].object {
				stack[n-1].awaitKV = 2
			}
		case ',':
			if n := len(stack); n > 0 && stack[n-1].object {
				if stack[n-1].awaitKV == 1 {
					out = append(out, ':')
					stack[n-1].awaitKV = 2
					continue
				}
				stack[n-1].awaitKV = 0
			}
			out = append(out, c)
		default:
			out = append(out, c)
			if n := len(stack); n > 0 && stack[n-1].object && stack[n-1].awaitKV == 2 {
				// a scalar value in progress; nothing to do
			}
		}
	}
	return out
}

// MustSerializeBody is SerializeBody for values that cannot fail (structs of strings and numbers).
func MustSerializeBody(v any) []byte {
	out, err := SerializeBody(v)
	if err != nil {
		panic(err)
	}
	return out
}

func marshalJSString(s string) []byte {
	out, _ := SerializeBody(s)
	return out
}

// NewEventID makes a fresh event id: 32 hex characters (128 random bits).
func NewEventID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("transport: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// FormatTime is the time attribute's format: RFC 3339 in UTC with milliseconds, as JavaScript's toISOString().
func FormatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// SubjectOf is node.type of an Execute/webhook body, or the nodeType of
// LoadOptions: the event's subject. "" when the body names none.
func SubjectOf(method Method, body []byte) string {
	if len(body) == 0 {
		return ""
	}
	if method == MethodLoadOptions {
		var v struct {
			NodeType string `json:"nodeType"`
		}
		if json.Unmarshal(body, &v) != nil {
			return ""
		}
		return v.NodeType
	}
	var v struct {
		Node struct {
			Type string `json:"type"`
		} `json:"node"`
	}
	if json.Unmarshal(body, &v) != nil {
		return ""
	}
	return v.Node.Type
}
