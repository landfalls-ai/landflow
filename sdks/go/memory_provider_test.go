package landflow

import (
	"encoding/json"
	"strings"
	"testing"
)

// The memoryProvider flag survives a JSON round trip and is left out when unset (C07).
func TestMemoryProviderFlagRoundTrips(t *testing.T) {
	d := NodeDescriptor{Name: "vecmem", DisplayName: "Vec", Description: "d", Version: V(1), MemoryProvider: true}
	b, err := json.Marshal(d)
	if err != nil || !strings.Contains(string(b), `"memoryProvider":true`) {
		t.Fatalf("marshal: %v %s", err, b)
	}
	var back NodeDescriptor
	if err := json.Unmarshal(b, &back); err != nil || !back.MemoryProvider {
		t.Fatalf("unmarshal: %v %+v", err, back)
	}
	b, _ = json.Marshal(NodeDescriptor{Name: "n", DisplayName: "N", Description: "d", Version: V(1)})
	if strings.Contains(string(b), "memoryProvider") {
		t.Fatalf("flag should be omitted: %s", b)
	}
}
