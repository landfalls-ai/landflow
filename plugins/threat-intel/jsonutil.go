package main

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Helpers for reading the loosely typed JSON the services answer with.

// dig follows keys through nested objects; a numeric key indexes an array. nil when the path is missing.
func dig(v any, keys ...string) any {
	for _, k := range keys {
		switch t := v.(type) {
		case map[string]any:
			v = t[k]
		case []any:
			i, err := strconv.Atoi(k)
			if err != nil || i < 0 || i >= len(t) {
				return nil
			}
			v = t[i]
		default:
			return nil
		}
	}
	return v
}

// str returns v when it is a string, else "".
func str(v any) string {
	s, _ := v.(string)
	return s
}

// num returns v as a number (JSON numbers, json.Number and numeric strings).
func num(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

func intOf(v any) int {
	f, _ := num(v)
	return int(f)
}

func boolOf(v any) bool {
	b, _ := v.(bool)
	return b
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// stringList returns the string elements of an array.
func stringList(v any) []string {
	var out []string
	for _, e := range list(v) {
		if s := str(e); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// toMap converts any JSON-encodable value into the map form items carry.
func toMap(v any) map[string]any {
	data, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil || m == nil {
		return map[string]any{}
	}
	return m
}

// clamp100 rounds f into 0..100.
func clamp100(f float64) int {
	switch {
	case f < 0:
		return 0
	case f > 100:
		return 100
	}
	return int(f + 0.5)
}

func ptr[T any](v T) *T { return &v }

// idString formats an identifier the API may send as a string or a number.
func idString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return ""
}

// asMap returns a collection parameter as a map (empty when unset). A JSON string is accepted too.
func asMap(v any) map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return t
	case string:
		var m map[string]any
		if json.Unmarshal([]byte(t), &m) == nil && m != nil {
			return m
		}
	}
	return map[string]any{}
}
