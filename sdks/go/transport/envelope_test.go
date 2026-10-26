package transport

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestParseType(t *testing.T) {
	cases := map[string]ParsedType{
		"dev.landflow.plugin.v1.execute.request":   {Kind: KindRequest, Method: MethodExecute},
		"dev.landflow.plugin.v1.health.response":   {Kind: KindResponse, Method: MethodHealth},
		"dev.landflow.plugin.v1.cancel":            {Kind: KindCancel},
		"dev.landflow.plugin.v1.announce":          {Kind: KindAnnounce},
		"dev.landflow.plugin.v1.withdraw":          {Kind: KindWithdraw},
		"dev.landflow.plugin.v1.receivewebhook.re": {},
		"dev.landflow.plugin.v2.execute.request":   {},
		"dev.landflow.plugin.v1.nope.request":      {},
	}
	for typ, want := range cases {
		got, ok := ParseType(typ)
		if ok != (want.Kind != "") || got != want {
			t.Errorf("%s: got %+v ok=%v", typ, got, ok)
		}
	}
	if RequestType(MethodLoadOptions) != "dev.landflow.plugin.v1.loadoptions.request" || ResponseType(MethodTestCredentials) != "dev.landflow.plugin.v1.testcredentials.response" {
		t.Fatal("types")
	}
}

func TestEncodeDecodeBinary(t *testing.T) {
	raw := RawEvent{Attributes: vecAttributes(), Body: []byte(`{"a":1}`)}
	raw.Attributes.LfKeyID = "9a5c85f5715d1126"
	raw.Attributes.LfSig = string(bytes.Repeat([]byte("a"), 64))
	wire, size, err := EncodeWire(raw, ModeBinary)
	if err != nil {
		t.Fatal(err)
	}
	if wire.Headers["content-type"] != "application/json" || wire.Headers["lfdelivery"] != "at-least-once" || wire.Headers["subject"] != "" {
		t.Fatalf("headers %v", wire.Headers)
	}
	if size.BodyBytes != 7 || size.TotalBytes != size.HeaderBytes+7 {
		t.Fatalf("size %+v", size)
	}
	// Mixed-case header names, an unknown header and an extra content-type parameter are tolerated.
	wire.Headers["LfDeadline"] = wire.Headers["lfdeadline"]
	delete(wire.Headers, "lfdeadline")
	wire.Headers["x-broker-thing"] = "ignored"
	wire.Headers["content-type"] = "application/json; charset=utf-8"
	decoded, err := DecodeWire(wire, DecodeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Attributes != raw.Attributes || string(decoded.Body) != `{"a":1}` {
		t.Fatalf("round trip: %+v", decoded.Attributes)
	}
	if _, err := DecodeWire(wire, DecodeOptions{Strict: true}); err == nil {
		t.Fatal("strict must refuse unknown headers")
	}
	if _, err := DecodeWire(wire, DecodeOptions{MaxBytes: 10}); err == nil {
		t.Fatal("max bytes")
	}
	var ee *EnvelopeError
	wire.Headers["content-type"] = "text/plain"
	if _, err := DecodeWire(wire, DecodeOptions{}); !errors.As(err, &ee) || ee.Reason != ReasonMalformed {
		t.Fatalf("content-type mismatch: %v", err)
	}
}

func TestEncodeDecodeStructured(t *testing.T) {
	attrs := vecAttributes()
	attrs.LfKeyID = "9a5c85f5715d1126"
	attrs.LfSig = string(bytes.Repeat([]byte("b"), 64))
	plain := RawEvent{Attributes: attrs, Body: []byte(`{"a":[1,2],"s":"<x & y>"}`)}
	wire, _, err := EncodeWire(plain, ModeStructured)
	if err != nil {
		t.Fatal(err)
	}
	if wire.Headers["content-type"] != StructuredContentType || len(wire.Headers) != 1 {
		t.Fatalf("headers %v", wire.Headers)
	}
	want := `{"specversion":"1.0","id":"call-1","source":"landflow://host/h1","type":"dev.landflow.plugin.v1.health.request","time":"2026-10-26T12:00:00.000Z",` +
		`"datacontenttype":"application/json","lfreplyto":"landflow.v1.reply.h1","lfdeadline":"1793102430000","lfattempt":"1","lfdelivery":"at-least-once",` +
		`"lfkeyid":"9a5c85f5715d1126","lfsig":"` + attrs.LfSig + `","data":{"a":[1,2],"s":"<x & y>"}}`
	if string(wire.Body) != want {
		t.Fatalf("document:\n%s\nwant\n%s", wire.Body, want)
	}
	decoded, err := DecodeWire(wire, DecodeOptions{})
	if err != nil || decoded.Attributes != attrs || string(decoded.Body) != string(plain.Body) {
		t.Fatalf("plain round trip: %v %+v %q", err, decoded.Attributes, decoded.Body)
	}
	// Encrypted: data_base64.
	enc := attrs
	enc.LfEnc = EncAESGCM
	enc.DataContentType = EncryptedContentType
	sealed := RawEvent{Attributes: enc, Body: []byte{0, 1, 2, 255}}
	wire, _, _ = EncodeWire(sealed, ModeStructured)
	if !bytes.Contains(wire.Body, []byte(`"data_base64":"AAEC/w=="`)) {
		t.Fatalf("%s", wire.Body)
	}
	decoded, err = DecodeWire(wire, DecodeOptions{})
	if err != nil || !bytes.Equal(decoded.Body, sealed.Body) {
		t.Fatalf("encrypted round trip: %v %v", err, decoded.Body)
	}
	// Empty body: data null.
	wire, _, _ = EncodeWire(RawEvent{Attributes: attrs}, ModeStructured)
	if !bytes.HasSuffix(wire.Body, []byte(`"data":null}`)) {
		t.Fatalf("%s", wire.Body)
	}
	decoded, err = DecodeWire(wire, DecodeOptions{})
	if err != nil || len(decoded.Body) != 0 {
		t.Fatalf("null body: %v %q", err, decoded.Body)
	}
	// A structured document without content-type decodes; a non-object does not.
	wire.Headers = nil
	if _, err := DecodeWire(wire, DecodeOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`[1]`, `null`, `not json`, `{"specversion":1}`} {
		if _, err := DecodeWire(WireEvent{Body: []byte(bad)}, DecodeOptions{}); err == nil {
			t.Fatalf("%s decoded", bad)
		}
	}
}

func TestValidateAttributesRules(t *testing.T) {
	base := func() map[string]string {
		return map[string]string{"specversion": "1.0", "id": "x", "source": "landflow://host/h", "type": "dev.landflow.plugin.v1.cancel", "time": "2026-01-01T00:00:00Z", "datacontenttype": "application/json"}
	}
	if _, err := ValidateAttributes(base(), ValidateOptions{}); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, value, reason string }{
		{"specversion", "0.3", "unsupported"},
		{"type", "dev.landflow.plugin.v1.what.request", "unsupported"},
		{"datacontenttype", "text/plain", "unsupported"},
		{"lfenc", "aes-256-gcm", "malformed"}, // without octet-stream
		{"lfenc", "rot13", "unsupported"},
		{"lfdelivery", "exactly-once", "malformed"},
		{"id", "has space", "malformed"},
		{"source", "http://x", "malformed"},
		{"time", "yesterday", "malformed"},
		{"lfdeadline", "-1", "malformed"},
		{"lfsig", "abc", "malformed"},
		{"subject", "bad subject", "malformed"},
		{"tracestate", "\x01", "malformed"},
	}
	for _, c := range cases {
		in := base()
		in[c.name] = c.value
		_, err := ValidateAttributes(in, ValidateOptions{})
		var ee *EnvelopeError
		if !errors.As(err, &ee) || string(ee.Reason) != c.reason {
			t.Errorf("%s=%q: got %v, want %s", c.name, c.value, err, c.reason)
		}
	}
	in := base()
	delete(in, "id")
	if _, err := ValidateAttributes(in, ValidateOptions{}); err == nil {
		t.Fatal("id is required")
	}
}

func TestSerializeBodyMatchesJSONStringify(t *testing.T) {
	type node struct {
		Type string  `json:"type"`
		N    float64 `json:"n"`
		S    string  `json:"s"`
	}
	out, err := SerializeBody(node{Type: "a.b", N: 1.5, S: "<&> "})
	if err != nil || string(out) != `{"type":"a.b","n":1.5,"s":"<&>`+" "+`"}` {
		t.Fatalf("%v %s", err, out)
	}
	if out, _ := SerializeBody(json.RawMessage(" { \"a\" : 1 } ")); string(out) != `{"a":1}` {
		t.Fatalf("%s", out)
	}
	if out, _ := SerializeBody(nil); string(out) != "null" {
		t.Fatalf("%s", out)
	}
	if SubjectOf(MethodExecute, []byte(`{"node":{"type":"twilio.message"}}`)) != "twilio.message" || SubjectOf(MethodLoadOptions, []byte(`{"nodeType":"x.y"}`)) != "x.y" || SubjectOf(MethodHealth, []byte(`{}`)) != "" {
		t.Fatal("subject")
	}
	if FormatTime(time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)) != "2026-10-26T12:00:00.000Z" {
		t.Fatal(FormatTime(time.Now()))
	}
	if len(NewEventID()) != 32 || NewEventID() == NewEventID() {
		t.Fatal("event id")
	}
	var a Attributes
	a.LfDeadline = "1793102430000"
	if a.Deadline().UnixMilli() != 1793102430000 {
		t.Fatal("deadline")
	}
}

func TestChannelNames(t *testing.T) {
	n := NewNames("")
	if n.Request("twilio") != "landflow.v1.plugin.twilio" || n.Instance("twilio", "i1") != "landflow.v1.instance.twilio.i1" || n.Reply("h") != "landflow.v1.reply.h" || n.Registry() != "landflow.v1.registry" || n.Control("twilio") != "landflow.v1.control.twilio" {
		t.Fatal("names")
	}
	if NewNames("acme").Registry() != "acme.v1.registry" {
		t.Fatal("prefix")
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("bad plugin id must panic")
			}
		}()
		n.Request("bad/id")
	}()
	kind, conn, plugin, ok := ParseBrokerEndpoint("kafka://kafka-main/twilio")
	if !ok || kind != "kafka" || conn != "kafka-main" || plugin != "twilio" {
		t.Fatal("endpoint")
	}
	if _, _, _, ok := ParseBrokerEndpoint("http://127.0.0.1:7100"); ok {
		t.Fatal("direct endpoints are not brokered")
	}
	if BrokerEndpoint("nats", "c", "p") != "nats://c/p" {
		t.Fatal("format")
	}
	if ReplySpec("r").TTL != 5*time.Minute || !RequestSpec("q", 0).Durable || ControlSpec("c").Delivery != DeliveryBroadcast {
		t.Fatal("specs")
	}
}

func TestHeaderPrefixHelpers(t *testing.T) {
	p := PrefixHeaders(map[string]string{"id": "1", "content-type": "application/json"}, "ce_")
	if p["ce_id"] != "1" || p["content-type"] != "application/json" || len(p) != 2 {
		t.Fatal(p)
	}
	u := UnprefixHeaders(map[string]string{"CE_Id": "1", "Content-Type": "application/json", "x-other": "z"}, "ce_")
	if u["id"] != "1" || u["content-type"] != "application/json" || len(u) != 2 {
		t.Fatal(u)
	}
}
