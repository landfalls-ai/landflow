package landflow

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// CredentialType declares a kind of secret the plugin's nodes need (an API
// token, a database DSN, an OAuth client). The host renders a form from
// Properties, stores the values encrypted and sends the decrypted values with
// each Execute / LoadOptions call (ExecuteContext.Credentials). Mark secret
// fields with TypeOptions{Password: true}: the UI masks them and the SDK
// redacts their values from logs and span attributes.
//
//	landflow.CredentialType{
//		Name: "telegramApi", DisplayName: "Telegram API",
//		Properties: []landflow.PropertyDescriptor{
//			{Name: "accessToken", DisplayName: "Bot Token", Type: landflow.PropString, Required: true,
//				TypeOptions: &landflow.TypeOptions{Password: true}},
//			{Name: "baseUrl", DisplayName: "API Base URL", Type: landflow.PropString, Default: "https://api.telegram.org"},
//		},
//		Test: func(ctx context.Context, data landflow.CredentialData) (bool, string) { … },
//	}
type CredentialType struct {
	// Name is the local name, unique inside the plugin ("telegramApi").
	Name             string
	DisplayName      string
	Description      string
	Icon             string // same forms as NodeDescriptor.Icon, file: included
	DocumentationURL string
	Properties       []PropertyDescriptor
	// Test, when set, implements TestCredentials ("Test connection" in the UI)
	// and marks the type testable. Make a cheap authenticated call and explain
	// a failure in message. ctx carries the plugin.test_credentials span, so
	// landflow.HTTPClient(ctx) traces the call.
	Test func(ctx context.Context, data CredentialData) (ok bool, message string)
}

// Descriptor returns the manifest form of t.
func (t CredentialType) Descriptor() CredentialTypeDescriptor {
	props := t.Properties
	if props == nil {
		props = []PropertyDescriptor{}
	}
	return CredentialTypeDescriptor{
		Name: t.Name, DisplayName: t.DisplayName, Description: t.Description, Icon: t.Icon,
		DocumentationURL: t.DocumentationURL, Properties: props, Testable: t.Test != nil,
	}
}

// CredentialData is the decrypted data of one credential, keyed by the
// credential type's property names. It is a plain map with typed accessors;
// a nil CredentialData is valid and empty.
type CredentialData map[string]any

// Has reports whether field is set to a non-null value.
func (d CredentialData) Has(field string) bool { return d[field] != nil }

// String returns field as a string ("" when unset); numbers and booleans are formatted.
func (d CredentialData) String(field string) string { return Stringify(d[field]) }

// StringOr returns field as a string, or def when it is unset or empty.
func (d CredentialData) StringOr(field, def string) string {
	if s := d.String(field); s != "" {
		return s
	}
	return def
}

// Int returns field as an int (numeric strings are parsed), or def.
func (d CredentialData) Int(field string, def int) int {
	f, ok := toFloat(d[field])
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return def
	}
	return int(f)
}

// Float returns field as a float64, or def.
func (d CredentialData) Float(field string, def float64) float64 {
	if f, ok := toFloat(d[field]); ok {
		return f
	}
	return def
}

// Bool returns field as a bool ("true"/"false"/"1"/"0" strings and numbers
// are accepted), or def.
func (d CredentialData) Bool(field string, def bool) bool {
	switch t := d[field].(type) {
	case nil:
		return def
	case bool:
		return t
	case string:
		if b, err := strconv.ParseBool(strings.TrimSpace(t)); err == nil {
			return b
		}
		return def
	default:
		if f, ok := toFloat(t); ok {
			return f != 0
		}
		return def
	}
}

// asCredentialData converts one entry of ExecuteRequest.Credentials.
func asCredentialData(v any) CredentialData {
	switch t := v.(type) {
	case CredentialData:
		return t
	case map[string]any:
		return CredentialData(t)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Redacted replaces secret values in logs and span attributes.
const Redacted = "[REDACTED]"

// secretKeyPattern matches attribute keys whose string values are never
// logged (docs/observability.md §3). Names of addresses and kinds (tokenUrl,
// tokenType) are not secrets.
var (
	secretKeyPattern    = regexp.MustCompile(`(?i)(token|secret|password|authorization|api[-_]?key|cookie)`)
	nonSecretKeyPattern = regexp.MustCompile(`(?i)(url|uri|endpoint|host|type)$`)
)

// IsSecretKey reports whether an attribute or field name looks like it holds
// a secret (token, secret, password, authorization, api key, cookie), except
// names ending in url, uri, endpoint, host or type.
func IsSecretKey(key string) bool {
	return secretKeyPattern.MatchString(key) && !nonSecretKeyPattern.MatchString(key)
}

// minSecretLen keeps very short values (a port, "dev") from being masked
// wherever they appear.
const minSecretLen = 4

// redactor masks the credential values of one request wherever they appear
// in a string: password-typed fields of the declared credential type, and
// any field whose name looks secret.
type redactor struct {
	secrets []string // longest first, so overlapping values are fully masked
}

func newRedactor(creds map[string]any, types map[string]*registeredCredType) *redactor {
	seen := map[string]bool{}
	for typeName, raw := range creds {
		var password map[string]bool
		if rt := types[typeName]; rt != nil {
			password = rt.passwordFields
		}
		collectSecrets(asCredentialData(raw), password, false, seen)
	}
	if len(seen) == 0 {
		return nil
	}
	r := &redactor{secrets: make([]string, 0, len(seen))}
	for s := range seen {
		r.secrets = append(r.secrets, s)
	}
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
	return r
}

func collectSecrets(data map[string]any, password map[string]bool, all bool, out map[string]bool) {
	for key, v := range data {
		secret := all || password[key] || IsSecretKey(key)
		switch t := v.(type) {
		case string:
			if secret && len(t) >= minSecretLen {
				out[t] = true
			}
		case map[string]any:
			collectSecrets(t, nil, secret, out)
		case []any:
			for _, e := range t {
				if s, ok := e.(string); ok && secret && len(s) >= minSecretLen {
					out[s] = true
				} else if m, ok := e.(map[string]any); ok {
					collectSecrets(m, nil, secret, out)
				}
			}
		}
	}
}

// str masks every known secret in s. A nil redactor returns s unchanged.
func (r *redactor) str(s string) string {
	if r == nil || s == "" {
		return s
	}
	for _, secret := range r.secrets {
		if strings.Contains(s, secret) {
			s = strings.ReplaceAll(s, secret, Redacted)
		}
	}
	return s
}

// errString is err.Error() with secrets masked.
func (r *redactor) errString(err error) string {
	if err == nil {
		return ""
	}
	return r.str(err.Error())
}

// RedactString masks the credential values of the current call (those the
// SDK would mask in logs and spans) in s. ctx is an ExecuteContext,
// LoadOptionsContext, Span or the context passed to CredentialType.Test.
func RedactString(ctx context.Context, s string) string {
	return scopeFrom(ctx).redact.str(s)
}

// credentialsFrom returns credential data by type from a request's map.
func credentialsFrom(creds map[string]any, names []string) CredentialData {
	if len(names) == 0 {
		return CredentialData(creds)
	}
	return asCredentialData(creds[names[0]])
}

// missingCredentials is the NodeError for RequireCredentials.
func missingCredentials(name string) *NodeError {
	return &NodeError{
		Message:     fmt.Sprintf("Credentials of type %q are required", name),
		Description: "Select or create a credential for this node in its settings.",
	}
}
