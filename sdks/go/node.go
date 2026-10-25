package landflow

import (
	"errors"
	"fmt"
)

// Node is implemented by every node type a plugin hosts.
//
// Description is called once by NewPlugin; the result is validated and cached.
// Execute may be called concurrently from several requests, so implementations
// must not keep per-execution state on the receiver.
type Node interface {
	Description() NodeDescriptor
	// Execute runs the node over the items in ctx.InputData(0) (and further
	// inputs if the node declares them) and returns outputs[i] = items for
	// main output i. Return a *NodeError (or NodeError) for a user-facing
	// failure; any other error becomes error.message.
	Execute(ctx *ExecuteContext) ([][]Item, error)
}

// OptionsLoader is optionally implemented by nodes that serve dynamic dropdowns
// (properties with typeOptions.loadOptionsMethod).
type OptionsLoader interface {
	LoadOptions(method string, params map[string]any) ([]PropertyOption, error)
}

// NodeError is a user-facing node failure. Return it (by value or pointer)
// from Execute to populate ExecuteResponse.error.
type NodeError struct {
	Message     string
	Description string
	// ItemIndex points at the offending input item; nil when the failure is
	// not item-specific.
	ItemIndex *int
}

func (e NodeError) Error() string {
	if e.Description != "" {
		return e.Message + ": " + e.Description
	}
	return e.Message
}

// NewNodeError builds a NodeError that is not tied to an item.
func NewNodeError(format string, args ...any) *NodeError {
	return &NodeError{Message: sprintf(format, args...)}
}

// ItemError builds a NodeError for input item itemIndex.
func ItemError(itemIndex int, format string, args ...any) *NodeError {
	return &NodeError{Message: sprintf(format, args...), ItemIndex: &itemIndex}
}

// WithDescription returns a copy of e with Description set.
func (e *NodeError) WithDescription(description string) *NodeError {
	c := *e
	c.Description = description
	return &c
}

// errorPayload converts any error into the wire form.
func errorPayload(err error) *NodeErrorPayload {
	var ptr *NodeError
	if errors.As(err, &ptr) && ptr != nil {
		return &NodeErrorPayload{Message: ptr.Message, Description: ptr.Description, ItemIndex: ptr.ItemIndex}
	}
	var val NodeError
	if errors.As(err, &val) {
		return &NodeErrorPayload{Message: val.Message, Description: val.Description, ItemIndex: val.ItemIndex}
	}
	msg := err.Error()
	if msg == "" {
		msg = "node failed"
	}
	return &NodeErrorPayload{Message: msg}
}

func sprintf(format string, args ...any) string {
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}
