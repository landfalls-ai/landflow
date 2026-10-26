package transport

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"
)

// Known-answer vectors shared with packages/transports/test/security.test.ts.
const (
	vecSecret = "transport-s3cret"
	vecPlugin = "test-plugin"
)

func vecAttributes() Attributes {
	return Attributes{
		SpecVersion: "1.0", ID: "call-1", Source: "landflow://host/h1", Type: "dev.landflow.plugin.v1.health.request",
		Time: "2026-10-26T12:00:00.000Z", DataContentType: "application/json",
		LfReplyTo: "landflow.v1.reply.h1", LfDeadline: "1793102430000", LfAttempt: "1", LfDelivery: AtLeastOnce,
	}
}

var vecNow = time.Date(2026, 10, 26, 12, 0, 1, 0, time.UTC)

func TestKeyDerivationVectors(t *testing.T) {
	if got := KeyIDOf(vecSecret); got != "9a5c85f5715d1126" {
		t.Fatalf("key id %s", got)
	}
	keys := DeriveKeys(vecSecret, vecPlugin)
	if keys.KeyID != "9a5c85f5715d1126" {
		t.Fatalf("keys.KeyID %s", keys.KeyID)
	}
	if got := hex.EncodeToString(keys.Enc); got != "0c16cc20dcdd656ccb50880e4ff8abe53e936a69254e70ca38b2f3ce340e1648" {
		t.Fatalf("enc %s", got)
	}
	if got := hex.EncodeToString(keys.Sig); got != "cfcefdc42b585afb5a42bbd8637d106e26a91b7159c19dec14a5d3d038c5308c" {
		t.Fatalf("sig %s", got)
	}
	if hex.EncodeToString(DeriveKeys(vecSecret, "other-plugin").Enc) == hex.EncodeToString(keys.Enc) {
		t.Fatal("keys must differ per plugin")
	}
}

func TestKeyringFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if _, err := KeyringFromEnv(env(nil)); !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("expected ErrMissingSecret, got %v", err)
	}
	ring, err := KeyringFromEnv(env(map[string]string{"LANDFLOW_REGISTRY_SECRET": "r"}))
	if err != nil || ring.CurrentKeyID() != KeyIDOf("r") {
		t.Fatalf("registry fallback: %v %v", ring, err)
	}
	ring, err = KeyringFromEnv(env(map[string]string{"LANDFLOW_TRANSPORT_SECRET": "t", "LANDFLOW_REGISTRY_SECRET": "r", "LANDFLOW_TRANSPORT_SECRET_PREVIOUS": "p1, p2"}))
	if err != nil {
		t.Fatal(err)
	}
	if ring.CurrentKeyID() != KeyIDOf("t") || !ring.Has(KeyIDOf("p1")) || !ring.Has(KeyIDOf("p2")) || ring.Has(KeyIDOf("r")) {
		t.Fatal("rotation keys wrong")
	}
	if _, err := NewKeyring(""); !errors.Is(err, ErrMissingSecret) {
		t.Fatal("empty secret must fail")
	}
}

func TestSigningVector(t *testing.T) {
	ring := MustKeyring(vecSecret)
	sealed := Seal(ring, vecPlugin, RawEvent{Attributes: vecAttributes(), Body: MustSerializeBody(map[string]any{})}, SealOptions{})
	want := "specversion=1.0\nid=call-1\nsource=landflow://host/h1\ntype=dev.landflow.plugin.v1.health.request\ntime=2026-10-26T12:00:00.000Z\n" +
		"datacontenttype=application/json\nlfreplyto=landflow.v1.reply.h1\nlfdeadline=1793102430000\nlfattempt=1\nlfdelivery=at-least-once\nlfkeyid=9a5c85f5715d1126\n" +
		"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\n"
	if got := CanonicalForm(sealed.Attributes, sealed.Body); got != want {
		t.Fatalf("canonical form:\n%s", got)
	}
	if sealed.Attributes.LfSig != "6f4f5b0e15bf654e1d2999781cfa3b22198d8ead69df6ba6d8f548f438cd3c56" {
		t.Fatalf("lfsig %s", sealed.Attributes.LfSig)
	}
	if sealed.Attributes.LfKeyID != "9a5c85f5715d1126" || sealed.Attributes.LfEnc != "" {
		t.Fatal("keyid/enc wrong")
	}
	opened, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow})
	if err != nil || string(opened.Body) != "{}" {
		t.Fatalf("open: %v %q", err, opened.Body)
	}
}

func reasonOf(ring *Keyring, pluginID string, event RawEvent) string {
	_, err := Open(ring, pluginID, event, OpenOptions{Now: vecNow})
	if err == nil {
		return "accepted"
	}
	var se *SecurityError
	if errors.As(err, &se) {
		return string(se.Reason)
	}
	return "other"
}

func TestRefusals(t *testing.T) {
	ring := MustKeyring(vecSecret)
	sealed := Seal(ring, vecPlugin, RawEvent{Attributes: vecAttributes(), Body: MustSerializeBody(map[string]any{"a": 1})}, SealOptions{})
	if r := reasonOf(ring, vecPlugin, sealed); r != "accepted" {
		t.Fatal(r)
	}
	unsigned := sealed
	unsigned.Attributes.LfSig = ""
	if r := reasonOf(ring, vecPlugin, unsigned); r != "unsigned" {
		t.Fatal(r)
	}
	edited := sealed
	edited.Attributes.LfDeadline = "1"
	if r := reasonOf(ring, vecPlugin, edited); r != "bad_signature" {
		t.Fatal(r)
	}
	tampered := sealed
	tampered.Body = MustSerializeBody(map[string]any{"a": 2})
	if r := reasonOf(ring, vecPlugin, tampered); r != "bad_signature" {
		t.Fatal(r)
	}
	if r := reasonOf(MustKeyring("another"), vecPlugin, sealed); r != "unknown_key" {
		t.Fatal(r)
	}
	if r := reasonOf(ring, "other-plugin", sealed); r != "bad_signature" {
		t.Fatal(r)
	}
	if r := reasonOf(MustKeyring("new-secret", vecSecret), vecPlugin, sealed); r != "accepted" {
		t.Fatal("rotated receiver must accept the previous key: " + r)
	}
}

func TestClockSkewAndReplay(t *testing.T) {
	ring := MustKeyring(vecSecret)
	sealed := Seal(ring, vecPlugin, RawEvent{Attributes: vecAttributes(), Body: MustSerializeBody(map[string]any{})}, SealOptions{})
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow.Add(6 * time.Minute)}); err == nil || !strings.Contains(err.Error(), "clock-skew") {
		t.Fatalf("expected clock skew, got %v", err)
	}
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow.Add(-6 * time.Minute)}); err == nil || !strings.Contains(err.Error(), "clock-skew") {
		t.Fatalf("expected clock skew, got %v", err)
	}
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow.Add(6 * time.Minute), ClockSkew: 10 * time.Minute}); err != nil {
		t.Fatal(err)
	}
	replay := NewReplayGuard(time.Minute, 0)
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow, Replay: replay}); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow.Add(time.Second), Replay: replay}); err == nil || !strings.Contains(err.Error(), "replay") {
		t.Fatalf("expected replay, got %v", err)
	}
	replay.Forget("call-1")
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow.Add(time.Second), Replay: replay}); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow.Add(61*time.Second + time.Millisecond), Replay: replay}); err != nil {
		t.Fatal(err)
	}
}

func TestEncryptionVector(t *testing.T) {
	ring := MustKeyring(vecSecret)
	nonce, _ := hex.DecodeString("000102030405060708090a0b")
	sealed := Seal(ring, vecPlugin, RawEvent{Attributes: vecAttributes(), Body: MustSerializeBody(map[string]any{"ok": true})}, SealOptions{Encrypt: true, Nonce: nonce})
	if sealed.Attributes.LfEnc != "aes-256-gcm" || sealed.Attributes.DataContentType != "application/octet-stream" {
		t.Fatal("enc attributes wrong")
	}
	if got := hex.EncodeToString(sealed.Body); got != "000102030405060708090a0bee671ac6aba5fd1cecf11bc896d7854dd5489bb2a610aab761ada4" {
		t.Fatalf("ciphertext %s", got)
	}
	if sealed.Attributes.LfSig != "9d9b3ba516457881811e270747207d5a64c0646d054f5e6d1aff8b7f17db1505" {
		t.Fatalf("lfsig %s", sealed.Attributes.LfSig)
	}
	opened, err := Open(ring, vecPlugin, sealed, OpenOptions{Now: vecNow})
	if err != nil || string(opened.Body) != `{"ok":true}` {
		t.Fatalf("open: %v %q", err, opened.Body)
	}
}

func TestEncryptionBinding(t *testing.T) {
	keys := DeriveKeys(vecSecret, vecPlugin)
	base := vecAttributes()
	sealedBody := EncryptBody(keys.Enc, base, MustSerializeBody(map[string]any{"x": 1}), nil)
	plain, err := DecryptBody(keys.Enc, base, sealedBody)
	if err != nil || string(plain) != `{"x":1}` {
		t.Fatalf("%v %q", err, plain)
	}
	other := base
	other.ID = "call-2"
	if _, err := DecryptBody(keys.Enc, other, sealedBody); err == nil {
		t.Fatal("ciphertext must be bound to the id")
	}
	flipped := append([]byte(nil), sealedBody...)
	flipped[14] ^= 1
	if _, err := DecryptBody(keys.Enc, base, flipped); err == nil || !strings.Contains(err.Error(), "does not decrypt") {
		t.Fatalf("%v", err)
	}
	if _, err := DecryptBody(keys.Enc, base, make([]byte, 10)); err == nil || !strings.Contains(err.Error(), "too short") {
		t.Fatalf("%v", err)
	}
	ring := MustKeyring(vecSecret)
	a := Seal(ring, vecPlugin, RawEvent{Attributes: vecAttributes(), Body: []byte("{}")}, SealOptions{Encrypt: true})
	b := Seal(ring, vecPlugin, RawEvent{Attributes: vecAttributes(), Body: []byte("{}")}, SealOptions{Encrypt: true})
	if hex.EncodeToString(a.Body) == hex.EncodeToString(b.Body) {
		t.Fatal("nonce must be fresh per event")
	}
}

func TestRegistryProofVector(t *testing.T) {
	const proof = "d6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e"
	if got := RegistryProof("registry-s3cret", "test-plugin", "challenge-123"); got != proof {
		t.Fatal(got)
	}
	if !VerifyRegistryProof("registry-s3cret", "test-plugin", "challenge-123", proof) {
		t.Fatal("valid proof refused")
	}
	if VerifyRegistryProof("registry-s3cret", "other", "challenge-123", proof) || VerifyRegistryProof("registry-s3cret", "test-plugin", "challenge-123", "") || VerifyRegistryProof("registry-s3cret", "test-plugin", "challenge-123", "nope") {
		t.Fatal("bad proof accepted")
	}
}

func TestReplayGuardBoundsMemory(t *testing.T) {
	guard := NewReplayGuard(time.Minute, 100)
	now := time.UnixMilli(1000)
	for i := 0; i < 150; i++ {
		guard.Accept("id-"+strings.Repeat("x", i%3)+string(rune('a'+i%26))+hex.EncodeToString([]byte{byte(i)}), now)
	}
	if guard.Size() > 100 {
		t.Fatalf("size %d", guard.Size())
	}
	last := "id-" + strings.Repeat("x", 149%3) + string(rune('a'+149%26)) + hex.EncodeToString([]byte{149})
	if guard.Accept(last, now) {
		t.Fatal("the newest id must still be remembered")
	}
}
