package main

import (
	"encoding/json"
	"strings"
)

// Small helpers shared by the nodes.

// cloneJSON returns a shallow copy so nodes never mutate their input items.
func cloneJSON(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	return out
}

// lookupField finds a field by exact key first, then by dot path ("user.email").
func lookupField(obj map[string]any, path string) (any, bool) {
	if v, ok := obj[path]; ok {
		return v, true
	}
	if !strings.Contains(path, ".") {
		return nil, false
	}
	var cur any = obj
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[part]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// valueBytes turns a JSON value into the bytes to hash/encode: strings as
// UTF-8, everything else as compact JSON.
func valueBytes(v any) ([]byte, error) {
	if s, ok := v.(string); ok {
		return []byte(s), nil
	}
	return json.Marshal(v)
}
