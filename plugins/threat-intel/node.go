package main

import (
	"errors"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// The seven service nodes share one shape: a resource → operation pair per lookup, a credential, and an operation
// function that makes the calls for one input item and returns the output item's JSON.

// opKey is a resource and operation pair.
type opKey struct{ resource, operation string }

// run is what an operation function gets: the execution and a client for the node's credential.
type run struct {
	ctx *landflow.ExecuteContext
	c   *apiClient
}

type opFunc func(r *run, i int) (map[string]any, error)

type serviceNode struct {
	desc      landflow.NodeDescriptor
	cred      string
	optional  bool // the credential may be absent (GreyNoise's keyless Community API)
	newClient func(ctx *landflow.ExecuteContext, data landflow.CredentialData) *apiClient
	ops       map[opKey]opFunc
}

func (n *serviceNode) Description() landflow.NodeDescriptor { return n.desc }

func (n *serviceNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	data := landflow.CredentialData{}
	if ctx.HasCredentials(n.cred) || !n.optional {
		var err error
		if data, err = ctx.RequireCredentials(n.cred); err != nil {
			return nil, err
		}
	}
	r := &run{ctx: ctx, c: n.newClient(ctx, data)}
	out := make([]landflow.Item, 0, len(items))
	for i := range items {
		key := opKey{ctx.ParamString("resource", i, ""), ctx.ParamString("operation", i, "")}
		op, ok := n.ops[key]
		var result map[string]any
		var err error
		if !ok {
			err = userError("Pick a resource and operation listed for this node.", "Unsupported operation %q for resource %q", key.operation, key.resource)
		} else {
			result, err = op(r, i)
		}
		if err != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, itemError(i, err)))
				continue
			}
			return nil, itemError(i, err)
		}
		out = append(out, landflow.Item{JSON: result, PairedItem: &landflow.PairedItem{Item: i}})
	}
	return [][]landflow.Item{out}, nil
}

// itemError turns err into a NodeError for input item i.
func itemError(i int, err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		return landflow.ItemError(i, "%s", ae.Error()).WithDescription(ae.hint())
	}
	var ne *landflow.NodeError
	if errors.As(err, &ne) {
		cp := *ne
		cp.ItemIndex = &i
		return &cp
	}
	return landflow.ItemError(i, "%s", err.Error())
}

// userError is a NodeError without an item index (itemError adds it).
func userError(description, format string, args ...any) error {
	return landflow.NewNodeError(format, args...).WithDescription(description)
}

// requireString reads a required string parameter.
func requireString(ctx *landflow.ExecuteContext, name, display string, i int) (string, error) {
	v := strings.TrimSpace(ctx.ParamString(name, i, ""))
	if v == "" {
		return "", userError("Fill in "+display+".", "%s is required", display)
	}
	return v, nil
}

// ---------------------------------------------------------------------------
// Descriptor helpers
// ---------------------------------------------------------------------------

// show is displayOptions.show for a resource and (optionally) operations.
func show(resource string, operations ...string) *landflow.DisplayOptions {
	d := &landflow.DisplayOptions{Show: map[string][]any{"resource": {resource}}}
	if len(operations) > 0 {
		ops := make([]any, len(operations))
		for i, op := range operations {
			ops[i] = op
		}
		d.Show["operation"] = ops
	}
	return d
}

func resourceProperty(def string, options ...landflow.PropertyOption) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "resource", DisplayName: "Resource", Type: landflow.PropOptions, Default: def,
		NoDataExpression: true, Options: options,
	}
}

// operationProperty is the operation picker of one resource.
func operationProperty(resource, def string, options ...landflow.PropertyOption) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "operation", DisplayName: "Operation", Type: landflow.PropOptions, Default: def,
		NoDataExpression: true, Options: options, DisplayOptions: show(resource),
	}
}

// readOp is an operation option. Every operation here is a read, so each is idempotent. The Value must start with
// get, search, check or lookup: that is how the host derives the MCP readOnlyHint (packages/protocol/src/mcp-tools.ts).
func readOp(name, value, description, action string) landflow.PropertyOption {
	return landflow.PropertyOption{Name: name, Value: value, Description: description, Action: action, Idempotent: true}
}

func simplifyProperty(d *landflow.DisplayOptions, description string) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "simple", DisplayName: "Simplify", Type: landflow.PropBoolean, Default: true,
		Description: description, DisplayOptions: d,
	}
}

func stringProperty(name, display, description, placeholder string, d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: name, DisplayName: display, Type: landflow.PropString, Default: "", Required: true,
		Description: description, Placeholder: placeholder, DisplayOptions: d,
	}
}

// requireCredential is the node's credential requirement.
func requireCredential(name string) []landflow.NodeCredentialRequirement {
	return []landflow.NodeCredentialRequirement{{Name: name, Required: true}}
}

// serviceDescriptor fills the fields every service node shares.
func serviceDescriptor(name, display, description, toolDescription, doc string, keywords []string, cred string, props []landflow.PropertyDescriptor) landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:             name,
		DisplayName:      display,
		Description:      description,
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Security"},
		Icon:             "file:icons/threat-intel.svg",
		Color:            "#0F766E",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: doc,
		Keywords:         append([]string{"threat intel", "ioc", "security", "soc", "reputation"}, keywords...),
		Credentials:      requireCredential(cred),
		Idempotent:       true,
		UsableAsTool:     true,
		ToolDescription:  toolDescription,
		Capabilities:     []string{"ioc.lookup"},
		Properties:       props,
	}
}
