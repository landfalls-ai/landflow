package main

import (
	"regexp"
	"strings"
	"testing"

	landflow "github.com/landflow/landflow/sdks/go"
)

// readOnlyVerb mirrors READ_ONLY_OPERATION in packages/protocol/src/mcp-tools.ts (JavaScript's negative lookahead
// `(?![a-z])` is written as "the verb is followed by the end or a non-lower-case character").
var readOnlyVerb = regexp.MustCompile(`^(get|getAll|getMany|list|search|read|find|fetch|describe|count|exists|check|download|select|info|keys|llen|lookup|retrieve|view|show|preview|head)([^a-z]|$)`)

func TestManifest(t *testing.T) {
	m := newPlugin().Manifest()
	if m.Plugin.ID != "threat-intel" || m.Plugin.Name != "Threat Intel" || m.Plugin.Language != "go" || !strings.HasPrefix(m.Plugin.Icon, "data:image/svg+xml;base64,") {
		t.Errorf("plugin = %.200v", m.Plugin)
	}
	wantNodes := []string{"virusTotal", "abuseIpDb", "greyNoise", "urlscan", "shodan", "alienVaultOtx", "misp", "iocEnrich"}
	var names []string
	for _, n := range m.Nodes {
		names = append(names, n.Name)
	}
	eq(t, "nodes", strings.Join(names, ","), strings.Join(wantNodes, ","))
	wantCreds := []string{"virusTotalApi", "abuseIpDbApi", "greyNoiseApi", "urlscanApi", "shodanApi", "otxApi", "mispApi"}
	var creds []string
	for _, c := range m.CredentialTypes {
		creds = append(creds, c.Name)
	}
	eq(t, "credential types", strings.Join(creds, ","), strings.Join(wantCreds, ","))
}

func TestEveryNodeIsAReadOnlyTool(t *testing.T) {
	m := newPlugin().Manifest()
	for _, n := range m.Nodes {
		if !n.UsableAsTool || n.Kind != landflow.KindAction {
			t.Errorf("%s: usableAsTool=%v kind=%s", n.Name, n.UsableAsTool, n.Kind)
		}
		if n.ToolDescription == "" || !strings.Contains(n.ToolDescription, "read only") {
			t.Errorf("%s: tool description %q does not say read only", n.Name, n.ToolDescription)
		}
		if !n.Idempotent {
			t.Errorf("%s is not idempotent", n.Name)
		}
		ops := 0
		for _, p := range n.Properties {
			if p.Name != "operation" {
				continue
			}
			for _, o := range p.Options {
				ops++
				v := o.Value.(string)
				if !readOnlyVerb.MatchString(v) {
					t.Errorf("%s: operation %q would not be marked readOnlyHint", n.Name, v)
				}
				if !o.Idempotent {
					t.Errorf("%s.%s is not idempotent", n.Name, v)
				}
				if o.ToolAnnotations != nil && o.ToolAnnotations.DestructiveHint != nil && *o.ToolAnnotations.DestructiveHint {
					t.Errorf("%s.%s is marked destructive", n.Name, v)
				}
				for _, bad := range []string{"submit", "scan", "create", "delete", "post", "add", "update", "send"} {
					if strings.HasPrefix(strings.ToLower(v), bad) {
						t.Errorf("%s offers a write-looking operation %q", n.Name, v)
					}
				}
			}
		}
		if n.Name == "iocEnrich" {
			// No operation to derive the hint from: the node says so itself.
			a := n.ToolAnnotations
			if ops != 0 || a == nil || a.ReadOnlyHint == nil || !*a.ReadOnlyHint || a.DestructiveHint == nil || *a.DestructiveHint {
				t.Errorf("iocEnrich annotations = %+v (operations %d)", a, ops)
			}
			if n.ToolInputSchema == nil {
				t.Error("iocEnrich has no tool input schema")
			}
		} else if ops == 0 {
			t.Errorf("%s has no operations", n.Name)
		}
	}
}

func TestToolNamesAreDerivableAndUnique(t *testing.T) {
	// Mirrors rawToolName: <node>_<resource>_<operation>, because no node is named after the plugin.
	seen := map[string]string{}
	for _, n := range newPlugin().Manifest().Nodes {
		if n.Name == "iocEnrich" {
			continue
		}
		for _, p := range n.Properties {
			if p.Name != "operation" {
				continue
			}
			// Each operation picker is shown for one resource.
			resource := p.DisplayOptions.Show["resource"][0].(string)
			for _, o := range p.Options {
				name := n.Name + "_" + resource + "_" + o.Value.(string)
				if prev, dup := seen[name]; dup {
					t.Errorf("duplicate tool name %s (%s)", name, prev)
				}
				seen[name] = n.Name
			}
		}
	}
	if len(seen) == 0 {
		t.Fatal("no tools derived")
	}
}

func TestReferencedCredentialsExist(t *testing.T) {
	m := newPlugin().Manifest()
	declared := map[string]landflow.CredentialTypeDescriptor{}
	for _, c := range m.CredentialTypes {
		declared[c.Name] = c
	}
	used := map[string]bool{}
	for _, n := range m.Nodes {
		if len(n.Credentials) == 0 {
			t.Errorf("%s declares no credentials", n.Name)
		}
		for _, c := range n.Credentials {
			if _, ok := declared[c.Name]; !ok {
				t.Errorf("%s references the undeclared credential %q", n.Name, c.Name)
			}
			used[c.Name] = true
			if n.Name == "iocEnrich" && c.Required {
				t.Errorf("iocEnrich requires %s; every credential must be optional", c.Name)
			}
		}
	}
	for name := range declared {
		if !used[name] {
			t.Errorf("credential %s is used by no node", name)
		}
	}
	// Single-service nodes require their credential, except GreyNoise (its key is optional).
	for _, n := range m.Nodes {
		if n.Name == "iocEnrich" {
			continue
		}
		wantRequired := n.Name != "greyNoise"
		if n.Credentials[0].Required != wantRequired {
			t.Errorf("%s credential required = %v", n.Name, n.Credentials[0].Required)
		}
	}
}

func TestCredentialTypes(t *testing.T) {
	for _, c := range newPlugin().Manifest().CredentialTypes {
		if !c.Testable {
			t.Errorf("%s has no credential test", c.Name)
		}
		var key *landflow.PropertyDescriptor
		for i, p := range c.Properties {
			if p.Name == "apiKey" {
				key = &c.Properties[i]
			}
		}
		if key == nil || key.TypeOptions == nil || !key.TypeOptions.Password {
			t.Errorf("%s: apiKey is not a password field", c.Name)
		}
		if c.Name == "greyNoiseApi" && key != nil && key.Required {
			t.Error("the GreyNoise key must be optional")
		}
		if c.Name == "mispApi" {
			fields := map[string]landflow.PropertyDescriptor{}
			for _, p := range c.Properties {
				fields[p.Name] = p
			}
			if !fields["baseUrl"].Required || fields["allowUnverifiedTls"].Type != landflow.PropBoolean || fields["allowUnverifiedTls"].Default != false {
				t.Errorf("mispApi fields = %+v", fields)
			}
		}
	}
}

func TestIOCEnrichProperties(t *testing.T) {
	d := (IOCEnrichNode{}).Description()
	defaults := map[string]any{}
	for _, p := range d.Properties {
		defaults[p.Name] = p.Default
	}
	eq(t, "iocPath", defaults["iocPath"], "ioc")
	eq(t, "typePath", defaults["typePath"], "type")
	eq(t, "valuePath", defaults["valuePath"], "value")
	eq(t, "iocsPath", defaults["iocsPath"], "iocs")
	eq(t, "cacheTtl", defaults["cacheTtl"], 3600)
	eq(t, "services default", len(defaults["services"].([]any)), len(enrichers))
	// every enricher has a credential the node declares
	declared := map[string]bool{}
	for _, c := range d.Credentials {
		declared[c.Name] = true
	}
	for _, e := range enrichers {
		if !declared[e.cred] {
			t.Errorf("enricher %s: node does not declare credential %s", e.id, e.cred)
		}
	}
}
