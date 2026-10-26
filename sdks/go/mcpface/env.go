package mcpface

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strings"
)

// Environment and flags shared by every SDK's MCP face (docs/protocol.md §15.2).
const (
	ModeEnv        = "LANDFLOW_MCP"
	TokenEnv       = "LANDFLOW_MCP_TOKEN"
	CredentialsEnv = "LANDFLOW_MCP_CREDENTIALS"
	StdioFlag      = "--mcp-stdio"
	DefaultPath    = "/mcp"
)

// Mode is how the face runs: at /mcp on the HTTP port (the default), over stdin/stdout, or not at all.
type Mode string

const (
	ModeHTTP  Mode = "http"
	ModeStdio Mode = "stdio"
	ModeOff   Mode = "off"
)

// ModeFromEnv resolves the mode from `--mcp-stdio` in argv, `LANDFLOW_MCP` (on, off, stdio) and the fallback given by
// code, in that order of precedence. env and argv default to the process's own when nil.
func ModeFromEnv(fallback Mode, env map[string]string, argv []string) (Mode, error) {
	if argv == nil {
		argv = os.Args[1:]
	}
	for _, arg := range argv {
		if arg == StdioFlag {
			return ModeStdio, nil
		}
	}
	raw, ok := "", false
	if env != nil {
		raw, ok = env[ModeEnv]
	} else {
		raw, ok = os.LookupEnv(ModeEnv)
	}
	if ok {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "stdio":
			return ModeStdio, nil
		case "off", "false", "0":
			return ModeOff, nil
		case "", "on", "true", "1", "http":
		default:
			return "", fmt.Errorf("%s=%q is not one of on, off, stdio", ModeEnv, raw)
		}
	}
	if fallback == "" {
		return ModeHTTP, nil
	}
	return fallback, nil
}

var loopbackV4 = regexp.MustCompile(`^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$`)

// IsLoopbackHost reports whether a listen host is loopback only (so /mcp may run without a token). "" (all interfaces) is not.
func IsLoopbackHost(host string) bool {
	value := strings.ToLower(strings.TrimSpace(host))
	value = strings.TrimPrefix(strings.TrimSuffix(value, "]"), "[")
	if value == "" {
		return false
	}
	if value == "localhost" || value == "::1" || value == "::ffff:127.0.0.1" || loopbackV4.MatchString(value) {
		return true
	}
	ip := net.ParseIP(value)
	return ip != nil && ip.IsLoopback()
}

// Credentials are the configured credentials of a standalone plugin, by local credential type name.
type Credentials map[string]map[string]any

// LoadCredentials reads `LANDFLOW_MCP_CREDENTIALS`: a path to a JSON file or inline JSON, `{ "<credentialType>": {
// …fields } }` keyed by the local type name (a qualified `plugin.type` key is reduced to `type`). Empty when unset.
func LoadCredentials(value string) (Credentials, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return Credentials{}, nil
	}
	inline := strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[")
	source := []byte(text)
	if !inline {
		data, err := os.ReadFile(text)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", CredentialsEnv, err)
		}
		source = data
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(source, &parsed); err != nil || parsed == nil {
		where := ""
		if !inline {
			where = " (file " + text + ")"
		}
		if err == nil {
			err = errors.New("expected an object")
		}
		return nil, fmt.Errorf("%s is not a JSON object keyed by credential type%s: %w", CredentialsEnv, where, err)
	}
	out := Credentials{}
	for typ, raw := range parsed {
		var fields map[string]any
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("%s: %q must be an object of fields", CredentialsEnv, typ)
		}
		out[typ[strings.LastIndex(typ, ".")+1:]] = fields
	}
	return out, nil
}

// LoadCredentialsFromEnv is LoadCredentials over the process environment.
func LoadCredentialsFromEnv() (Credentials, error) { return LoadCredentials(os.Getenv(CredentialsEnv)) }

// BearerTokenMatches is a constant-time check of `Authorization: Bearer <token>`.
func BearerTokenMatches(header, token string) bool {
	header = strings.TrimSpace(header)
	if len(header) < 7 || !strings.EqualFold(header[:7], "bearer ") || token == "" {
		return false
	}
	presented := strings.TrimSpace(header[7:])
	a := sha256.Sum256([]byte(presented))
	b := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
