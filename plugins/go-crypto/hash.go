package main

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"hash"
	"maps"
	"slices"

	landflow "github.com/landflow/landflow/sdks/go"
)

// HashNode hashes the value of a field.
type HashNode struct{}

var hashAlgorithms = []landflow.PropertyOption{
	{Name: "SHA-256", Value: "sha256", Description: "256-bit SHA-2 digest (recommended)"},
	{Name: "SHA-1", Value: "sha1", Description: "160-bit digest; legacy, not collision-resistant"},
	{Name: "SHA-512", Value: "sha512", Description: "512-bit SHA-2 digest"},
	{Name: "MD5", Value: "md5", Description: "128-bit digest; checksums only, not secure"},
}

func newHash(algorithm string) (hash.Hash, bool) {
	switch algorithm {
	case "sha256":
		return sha256.New(), true
	case "sha1":
		return sha1.New(), true
	case "sha512":
		return sha512.New(), true
	case "md5":
		return md5.New(), true
	}
	return nil, false
}

func (HashNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:        "hash",
		DisplayName: "Hash",
		Description: "Hash a field with SHA-256, SHA-1, SHA-512 or MD5",
		Version:     landflow.V(1),
		Kind:        landflow.KindAction,
		Idempotent:  true, // pure transform: no side effects, a repeat gives the same result
		Categories:  []string{"Crypto"},
		Icon:        "file:icons/hash.svg",
		Color:       "#22d3ee",
		Subtitle:    "{{algorithm}}",
		Inputs:      []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Keywords:    []string{"digest", "checksum", "sha256", "sha1", "sha512", "md5", "fingerprint"},

		UsableAsTool: true,
		ToolDescription: "Compute a cryptographic digest of a text. Pass the text in `value`; optionally choose " +
			"`algorithm` (sha256 default, sha1, sha512, md5) and `encoding` (hex default, base64). " +
			"Returns the digest in the `hash` field. Use it for checksums, fingerprints or cache keys; " +
			"it is a one-way function and cannot be reversed.",
		ToolInputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"value":     map[string]any{"type": "string", "description": "The text to hash"},
				"algorithm": map[string]any{"type": "string", "enum": []string{"sha256", "sha1", "sha512", "md5"}, "default": "sha256"},
				"encoding":  map[string]any{"type": "string", "enum": []string{"hex", "base64"}, "default": "hex"},
			},
			"required": []string{"value"},
		},

		Properties: []landflow.PropertyDescriptor{
			{
				Name: "algorithm", DisplayName: "Algorithm", Type: landflow.PropOptions, Default: "sha256",
				Description: "Digest algorithm",
				Options:     hashAlgorithms,
				TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "algorithms"},
			},
			{
				Name: "field", DisplayName: "Field", Type: landflow.PropString, Default: "value", Required: true,
				Placeholder: "value",
				Description: "Input field to hash. Dots reach nested fields (user.email); non-string values are hashed as JSON.",
			},
			{
				Name: "encoding", DisplayName: "Encoding", Type: landflow.PropOptions, Default: "hex",
				Options: []landflow.PropertyOption{
					{Name: "Hex", Value: "hex", Description: "Lower-case hexadecimal"},
					{Name: "Base64", Value: "base64", Description: "Standard Base64 with padding"},
				},
			},
			{
				Name: "outputField", DisplayName: "Output Field", Type: landflow.PropString, Default: "hash",
				Description: "Field that receives the digest",
			},
		},
	}
}

func (HashNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	out := make([]landflow.Item, 0, len(items))
	byAlgorithm := map[string]int{}
	// One child span for the batch; its duration is the hashing work alone.
	err := ctx.Span("crypto.hash", landflow.Attrs{"crypto.items": len(items)}, func(span landflow.Span) error {
		for i, item := range items {
			algorithm := ctx.ParamString("algorithm", i, "sha256")
			field := ctx.ParamString("field", i, "value")
			encoding := ctx.ParamString("encoding", i, "hex")
			outputField := ctx.ParamString("outputField", i, "hash")

			h, ok := newHash(algorithm)
			if !ok {
				return landflow.ItemError(i, "Unsupported algorithm %q", algorithm).
					WithDescription("Choose sha256, sha1, sha512 or md5.")
			}
			value, ok := lookupField(item.JSON, field)
			if !ok {
				return landflow.ItemError(i, "Field %q not found in item %d", field, i).
					WithDescription("Set “Field” to the name of an input field, e.g. value or user.email.")
			}
			data, err := valueBytes(value)
			if err != nil {
				return landflow.ItemError(i, "Cannot hash field %q: %v", field, err)
			}
			h.Write(data)
			sum := h.Sum(nil)

			var digest string
			switch encoding {
			case "hex":
				digest = hex.EncodeToString(sum)
			case "base64":
				digest = base64.StdEncoding.EncodeToString(sum)
			default:
				return landflow.ItemError(i, "Unsupported encoding %q", encoding).WithDescription("Choose hex or base64.")
			}

			next := cloneJSON(item.JSON)
			next[outputField] = digest
			out = append(out, landflow.Item{JSON: next})
			byAlgorithm[algorithm]++
		}
		span.SetAttribute("crypto.algorithms", slices.Sorted(maps.Keys(byAlgorithm)))
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Custom metric: crypto_hashes_total{crypto_algorithm="sha256",…} on /metrics.
	hashes := ctx.Metrics().Counter("crypto.hashes", landflow.WithDescription("Values hashed, by algorithm"))
	for algorithm, n := range byAlgorithm {
		hashes.Add(float64(n), landflow.Attrs{"crypto.algorithm": algorithm})
	}
	ctx.Logger.Info("hashed %d item(s) with %s", len(out), ctx.ParamString("algorithm", 0, "sha256"))
	return [][]landflow.Item{out}, nil
}

// LoadOptions serves typeOptions.loadOptionsMethod = "algorithms".
func (HashNode) LoadOptions(method string, _ map[string]any) ([]landflow.PropertyOption, error) {
	switch method {
	case "algorithms":
		return append([]landflow.PropertyOption(nil), hashAlgorithms...), nil
	}
	return nil, fmt.Errorf("unknown loadOptions method %q (supported: algorithms)", method)
}
