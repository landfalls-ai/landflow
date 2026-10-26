package transport

// Cross-language check against the TypeScript core (packages/transports): events sealed by one side open and verify on
// the other, in both CloudEvents modes, for requests, responses, announces and cancels; and the manifest hash agrees.
// Runs testdata/crosslang.mts with the repo's tsx; skipped when node or tsx is not available.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type crossSeal struct {
	Attributes map[string]string `json:"attributes"`
	Data       any               `json:"data"`
	Encrypt    bool              `json:"encrypt"`
	Mode       string            `json:"mode"`
	Claim      bool              `json:"claim,omitempty"`
}

type crossOpen struct {
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	Mode       string            `json:"mode"`
}

type crossOutput struct {
	Sealed []struct {
		Headers    map[string]string `json:"headers"`
		BodyBase64 string            `json:"bodyBase64"`
		Attributes map[string]string `json:"attributes"`
	} `json:"sealed"`
	Opened []struct {
		Attributes map[string]string `json:"attributes"`
		Data       any               `json:"data"`
		Error      string            `json:"error"`
	} `json:"opened"`
	ManifestHash string            `json:"manifestHash"`
	Claims       map[string]string `json:"claims"`
}

func findTSX(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	dir, _ := os.Getwd()
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "packages", "transports", "node_modules", ".bin", "tsx")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	t.Skip("packages/transports/node_modules/.bin/tsx not found (run pnpm install)")
	return ""
}

func runCrossLang(t *testing.T, input map[string]any) crossOutput {
	t.Helper()
	tsx := findTSX(t)
	in, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(tsx, "testdata/crosslang.mts")
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("tsx: %v\n%s", err, stderr.String())
	}
	var result crossOutput
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("bad output %s: %v", out, err)
	}
	return result
}

func attributesToMap(a Attributes) map[string]string { return a.Headers() }

func mapToAttributes(m map[string]string) Attributes {
	var a Attributes
	for k, v := range m {
		a.Set(k, v)
	}
	return a
}

type crossKind struct {
	name    string
	typ     string
	encrypt bool
	data    any
	extra   func(*Attributes)
}

func crossKinds(pluginID string) []crossKind {
	now := time.Now()
	return []crossKind{
		{"request", RequestType(MethodExecute), true, map[string]any{
			"protocol": "landflow.plugin/v1", "executionId": "exec-1", "mode": "manual",
			"node":        map[string]any{"id": "n1", "name": "echo", "type": pluginID + ".echo", "typeVersion": 1},
			"parameters":  map[string]any{"text": "<b>hi & bye</b>   ünïcödé"},
			"inputs":      []any{[]any{map[string]any{"json": map[string]any{"hello": "world", "n": 1.5}}}},
			"credentials": map[string]any{"api": map[string]any{"token": "top-secret-token"}},
		}, func(a *Attributes) {
			a.Source = HostSource("h1")
			a.Subject = pluginID + ".echo"
			a.LfReplyTo = "landflow.v1.reply.h1"
			a.LfDeadline = "1" + "793102430000"
			a.LfAttempt = "1"
			a.LfDelivery = AtMostOnce
			a.LfManifest = "0123456789abcdef"
			a.TraceParent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
		}},
		{"response", ResponseType(MethodExecute), true, map[string]any{"outputs": []any{[]any{map[string]any{"json": map[string]any{"ok": true}}}}}, func(a *Attributes) {
			a.Source = PluginSource(pluginID, "i1")
			a.LfCorrelation = "call-1"
			a.LfManifest = "0123456789abcdef"
			a.Subject = pluginID + ".echo"
		}},
		{"error-response", ResponseType(MethodHealth), true, map[string]any{"error": "no such node", "nodeType": "x"}, func(a *Attributes) {
			a.Source = PluginSource(pluginID, "i1")
			a.LfCorrelation = "call-2"
			a.LfError = CodeNotFound
		}},
		{"announce", AnnounceType, false, AnnounceBody{
			Protocol: ProtocolVersion, PluginID: pluginID, Version: "1.2.3", InstanceID: "i1", ManifestHash: "0123456789abcdef",
			Endpoint: "nats://env-nats/" + pluginID, MaxConcurrency: 4, TTLSeconds: 30, RegistryProof: RegistryProof("r", pluginID, "x"), Transports: []string{"http", "nats"},
		}, func(a *Attributes) {
			a.Source = PluginSource(pluginID, "i1")
			a.LfManifest = "0123456789abcdef"
		}},
		{"cancel", CancelType, false, map[string]any{"callId": "call-1", "reason": "user stopped <now>"}, func(a *Attributes) {
			a.Source = HostSource("h1")
			a.LfCorrelation = "call-1"
			a.Time = FormatTime(now)
		}},
	}
}

func baseAttributes(typ string, id string) Attributes {
	return Attributes{SpecVersion: CESpecVersion, ID: id, Type: typ, Time: FormatTime(time.Now()), DataContentType: JSONContentType}
}

func jsonRoundTrip(t *testing.T, v any) any {
	t.Helper()
	b, err := SerializeBody(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCrossLanguageTSSealsGoOpens(t *testing.T) {
	const pluginID = "cross-plugin"
	ring := MustKeyring(vecSecret)
	kinds := crossKinds(pluginID)
	var seal []crossSeal
	for _, mode := range []string{"binary", "structured"} {
		for _, k := range kinds {
			a := baseAttributes(k.typ, "ts-"+k.name+"-"+mode)
			k.extra(&a)
			seal = append(seal, crossSeal{Attributes: attributesToMap(a), Data: k.data, Encrypt: k.encrypt, Mode: mode})
		}
	}
	out := runCrossLang(t, map[string]any{"secret": vecSecret, "pluginId": pluginID, "seal": seal})
	if len(out.Sealed) != len(seal) {
		t.Fatalf("got %d sealed events", len(out.Sealed))
	}
	for i, s := range out.Sealed {
		k := kinds[i%len(kinds)]
		mode := seal[i].Mode
		body, _ := base64.StdEncoding.DecodeString(s.BodyBase64)
		wire := WireEvent{Headers: s.Headers, Body: body}
		caps := Capabilities{MaxMessageBytes: 1 << 20, Headers: mode == "binary"}
		codec := NewCodec(ring, caps, CodecOptions{})
		raw, err := codec.Peek(wire)
		if err != nil {
			t.Fatalf("%s/%s: peek: %v", k.name, mode, err)
		}
		if raw.Attributes.LfSig != s.Attributes["lfsig"] || raw.Attributes.LfKeyID != KeyIDOf(vecSecret) || (raw.Attributes.LfEnc != "") != k.encrypt {
			t.Fatalf("%s/%s: attributes %+v", k.name, mode, raw.Attributes)
		}
		opened, err := codec.Unpack(raw, pluginID)
		if err != nil {
			t.Fatalf("%s/%s: open: %v", k.name, mode, err)
		}
		var got any
		if err := ParseBody(opened.Body, &got); err != nil {
			t.Fatal(err)
		}
		if want := jsonRoundTrip(t, k.data); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s/%s: data\n got %v\nwant %v", k.name, mode, got, want)
		}
		// Go must also refuse it under the wrong plugin's keys and when tampered.
		if _, err := codec.Unpack(raw, "other-plugin"); err == nil {
			t.Fatalf("%s/%s: accepted under another plugin's key", k.name, mode)
		}
		if k.encrypt {
			tampered := raw
			tampered.Body = append([]byte(nil), raw.Body...)
			tampered.Body[len(tampered.Body)-1] ^= 1
			if _, err := codec.Unpack(tampered, pluginID); err == nil {
				t.Fatalf("%s/%s: accepted a tampered body", k.name, mode)
			}
		}
	}
}

func TestCrossLanguageGoSealsTSOpens(t *testing.T) {
	const pluginID = "cross-plugin"
	ring := MustKeyring(vecSecret)
	kinds := crossKinds(pluginID)
	var open []crossOpen
	var expected []any
	for _, mode := range []string{"binary", "structured"} {
		caps := Capabilities{MaxMessageBytes: 1 << 20, Headers: mode == "binary"}
		codec := NewCodec(ring, caps, CodecOptions{})
		for _, k := range kinds {
			a := baseAttributes(k.typ, "go-"+k.name+"-"+mode)
			k.extra(&a)
			packed, err := codec.Pack(pluginID, a, k.data, k.encrypt)
			if err != nil {
				t.Fatal(err)
			}
			open = append(open, crossOpen{Headers: packed.Wire.Headers, BodyBase64: base64.StdEncoding.EncodeToString(packed.Wire.Body), Mode: mode})
			expected = append(expected, jsonRoundTrip(t, k.data))
		}
	}
	// A tampered one and a foreign-key one must be refused by TS.
	codec := NewCodec(ring, Capabilities{MaxMessageBytes: 1 << 20, Headers: true}, CodecOptions{})
	a := baseAttributes(RequestType(MethodHealth), "go-tampered")
	a.Source = HostSource("h1")
	packed, _ := codec.Pack(pluginID, a, map[string]any{}, true)
	packed.Wire.Headers["lfdeadline"] = "1793102430000"
	open = append(open, crossOpen{Headers: packed.Wire.Headers, BodyBase64: base64.StdEncoding.EncodeToString(packed.Wire.Body), Mode: "binary"})
	foreign, _ := NewCodec(MustKeyring("another"), Capabilities{MaxMessageBytes: 1 << 20, Headers: true}, CodecOptions{}).Pack(pluginID, a, map[string]any{}, true)
	open = append(open, crossOpen{Headers: foreign.Wire.Headers, BodyBase64: base64.StdEncoding.EncodeToString(foreign.Wire.Body), Mode: "binary"})

	out := runCrossLang(t, map[string]any{"secret": vecSecret, "pluginId": pluginID, "open": open})
	if len(out.Opened) != len(open) {
		t.Fatalf("got %d opened events", len(out.Opened))
	}
	for i, o := range out.Opened[:len(expected)] {
		k := kinds[i%len(kinds)]
		if o.Error != "" {
			t.Fatalf("%s/%s: TS refused: %s", k.name, open[i].Mode, o.Error)
		}
		if !reflect.DeepEqual(o.Data, expected[i]) {
			t.Fatalf("%s/%s: data\n got %v\nwant %v", k.name, open[i].Mode, o.Data, expected[i])
		}
		if o.Attributes["type"] != k.typ || o.Attributes["lfkeyid"] != KeyIDOf(vecSecret) {
			t.Fatalf("%s/%s: attributes %v", k.name, open[i].Mode, o.Attributes)
		}
	}
	if out.Opened[len(expected)].Error == "" || out.Opened[len(expected)+1].Error == "" {
		t.Fatalf("TS accepted a tampered or foreign-key event: %+v", out.Opened[len(expected):])
	}
}

func TestCrossLanguageManifestHash(t *testing.T) {
	type option struct {
		Name       string `json:"name"`
		Value      any    `json:"value"`
		Idempotent bool   `json:"idempotent,omitempty"`
	}
	type property struct {
		Name    string   `json:"name"`
		Type    string   `json:"type"`
		Options []option `json:"options,omitempty"`
	}
	type node struct {
		Name        string     `json:"name"`
		DisplayName string     `json:"displayName"`
		Description string     `json:"description"`
		Version     float64    `json:"version"`
		Properties  []property `json:"properties"`
		Idempotent  bool       `json:"idempotent,omitempty"`
	}
	type manifest struct {
		Protocol string `json:"protocol"`
		Plugin   struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"plugin"`
		Nodes          []node `json:"nodes"`
		MaxConcurrency int    `json:"maxConcurrency,omitempty"`
	}
	var m manifest
	m.Protocol = "landflow.plugin/v1"
	m.Plugin.ID, m.Plugin.Name, m.Plugin.Version = "cross-plugin", "Cross <&> plugin", "0.1.0"
	m.Nodes = []node{{Name: "echo", DisplayName: "Echo", Description: "says \"hi\" & more", Version: 1.5, Properties: []property{{Name: "operation", Type: "options", Options: []option{{Name: "Get", Value: "get", Idempotent: true}, {Name: "Put", Value: 2}}}}}}
	m.MaxConcurrency = 8
	goHash, err := ManifestHashOf(m)
	if err != nil {
		t.Fatal(err)
	}
	var asJSON any
	if err := json.Unmarshal(MustSerializeBody(m), &asJSON); err != nil {
		t.Fatal(err)
	}
	out := runCrossLang(t, map[string]any{"secret": vecSecret, "pluginId": "cross-plugin", "manifest": json.RawMessage(MustSerializeBody(m))})
	if out.ManifestHash != goHash {
		t.Fatalf("manifest hash: go %s ts %s", goHash, out.ManifestHash)
	}
	idem := IdempotencyFromManifest(m)
	if !idem(json.RawMessage(`{"node":{"type":"cross-plugin.echo"},"parameters":{"operation":"get"}}`)) || idem(json.RawMessage(`{"node":{"type":"cross-plugin.echo"},"parameters":{"operation":"put"}}`)) || idem(json.RawMessage(`{"node":{"type":"cross-plugin.echo"}}`)) {
		t.Fatal("idempotency from manifest")
	}
	_ = asJSON
}

// The claim check: a body too big for the broker (4 KiB here) goes by reference. TS seals a request and a response with a
// claim store, Go resolves and opens them; Go seals them, TS resolves and opens them. The reference is signed on both sides.
func TestCrossLanguageClaimCheck(t *testing.T) {
	const pluginID = "cross-plugin"
	ring := MustKeyring(vecSecret)
	blob := strings.Repeat("x", 20000)
	request := map[string]any{"node": map[string]any{"type": pluginID + ".echo"}, "inputs": []any{[]any{map[string]any{"json": map[string]any{"blob": blob}}}}, "credentials": map[string]any{"api": map[string]any{"token": "top-secret-token"}}}
	response := map[string]any{"outputs": []any{[]any{map[string]any{"json": map[string]any{"blob": blob}}}}}
	type claimKind struct {
		name  string
		typ   string
		data  any
		extra func(*Attributes)
	}
	kinds := []claimKind{
		{"request", RequestType(MethodExecute), request, func(a *Attributes) {
			a.Source = HostSource("h1")
			a.LfDeadline = "1793102430000"
			a.LfDelivery = AtLeastOnce
		}},
		{"response", ResponseType(MethodExecute), response, func(a *Attributes) {
			a.Source = PluginSource(pluginID, "i1")
			a.LfCorrelation = "call-1"
		}},
	}
	for _, mode := range []string{"binary", "structured"} {
		caps := Capabilities{MaxMessageBytes: 4096, Headers: mode == "binary"}

		// TS seals, Go resolves and opens.
		var seal []crossSeal
		for _, k := range kinds {
			a := baseAttributes(k.typ, "ts-claim-"+k.name+"-"+mode)
			k.extra(&a)
			seal = append(seal, crossSeal{Attributes: attributesToMap(a), Data: k.data, Encrypt: true, Mode: mode, Claim: true})
		}
		out := runCrossLang(t, map[string]any{"secret": vecSecret, "pluginId": pluginID, "seal": seal})
		store := NewMemoryClaimStore()
		for key, b64 := range out.Claims {
			body, _ := base64.StdEncoding.DecodeString(b64)
			store.Set(key, body)
		}
		codec := NewCodec(ring, caps, CodecOptions{Claims: store})
		if len(out.Sealed) != len(kinds) || len(out.Claims) != len(kinds) {
			t.Fatalf("%s: %d sealed, %d claims", mode, len(out.Sealed), len(out.Claims))
		}
		for i, s := range out.Sealed {
			body, _ := base64.StdEncoding.DecodeString(s.BodyBase64)
			raw, err := codec.Peek(WireEvent{Headers: s.Headers, Body: body})
			if err != nil {
				t.Fatalf("%s/%s: peek: %v", kinds[i].name, mode, err)
			}
			if raw.Attributes.LfClaim == "" || len(body) > 1000 && mode == "binary" {
				t.Fatalf("%s/%s: not a reference: %+v (%d body bytes)", kinds[i].name, mode, raw.Attributes, len(body))
			}
			resolved, key, err := codec.ResolveClaim(context.Background(), raw, pluginID)
			if err != nil || key != raw.Attributes.LfClaim {
				t.Fatalf("%s/%s: resolve: %v", kinds[i].name, mode, err)
			}
			opened, err := codec.Unpack(resolved, pluginID)
			if err != nil {
				t.Fatalf("%s/%s: open: %v", kinds[i].name, mode, err)
			}
			var got any
			if err := ParseBody(opened.Body, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, jsonRoundTrip(t, kinds[i].data)) {
				t.Fatalf("%s/%s: data differs", kinds[i].name, mode)
			}
			// A swapped reference must fail the signature before the store is touched.
			swapped := raw
			swapped.Attributes.LfClaim = ClaimKeyFor(time.UnixMilli(1), "swapped")
			if _, _, err := codec.ResolveClaim(context.Background(), swapped, pluginID); err == nil {
				t.Fatalf("%s/%s: a swapped reference was accepted", kinds[i].name, mode)
			}
		}

		// Go seals, TS resolves and opens.
		goStore := NewMemoryClaimStore()
		goCodec := NewCodec(ring, caps, CodecOptions{Claims: goStore})
		var open []crossOpen
		for _, k := range kinds {
			a := baseAttributes(k.typ, "go-claim-"+k.name+"-"+mode)
			k.extra(&a)
			packed, err := goCodec.PackBodyClaimedAny(context.Background(), pluginID, a, k.data, true)
			if err != nil || packed.ClaimKey == "" {
				t.Fatalf("%s/%s: pack: %v", k.name, mode, err)
			}
			open = append(open, crossOpen{Headers: packed.Wire.Headers, BodyBase64: base64.StdEncoding.EncodeToString(packed.Wire.Body), Mode: mode})
		}
		claims := map[string]string{}
		for _, key := range goStore.Keys("claims/") {
			claims[key] = base64.StdEncoding.EncodeToString(goStore.Object(key))
		}
		res := runCrossLang(t, map[string]any{"secret": vecSecret, "pluginId": pluginID, "open": open, "claims": claims})
		for i, o := range res.Opened {
			if o.Error != "" {
				t.Fatalf("%s/%s: TS refused: %s", kinds[i].name, mode, o.Error)
			}
			if !reflect.DeepEqual(o.Data, jsonRoundTrip(t, kinds[i].data)) || o.Attributes["lfclaim"] == "" {
				t.Fatalf("%s/%s: TS read %v", kinds[i].name, mode, o.Attributes)
			}
		}
	}
}
