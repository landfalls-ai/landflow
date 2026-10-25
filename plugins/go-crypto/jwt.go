package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// JWTDecodeNode decodes a JSON Web Token without verifying it.
type JWTDecodeNode struct{}

// now is replaceable in tests.
var now = time.Now

func (JWTDecodeNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:        "jwtDecode",
		DisplayName: "JWT Decode",
		Description: "Decode a JWT's header and payload (the signature is not verified)",
		Version:     landflow.V(1),
		Kind:        landflow.KindAction,
		Categories:  []string{"Crypto"},
		Icon:        "file:icons/jwt-decode.svg",
		Color:       "#14b8a6",
		Inputs:      []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Keywords:    []string{"jwt", "token", "claims", "bearer", "decode", "exp"},

		UsableAsTool: true,
		ToolDescription: "Decode a JSON Web Token (JWT) WITHOUT verifying its signature. Pass the token in `token` " +
			"(a leading \"Bearer \" is fine). Returns `jwt.header`, `jwt.payload` (the claims), `jwt.expiresAt` " +
			"(ISO 8601, from the exp claim, or null) and `jwt.expired`. Use it to inspect claims only; never treat " +
			"the result as proof that the token is authentic.",
		ToolInputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"token": map[string]any{"type": "string", "description": "The JWT to decode"},
			},
			"required": []string{"token"},
		},

		Properties: []landflow.PropertyDescriptor{
			{
				Name: "notice", Type: landflow.PropNotice, Default: "",
				DisplayName: "The signature is NOT verified. Decoded claims can be forged — never use them on their own for authentication or authorization decisions.",
			},
			{
				Name: "field", DisplayName: "Token Field", Type: landflow.PropString, Default: "token", Required: true,
				Description: "Input field holding the JWT. A leading \"Bearer \" is stripped.",
			},
			{
				Name: "outputField", DisplayName: "Output Field", Type: landflow.PropString, Default: "jwt",
				Description: "Field that receives { header, payload, expiresAt, expired, signatureVerified }",
			},
		},
	}
}

func (JWTDecodeNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	out := make([]landflow.Item, 0, len(items))
	expired := 0
	for i, item := range items {
		field := ctx.ParamString("field", i, "token")
		outputField := ctx.ParamString("outputField", i, "jwt")
		value, ok := lookupField(item.JSON, field)
		if !ok {
			return nil, landflow.ItemError(i, "Field %q not found in item %d", field, i)
		}
		token, ok := value.(string)
		if !ok {
			return nil, landflow.ItemError(i, "Field %q must be a string holding a JWT", field)
		}
		decoded, err := decodeJWT(token)
		if err != nil {
			return nil, landflow.ItemError(i, "Invalid JWT in field %q", field).WithDescription(err.Error())
		}
		if decoded["expired"] == true {
			expired++
		}
		next := cloneJSON(item.JSON)
		next[outputField] = decoded
		out = append(out, landflow.Item{JSON: next})
	}
	ctx.Logger.Info("decoded %d token(s), %d expired; signatures NOT verified", len(out), expired)
	return [][]landflow.Item{out}, nil
}

func decodeJWT(token string) (map[string]any, error) {
	token = strings.TrimSpace(token)
	if len(token) > 7 && strings.EqualFold(token[:7], "bearer ") {
		token = strings.TrimSpace(token[7:])
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("expected 3 dot-separated segments (header.payload.signature), got %d", len(parts))
	}
	header, err := decodeSegment(parts[0])
	if err != nil {
		return nil, fmt.Errorf("header: %w", err)
	}
	payload, err := decodeSegment(parts[1])
	if err != nil {
		return nil, fmt.Errorf("payload: %w", err)
	}

	result := map[string]any{
		"header":            header,
		"payload":           payload,
		"expiresAt":         nil,
		"expired":           false,
		"signatureVerified": false,
	}
	if raw, ok := payload["exp"]; ok && raw != nil {
		exp, err := numericDate(raw)
		if err != nil {
			return nil, fmt.Errorf("exp claim: %w", err)
		}
		result["expiresAt"] = exp.UTC().Format(time.RFC3339)
		result["expired"] = !now().Before(exp)
	}
	return result, nil
}

func decodeSegment(seg string) (map[string]any, error) {
	seg = strings.TrimRight(seg, "=")
	data, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		if data, err = base64.RawStdEncoding.DecodeString(seg); err != nil {
			return nil, fmt.Errorf("not base64url: %v", err)
		}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, fmt.Errorf("not a JSON object")
	}
	return obj, nil
}

// numericDate parses a JWT NumericDate (seconds since the epoch, possibly
// fractional; tolerate numeric strings).
func numericDate(v any) (time.Time, error) {
	var secs float64
	switch t := v.(type) {
	case float64:
		secs = t
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("%q is not a NumericDate", t)
		}
		secs = f
	default:
		return time.Time{}, fmt.Errorf("unexpected type %T", v)
	}
	if math.IsNaN(secs) || math.IsInf(secs, 0) || math.Abs(secs) > 1e13 {
		return time.Time{}, fmt.Errorf("%v is out of range", secs)
	}
	whole, frac := math.Modf(secs)
	return time.Unix(int64(whole), int64(frac*1e9)), nil
}
