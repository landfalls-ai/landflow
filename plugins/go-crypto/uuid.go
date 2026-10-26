package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

	landflow "github.com/landflow/landflow/sdks/go"
)

// UUIDNode adds random (version 4) UUIDs to items or generates new items.
type UUIDNode struct{}

const maxUUIDs = 1000

// newUUIDv4 returns an RFC 9562 version-4 UUID from crypto/rand.
func newUUIDv4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
	var buf [36]byte
	hex.Encode(buf[0:8], b[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], b[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], b[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], b[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:], b[10:])
	return string(buf[:]), nil
}

func (UUIDNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:        "uuid",
		DisplayName: "UUID",
		Description: "Add a random UUID (v4) to every item, or generate new items holding UUIDs",
		Version:     landflow.V(1),
		Kind:        landflow.KindAction,
		Idempotent:  true, // no side effects: a repeat only draws another random value
		Categories:  []string{"Crypto"},
		Icon:        "file:icons/uuid.svg",
		Color:       "#2dd4bf",
		Subtitle:    "{{mode}}",
		Inputs:      []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Keywords:    []string{"uuid", "guid", "random", "identifier", "id"},

		UsableAsTool: true,
		ToolDescription: "Generate random RFC 9562 version-4 UUIDs. To get several, set `mode` to \"generate\" and " +
			"`count` to how many you need (max 1000); each result item has a `uuid` field. " +
			"With the default mode a single `uuid` is returned.",
		ToolInputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"mode":  map[string]any{"type": "string", "enum": []string{"addToItems", "generate"}, "default": "addToItems"},
				"count": map[string]any{"type": "integer", "minimum": 1, "maximum": maxUUIDs, "default": 1, "description": "How many UUIDs (generate mode)"},
			},
		},

		Properties: []landflow.PropertyDescriptor{
			{
				Name: "mode", DisplayName: "Mode", Type: landflow.PropOptions, Default: "addToItems", NoDataExpression: true,
				Options: []landflow.PropertyOption{
					{Name: "Add to Items", Value: "addToItems", Description: "Add a UUID field to every incoming item", Action: "Add a UUID to each item"},
					{Name: "Generate", Value: "generate", Description: "Emit new items, one UUID each", Action: "Generate UUIDs"},
				},
			},
			{
				Name: "count", DisplayName: "Count", Type: landflow.PropNumber, Default: 1,
				Description: "How many UUIDs to generate",
				TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(float64(maxUUIDs)), NumberPrecision: landflow.Ptr(0)},
				DisplayOptions: &landflow.DisplayOptions{
					Show: map[string][]any{"mode": {"generate"}},
				},
			},
			{
				Name: "outputField", DisplayName: "Output Field", Type: landflow.PropString, Default: "uuid",
				Description: "Field that receives the UUID",
			},
		},
	}
}

func (UUIDNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	mode := ctx.ParamString("mode", 0, "addToItems")

	switch mode {
	case "generate":
		count := ctx.ParamInt("count", 0, 1)
		if count < 1 || count > maxUUIDs {
			return nil, landflow.NewNodeError("Count must be between 1 and %d, got %d", maxUUIDs, count)
		}
		field := ctx.ParamString("outputField", 0, "uuid")
		var paired *landflow.PairedItem
		if len(items) > 0 {
			paired = &landflow.PairedItem{Item: 0} // all generated items stem from the first input
		}
		out := make([]landflow.Item, 0, count)
		for n := 0; n < count; n++ {
			id, err := newUUIDv4()
			if err != nil {
				return nil, fmt.Errorf("read random bytes: %w", err)
			}
			out = append(out, landflow.Item{JSON: map[string]any{field: id}, PairedItem: paired})
		}
		ctx.Logger.Info("generated %d UUID(s)", count)
		return [][]landflow.Item{out}, nil

	case "addToItems":
		out := make([]landflow.Item, 0, len(items))
		for i, item := range items {
			id, err := newUUIDv4()
			if err != nil {
				return nil, fmt.Errorf("read random bytes: %w", err)
			}
			next := cloneJSON(item.JSON)
			next[ctx.ParamString("outputField", i, "uuid")] = id
			out = append(out, landflow.Item{JSON: next})
		}
		ctx.Logger.Info("added a UUID to %d item(s)", len(out))
		return [][]landflow.Item{out}, nil
	}
	return nil, landflow.NewNodeError("Unknown mode %q", mode).WithDescription("Use addToItems or generate.")
}
