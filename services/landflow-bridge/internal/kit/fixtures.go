// Package kit runs the protocol conformance kit (packages/protocol/conformance, the fixtures every SDK × face must
// pass) over the messaging face from a Go transport.Client: the Go counterpart of the messaging runner in
// packages/sdk/test/conformance.test.ts. The bridge's tests use it with a Go plugin and a Python plugin behind the
// bridge, over the in-memory broker and over the tier 1 brokers.
package kit

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// PluginID is the conformance plugin's id.
const PluginID = "landflow-conformance"

// Suite is one fixtures/*.json file.
type Suite struct {
	Kit         string   `json:"kit"`
	Suite       string   `json:"suite"`
	Description string   `json:"description"`
	Applies     []string `json:"applies"`
	Cases       []Case   `json:"cases"`
}

// Case is one call and what must happen.
type Case struct {
	ID          string      `json:"id"`
	Description string      `json:"description"`
	Applies     []string    `json:"applies"`
	Call        Call        `json:"call"`
	Expect      Expectation `json:"expect"`
}

// Call is what the runner sends.
type Call struct {
	Method          string                   `json:"method"`
	Node            string                   `json:"node"`
	Parameters      map[string]any           `json:"parameters"`
	Items           []map[string]any         `json:"items"`
	DeadlineMs      *int                     `json:"deadlineMs"`
	CancelAfterMs   *int                     `json:"cancelAfterMs"`
	IdempotencyKey  string                   `json:"idempotencyKey"`
	Repeat          int                      `json:"repeat"`
	PadBytes        int                      `json:"padBytes"`
	Tamper          string                   `json:"tamper"`
	LoadOptions     *struct{ Method string } `json:"loadOptions"`
	TestCredentials map[string]any           `json:"testCredentials"`
	Credentials     map[string]any           `json:"credentials"`
}

// Expectation is what must happen; Outcome is a string or a list.
type Expectation struct {
	Outcome       json.RawMessage    `json:"outcome"`
	Code          string             `json:"code"`
	Outputs       [][]map[string]any `json:"outputs"`
	ErrorMessage  string             `json:"errorMessage"`
	Ran           *bool              `json:"ran"`
	SignalAborted bool               `json:"signalAborted"`
	WithinMs      *int               `json:"withinMs"`
	DeliveryMode  string             `json:"deliveryMode"`
	Count         *float64           `json:"count"`
	Note          string             `json:"note"`
}

// Outcomes lists the acceptable outcomes.
func (e Expectation) Outcomes() []string {
	var one string
	if json.Unmarshal(e.Outcome, &one) == nil {
		return []string{one}
	}
	var many []string
	_ = json.Unmarshal(e.Outcome, &many)
	return many
}

// RepoRoot finds the repository root from the working directory (the directory holding packages/protocol/conformance).
func RepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "packages", "protocol", "conformance", "plugin-manifest.json")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("repository root (packages/protocol/conformance) not found above the working directory")
}

// LoadSuites loads every suite that applies to the messaging face, in file order.
func LoadSuites() ([]Suite, error) {
	root, err := RepoRoot()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, "packages", "protocol", "conformance", "fixtures")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") && e.Name() != "mcp-tools.json" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	var suites []Suite
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		var suite Suite
		if err := json.Unmarshal(data, &suite); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if !applies(suite.Applies) {
			continue
		}
		var cases []Case
		for _, c := range suite.Cases {
			if applies(c.Applies) {
				cases = append(cases, c)
			}
		}
		suite.Cases = cases
		suites = append(suites, suite)
	}
	return suites, nil
}

func applies(faces []string) bool {
	if len(faces) == 0 {
		return true
	}
	for _, f := range faces {
		if f == "messaging" {
			return true
		}
	}
	return false
}

// LoadPluginManifest reads plugin-manifest.json.
func LoadPluginManifest() (json.RawMessage, error) {
	root, err := RepoRoot()
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(root, "packages", "protocol", "conformance", "plugin-manifest.json"))
}

// OutputsMatch is the kit's outputsMatch: every expected item's JSON is a subset of the real one, per branch.
func OutputsMatch(expected [][]map[string]any, actual [][]map[string]any) bool {
	if len(expected) > len(actual) {
		return false
	}
	for b, branch := range expected {
		if len(branch) > len(actual[b]) {
			return false
		}
		for i, item := range branch {
			want, _ := item["json"].(map[string]any)
			got, _ := actual[b][i]["json"].(map[string]any)
			for k, v := range want {
				if !jsonEqual(got[k], v) {
					return false
				}
			}
		}
	}
	return true
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
