package bridge

import (
	"fmt"
	"strings"

	"github.com/landflow/landflow/sdks/go/transport"
)

// DriverFactoriesFromEnv builds one DriverFactory per broker kind from LANDFLOW_<KIND>_URL and the registered driver
// (transport.LookupDriver; drivers.go blank-imports the driver modules so their init() registers them), the same way
// the Go SDK does (sdks/go/messaging.go brokerBindingsFromEnv): LANDFLOW_<KIND>_USERNAME, _PASSWORD, _TLS (true/1),
// _PREFIX (else LANDFLOW_TRANSPORT_PREFIX) and any other LANDFLOW_<KIND>_<FIELD> as a driver-specific field. The
// connection id is env-<kind>, the id the host gives the connection it reads from LANDFLOW_TRANSPORT_<KIND>_URL.
//
// kinds empty: every registered kind that has a URL. A named kind with a URL but no registered driver, or with no
// URL at all, is an error: the bridge exists to serve exactly those kinds.
func DriverFactoriesFromEnv(kinds []string, getenv func(string) string, environ func() []string) ([]DriverFactory, error) {
	explicit := len(kinds) > 0
	if !explicit {
		kinds = transport.DriverKinds()
	}
	var out []DriverFactory
	for _, kind := range kinds {
		kind = strings.ToLower(kind)
		envKind := strings.ToUpper(strings.ReplaceAll(kind, "-", "_"))
		url := strings.TrimSpace(getenv("LANDFLOW_" + envKind + "_URL"))
		if url == "" {
			if explicit {
				return nil, fmt.Errorf("bridge: %s names %q but LANDFLOW_%s_URL is not set", EnvTransports, kind, envKind)
			}
			continue
		}
		factory, ok := transport.LookupDriver(kind)
		if !ok {
			return nil, fmt.Errorf("bridge: LANDFLOW_%s_URL is set but this bridge has no %q driver (registered: %s)", envKind, kind, strings.Join(transport.DriverKinds(), ", "))
		}
		opts := transport.ConnectionOptions{
			Username: getenv("LANDFLOW_" + envKind + "_USERNAME"),
			Password: getenv("LANDFLOW_" + envKind + "_PASSWORD"),
			Prefix:   firstNonEmpty(getenv("LANDFLOW_"+envKind+"_PREFIX"), getenv("LANDFLOW_TRANSPORT_PREFIX")),
			Fields:   map[string]string{},
		}
		if tls := strings.ToLower(strings.TrimSpace(getenv("LANDFLOW_" + envKind + "_TLS"))); tls == "1" || tls == "true" || tls == "yes" {
			opts.TLS = true
		}
		prefix := "LANDFLOW_" + envKind + "_"
		for _, kv := range environ() {
			name, value, found := strings.Cut(kv, "=")
			if !found || !strings.HasPrefix(name, prefix) {
				continue
			}
			switch field := strings.ToLower(strings.TrimPrefix(name, prefix)); field {
			case "url", "username", "password", "tls", "prefix":
			default:
				opts.Fields[field] = value
			}
		}
		// Build one now so a malformed URL fails at startup, not at the first (re)start.
		if _, err := factory("env-"+kind, url, opts); err != nil {
			return nil, fmt.Errorf("bridge: LANDFLOW_%s_URL: %w", envKind, err)
		}
		connectionID, k := "env-"+kind, kind
		out = append(out, DriverFactory{Kind: k, ConnectionID: connectionID, New: func() (transport.Driver, error) {
			return factory(connectionID, url, opts)
		}})
	}
	return out, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
