package main

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Base64Node encodes or decodes a field.
type Base64Node struct{}

func (Base64Node) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:        "base64",
		DisplayName: "Base64",
		Description: "Encode a field to Base64 or decode it back to text",
		Version:     landflow.V(1),
		Kind:        landflow.KindAction,
		Categories:  []string{"Crypto"},
		Icon:        "file:icons/base64.svg",
		Color:       "#06b6d4",
		Subtitle:    "{{operation}}",
		Inputs:      []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Keywords:    []string{"base64", "encode", "decode", "btoa", "atob"},
		Properties: []landflow.PropertyDescriptor{
			{
				Name: "operation", DisplayName: "Operation", Type: landflow.PropOptions, Default: "encode", NoDataExpression: true,
				Options: []landflow.PropertyOption{
					{Name: "Encode", Value: "encode", Description: "Text → Base64", Action: "Encode a field to Base64"},
					{Name: "Decode", Value: "decode", Description: "Base64 → text", Action: "Decode a Base64 field"},
				},
			},
			{
				Name: "field", DisplayName: "Field", Type: landflow.PropString, Default: "value", Required: true,
				Description: "Input field to transform. Dots reach nested fields; non-string values are encoded as JSON.",
			},
			{
				Name: "urlSafe", DisplayName: "URL-Safe Alphabet", Type: landflow.PropBoolean, Default: false,
				Description:    "Use - and _ instead of + and / and drop the padding (RFC 4648 §5)",
				DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": {"encode"}}},
			},
			{
				Name: "outputField", DisplayName: "Output Field", Type: landflow.PropString, Default: "",
				Placeholder: "same as Field", Hint: "Leave empty to overwrite the input field",
			},
		},
	}
}

func (Base64Node) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	operation := ctx.ParamString("operation", 0, "encode")
	if operation != "encode" && operation != "decode" {
		return nil, landflow.NewNodeError("Unknown operation %q", operation).WithDescription("Use encode or decode.")
	}
	out := make([]landflow.Item, 0, len(items))
	for i, item := range items {
		field := ctx.ParamString("field", i, "value")
		outputField := ctx.ParamString("outputField", i, "")
		if outputField == "" {
			outputField = field
		}
		value, ok := lookupField(item.JSON, field)
		if !ok {
			return nil, landflow.ItemError(i, "Field %q not found in item %d", field, i)
		}

		var result string
		if operation == "encode" {
			data, err := valueBytes(value)
			if err != nil {
				return nil, landflow.ItemError(i, "Cannot encode field %q: %v", field, err)
			}
			if ctx.ParamBool("urlSafe", i, false) {
				result = base64.RawURLEncoding.EncodeToString(data)
			} else {
				result = base64.StdEncoding.EncodeToString(data)
			}
		} else {
			text, ok := value.(string)
			if !ok {
				return nil, landflow.ItemError(i, "Field %q must be a Base64 string to decode", field)
			}
			data, err := decodeBase64(text)
			if err != nil {
				return nil, landflow.ItemError(i, "Field %q is not valid Base64", field).WithDescription(err.Error())
			}
			if !utf8.Valid(data) {
				return nil, landflow.ItemError(i, "Decoded value of %q is binary, not UTF-8 text", field)
			}
			result = string(data)
		}
		next := cloneJSON(item.JSON)
		next[outputField] = result
		out = append(out, landflow.Item{JSON: next})
	}
	ctx.Logger.Info("%sd %d item(s)", operation, len(out))
	return [][]landflow.Item{out}, nil
}

// decodeBase64 accepts the standard and URL-safe alphabets, padded or not,
// and ignores surrounding whitespace and line breaks.
func decodeBase64(s string) ([]byte, error) {
	s = strings.Join(strings.Fields(s), "")
	s = strings.TrimRight(s, "=")
	if strings.ContainsAny(s, "-_") {
		return base64.RawURLEncoding.DecodeString(s)
	}
	return base64.RawStdEncoding.DecodeString(s)
}
