package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Credential type names. The fields are the same everywhere: apiKey (a password field) and an optional baseUrl that
// replaces the service's host (a proxy, a regional endpoint or a test double). MISP's baseUrl is required.
const (
	credVirusTotal = "virusTotalApi"
	credAbuseIPDB  = "abuseIpDbApi"
	credGreyNoise  = "greyNoiseApi"
	credURLScan    = "urlscanApi"
	credShodan     = "shodanApi"
	credOTX        = "otxApi"
	credMISP       = "mispApi"
)

func apiKeyProperty(display string, required bool, description string) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "apiKey", DisplayName: display, Type: landflow.PropString, Default: "", Required: required,
		Description: description, TypeOptions: &landflow.TypeOptions{Password: true},
	}
}

func baseURLProperty(def string, required bool) landflow.PropertyDescriptor {
	p := landflow.PropertyDescriptor{
		Name: "baseUrl", DisplayName: "API Base URL", Type: landflow.PropString, Default: def, Required: required,
		Description: "Replaces the service's host for every call and keeps the paths",
	}
	if def == "" {
		p.Placeholder = "https://misp.example.org"
	}
	return p
}

// testResult turns the outcome of a credential test call into Test's (ok, message).
func testResult(svc service, err error, okMessage string) (bool, string) {
	if err == nil {
		return true, okMessage
	}
	var ae *apiError
	if errors.As(err, &ae) {
		msg := fmt.Sprintf("%s answered HTTP %d: %s", svc.title, ae.status, ae.message)
		if h := ae.hint(); h != "" {
			msg += ". " + h
		}
		return false, msg
	}
	return false, err.Error()
}

var virusTotalCredential = landflow.CredentialType{
	Name:             credVirusTotal,
	DisplayName:      "VirusTotal API",
	Description:      "A VirusTotal API key (v3), sent as the x-apikey header. The free key is rate limited; see the plugin README.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://docs.virustotal.com/reference/overview",
	Properties:       []landflow.PropertyDescriptor{apiKeyProperty("API Key", true, "From your VirusTotal profile"), baseURLProperty("", false)},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		key := strings.TrimSpace(d.String("apiKey"))
		if key == "" {
			return false, "Enter the API key."
		}
		// GET /users/{id} accepts the API key as the id and costs no lookup quota.
		err := newClient(svcVirusTotal, d, "x-apikey").do(ctx, http.MethodGet, "/api/v3/users/"+url.PathEscape(key), nil, nil, nil)
		return testResult(svcVirusTotal, err, "VirusTotal accepted the API key.")
	},
}

var abuseIpDbCredential = landflow.CredentialType{
	Name:             credAbuseIPDB,
	DisplayName:      "AbuseIPDB API",
	Description:      "An AbuseIPDB v2 API key, sent as the Key header.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://docs.abuseipdb.com/",
	Properties:       []landflow.PropertyDescriptor{apiKeyProperty("API Key", true, "From your AbuseIPDB account"), baseURLProperty("", false)},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		if strings.TrimSpace(d.String("apiKey")) == "" {
			return false, "Enter the API key."
		}
		// Checking the loopback address is AbuseIPDB's own suggestion for testing a key.
		err := newClient(svcAbuseIPDB, d, "Key").do(ctx, http.MethodGet, "/api/v2/check", url.Values{"ipAddress": {"127.0.0.1"}}, nil, nil)
		return testResult(svcAbuseIPDB, err, "AbuseIPDB accepted the API key.")
	},
}

var greyNoiseCredential = landflow.CredentialType{
	Name:             credGreyNoise,
	DisplayName:      "GreyNoise API",
	Description:      "A GreyNoise API key, sent as the key header. Optional: the Community API answers without one at a lower rate limit. IOC Enrich runs GreyNoise only when this credential is attached to the node.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://docs.greynoise.io/reference/get_v3-community-ip",
	Properties:       []landflow.PropertyDescriptor{apiKeyProperty("API Key", false, "Leave empty to use the keyless Community API"), baseURLProperty("", false)},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		c := newClient(svcGreyNoise, d, "key")
		err := c.do(ctx, http.MethodGet, "/v3/community/8.8.8.8", nil, nil, nil)
		if isNotFound(err) {
			err = nil // a 404 is "not seen": the call itself worked
		}
		if err == nil && strings.TrimSpace(d.String("apiKey")) == "" {
			return true, "GreyNoise Community API reachable (no API key: keyless rate limit)."
		}
		return testResult(svcGreyNoise, err, "GreyNoise accepted the API key.")
	},
}

var urlscanCredential = landflow.CredentialType{
	Name:             credURLScan,
	DisplayName:      "urlscan.io API",
	Description:      "A urlscan.io API key, sent as the API-Key header. Landflow only searches and reads results; it never submits a scan.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://urlscan.io/docs/api/",
	Properties:       []landflow.PropertyDescriptor{apiKeyProperty("API Key", true, "From your urlscan.io profile"), baseURLProperty("", false)},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		if strings.TrimSpace(d.String("apiKey")) == "" {
			return false, "Enter the API key."
		}
		err := newClient(svcURLScan, d, "API-Key").do(ctx, http.MethodGet, "/user/quotas/", nil, nil, nil)
		return testResult(svcURLScan, err, "urlscan.io accepted the API key.")
	},
}

var shodanCredential = landflow.CredentialType{
	Name:             credShodan,
	DisplayName:      "Shodan API",
	Description:      "A Shodan API key, sent as the key query parameter.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://developer.shodan.io/api",
	Properties:       []landflow.PropertyDescriptor{apiKeyProperty("API Key", true, "From your Shodan account"), baseURLProperty("", false)},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		if strings.TrimSpace(d.String("apiKey")) == "" {
			return false, "Enter the API key."
		}
		err := newClient(svcShodan, d, "").do(ctx, http.MethodGet, "/api-info", nil, nil, nil)
		return testResult(svcShodan, err, "Shodan accepted the API key.")
	},
}

var otxCredential = landflow.CredentialType{
	Name:             credOTX,
	DisplayName:      "AlienVault OTX API",
	Description:      "An AlienVault OTX API key, sent as the X-OTX-API-KEY header.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://otx.alienvault.com/api",
	Properties:       []landflow.PropertyDescriptor{apiKeyProperty("API Key", true, "From your OTX account settings"), baseURLProperty("", false)},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		if strings.TrimSpace(d.String("apiKey")) == "" {
			return false, "Enter the API key."
		}
		err := newClient(svcOTX, d, "X-OTX-API-KEY").do(ctx, http.MethodGet, "/api/v1/users/me", nil, nil, nil)
		return testResult(svcOTX, err, "OTX accepted the API key.")
	},
}

var mispCredential = landflow.CredentialType{
	Name:             credMISP,
	DisplayName:      "MISP API",
	Description:      "A self-hosted MISP: its base URL and an auth key, sent as the Authorization header.",
	Icon:             "file:icons/threat-intel.svg",
	DocumentationURL: "https://www.misp-project.org/openapi/",
	Properties: []landflow.PropertyDescriptor{
		baseURLProperty("", true),
		apiKeyProperty("Auth Key", true, "The user's automation key"),
		{Name: "allowUnverifiedTls", DisplayName: "Allow Unverified TLS", Type: landflow.PropBoolean, Default: false,
			Description: "Skip TLS certificate verification, for a lab MISP with a self-signed certificate. Leave off in production."},
	},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		if normalizeBaseURL(d.String("baseUrl")) == "" || strings.TrimSpace(d.String("apiKey")) == "" {
			return false, "Enter the base URL and the auth key."
		}
		err := newMISPClient(d).do(ctx, http.MethodGet, "/users/view/me", nil, nil, nil)
		return testResult(svcMISP, err, "MISP accepted the auth key.")
	},
}
