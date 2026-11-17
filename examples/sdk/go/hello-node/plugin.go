// Hello Node: the smallest plugin that shows the parts every integration has.
//
//   - a credential type with a "Test connection" check,
//   - an action (greet) that uses the credential and sends items to one of two outputs,
//   - a poll trigger (newRequest) that remembers where it stopped.
package main

import (
	"context"
	"strings"
	"sync"

	landflow "github.com/landflow/landflow/sdks/go"
)

const maxNameLength = 50

var helloAPI = landflow.CredentialType{
	Name: "helloApi", DisplayName: "Hello API", DocumentationURL: "https://example.com/hello-api",
	Properties: []landflow.PropertyDescriptor{
		// A password field: masked in the UI and redacted from logs and spans.
		{Name: "apiKey", DisplayName: "API key", Type: landflow.PropString, Required: true,
			TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "salutation", DisplayName: "Salutation", Type: landflow.PropString, Default: "Hello"},
	},
	// A real plugin makes one cheap authenticated call here with landflow.HTTPClient(ctx) (Slack auth.test, Telegram getMe).
	// The sample checks the key's shape so it needs no network.
	Test: func(_ context.Context, data landflow.CredentialData) (bool, string) {
		if strings.HasPrefix(data.String("apiKey"), "hello-") {
			return true, "Key accepted"
		}
		return false, `The key must start with "hello-"`
	},
}

// Greet is one action with two outputs: output 0 gets the greetings, output 1 the items that had nobody to greet.
type Greet struct{}

func (Greet) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "greet", DisplayName: "Hello: Greet", Description: "Greet the name in each item",
		Version: landflow.V(1), Kind: landflow.KindAction,
		Categories: []string{"Examples"}, Icon: "lucide:hand", Subtitle: "{{name}}",
		Idempotent:   true, // the same input gives the same output, so a broker may deliver a call twice
		UsableAsTool: true, // an agent may call it, and it becomes an MCP tool
		Inputs:       []landflow.PortDescriptor{landflow.MainPort()},
		Outputs: []landflow.PortDescriptor{
			{Type: landflow.ConnectionMain, DisplayName: "Greeted"},
			{Type: landflow.ConnectionMain, DisplayName: "Skipped"},
		},
		Credentials: []landflow.NodeCredentialRequirement{{Name: "helloApi", Required: true}},
		Properties: []landflow.PropertyDescriptor{
			{Name: "name", DisplayName: "Name", Type: landflow.PropString, Default: "", Description: "Who to greet. An empty name goes to Skipped."},
			{Name: "shout", DisplayName: "Shout", Type: landflow.PropBoolean, Default: false},
		},
	}
}

func (Greet) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials("helloApi") // a NodeError that names the type when the host sent none
	if err != nil {
		return nil, err
	}
	salutation := creds.StringOr("salutation", "Hello")
	greeted, skipped := []landflow.Item{}, []landflow.Item{}
	for i, item := range ctx.InputData(0) {
		name := strings.TrimSpace(ctx.ParamString("name", i, ""))
		if len(name) > maxNameLength {
			err := landflow.ItemError(i, "The name is longer than %d characters", maxNameLength)
			if !ctx.ContinueOnFail() { // the node is not set to continue: the step fails
				return nil, err
			}
			skipped = append(skipped, ctx.ErrorItem(i, err))
			continue
		}
		if name == "" {
			skipped = append(skipped, landflow.Item{JSON: with(item.JSON, "reason", "empty name")})
			continue
		}
		text := salutation + ", " + name + "!"
		if ctx.ParamBool("shout", i, false) {
			text = strings.ToUpper(text)
		}
		greeted = append(greeted, landflow.Item{JSON: with(item.JSON, "greeting", text)})
	}
	ctx.Logger.Info("greeted %d, skipped %d", len(greeted), len(skipped))
	return [][]landflow.Item{greeted, skipped}, nil
}

// with copies m and sets one key: never change the input item in place.
func with(m map[string]any, key string, value any) map[string]any {
	next := make(map[string]any, len(m)+1)
	for k, v := range m {
		next[k] = v
	}
	next[key] = value
	return next
}

// feed is the stand-in for the service a real trigger polls. Tests push to it.
var feed struct {
	sync.Mutex
	requests []map[string]any // each has an "id"
}

func pushRequest(id int, name string) {
	feed.Lock()
	defer feed.Unlock()
	feed.requests = append(feed.requests, map[string]any{"id": id, "name": name})
}

// NewRequest is a poll trigger: the host calls it every pollInterval seconds with the state the last call returned.
type NewRequest struct{}

func (NewRequest) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "newRequest", DisplayName: "Hello: New Request", Description: "Starts the workflow for each new greeting request",
		Version: landflow.V(1), TriggerSource: landflow.TriggerPoll, // the kind defaults to trigger
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Credentials: []landflow.NodeCredentialRequirement{{Name: "helloApi", Required: true}},
		Properties:  []landflow.PropertyDescriptor{landflow.PollIntervalProperty(30)},
	}
}

func (NewRequest) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	if _, err := ctx.RequireCredentials("helloApi"); err != nil {
		return nil, err
	}
	feed.Lock()
	requests := append([]map[string]any(nil), feed.requests...)
	feed.Unlock()
	newest := 0
	for _, r := range requests {
		newest = max(newest, r["id"].(int))
	}
	if ctx.Mode() != landflow.ModePoll { // "Execute" in the editor: a few recent items, no state
		recent := requests[max(0, len(requests)-3):]
		return [][]landflow.Item{toItems(recent)}, nil
	}
	if ctx.IsFirstPoll() { // baseline: remember where we are and emit nothing
		ctx.SetPollState(map[string]any{"lastId": newest})
		return nil, nil
	}
	last := landflow.CredentialData(ctx.PollState()).Int("lastId", 0) // typed access to any map
	ctx.SetPollState(map[string]any{"lastId": max(last, newest)})
	var fresh []map[string]any
	for _, r := range requests {
		if r["id"].(int) > last {
			fresh = append(fresh, r)
		}
	}
	return [][]landflow.Item{toItems(fresh)}, nil
}

func toItems(rows []map[string]any) []landflow.Item {
	items := make([]landflow.Item, 0, len(rows))
	for _, r := range rows {
		items = append(items, landflow.Item{JSON: r})
	}
	return items
}

func newPlugin() *landflow.Plugin {
	return landflow.NewPlugin(landflow.PluginInfo{
		ID: "hello-node", Name: "Hello Node", Version: "0.1.0", Description: "A small example plugin",
		Icon: "lucide:hand", Color: "#16a34a", Author: "Landflow examples",
		CredentialTypes: []landflow.CredentialType{helloAPI},
	}, Greet{}, NewRequest{})
}
