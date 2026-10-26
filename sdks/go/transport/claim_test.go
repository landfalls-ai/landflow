package transport

// Claim store setting, keys, sweeper, the signed reference, and (with MinIO up) the S3 store:
//
//	LANDFLOW_TEST_CLAIM_S3=http://127.0.0.1:59000 LANDFLOW_CLAIM_ACCESS_KEY_ID=landflow LANDFLOW_CLAIM_SECRET_ACCESS_KEY=landflow-dev-only go test -run Claim .

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestClaimStoreSetting(t *testing.T) {
	env := func(k string) string {
		return map[string]string{"LANDFLOW_CLAIM_ACCESS_KEY_ID": "k", "LANDFLOW_CLAIM_SECRET_ACCESS_KEY": "s"}[k]
	}
	if s, err := ParseClaimStore("memory://", env); err != nil || s.Store.Kind() != "memory" {
		t.Fatalf("memory: %v", err)
	}
	s, err := ParseClaimStore("s3://landflow/claims-x?endpoint=http://127.0.0.1:59000&ttl=120", env)
	if err != nil || s.Store.Kind() != "s3" || s.TTL != 120*time.Second || s.Describe != "s3://landflow/claims-x @ http://127.0.0.1:59000 (credentials: static keys)" {
		t.Fatalf("s3: %+v %v", s, err)
	}
	if _, err := ParseClaimStore("s3://landflow/p", env); err == nil || !strings.Contains(err.Error(), "refusing to use the default") {
		t.Fatalf("default endpoint accepted: %v", err)
	}
	if _, err := ParseClaimStore("s3://landflow/p?aws=true", env); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseClaimStore("ftp://x", env); err == nil {
		t.Fatal("ftp accepted")
	}
}

func TestClaimSweepAndSignedReference(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryClaimStore()
	now := time.UnixMilli(1_800_000_000_000)
	_ = store.Put(ctx, ClaimKeyFor(now.Add(-2*time.Hour), "old"), []byte{1})
	_ = store.Put(ctx, ClaimKeyFor(now.Add(-time.Second), "fresh"), []byte{2})
	if n, err := SweepClaims(ctx, store, time.Hour, now); err != nil || n != 1 || len(store.Keys("claims/")) != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	ring := MustKeyring(vecSecret)
	codec := NewCodec(ring, Capabilities{MaxMessageBytes: 4096, Headers: true}, CodecOptions{Claims: store})
	a := baseAttributes(RequestType(MethodExecute), "claim-1")
	a.Source = HostSource("h1")
	packed, err := codec.PackBodyClaimedAny(ctx, "p1", a, map[string]any{"blob": strings.Repeat("x", 10000)}, true)
	if err != nil || packed.ClaimKey == "" || len(packed.Wire.Body) != 0 {
		t.Fatalf("pack: %+v %v", packed, err)
	}
	raw, _ := codec.Peek(packed.Wire)
	original := store.Object(packed.ClaimKey)
	swapped := raw
	swapped.Attributes.LfClaim = ClaimKeyFor(time.UnixMilli(1), "other")
	var se *SecurityError
	if _, _, err := codec.ResolveClaim(ctx, swapped, "p1"); !errors.As(err, &se) {
		t.Fatalf("swapped: %v", err)
	}
	for reason, mutate := range map[string]func(){
		"size":    func() { store.Set(packed.ClaimKey, original[:len(original)-1]) },
		"digest":  func() { b := append([]byte(nil), original...); b[5] ^= 1; store.Set(packed.ClaimKey, b) },
		"missing": func() { _ = store.Delete(ctx, packed.ClaimKey) },
	} {
		mutate()
		var ce *ClaimError
		if _, _, err := codec.ResolveClaim(ctx, raw, "p1"); !errors.As(err, &ce) || ce.Reason != reason {
			t.Fatalf("%s: %v", reason, err)
		}
	}
	// Without a store the old too_large stays.
	plain := NewCodec(ring, Capabilities{MaxMessageBytes: 4096, Headers: true}, CodecOptions{})
	var ee *EnvelopeError
	if _, err := plain.PackBodyClaimedAny(ctx, "p1", a, map[string]any{"blob": strings.Repeat("x", 10000)}, true); !errors.As(err, &ee) || ee.Reason != ReasonTooLarge {
		t.Fatalf("no store: %v", err)
	}
}

func TestS3ClaimStoreMinIO(t *testing.T) {
	endpoint := os.Getenv("LANDFLOW_TEST_CLAIM_S3")
	if endpoint == "" {
		t.Skip("set LANDFLOW_TEST_CLAIM_S3=http://127.0.0.1:59000 (and LANDFLOW_CLAIM_ACCESS_KEY_ID / _SECRET_ACCESS_KEY) to test the S3 claim store")
	}
	bucket := os.Getenv("LANDFLOW_TEST_CLAIM_BUCKET")
	if bucket == "" {
		bucket = "landflow"
	}
	s, err := NewS3ClaimStore(S3ClaimStoreOptions{Bucket: bucket, Prefix: "claims-test-go-" + randomHex(3) + "/", Endpoint: endpoint, ForcePathStyle: true,
		AccessKeyID: os.Getenv("LANDFLOW_CLAIM_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("LANDFLOW_CLAIM_SECRET_ACCESS_KEY")})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key, old := ClaimKeyFor(time.Now(), "abc123"), ClaimKeyFor(time.Now().Add(-2*time.Hour), "old456")
	body := make([]byte, 300_000)
	_, _ = rand.Read(body)
	if err := s.Put(ctx, key, body); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, old, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, key)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("get: %v", err)
	}
	keys, err := s.List(ctx, ClaimKeyPrefix)
	if err != nil || len(keys) != 2 {
		t.Fatalf("list: %v %v", keys, err)
	}
	if n, err := SweepClaims(ctx, s, time.Hour, time.Now()); err != nil || n != 1 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	if _, err := s.Get(ctx, old); !errors.Is(err, ErrClaimNotFound) {
		t.Fatalf("old: %v", err)
	}
	_ = s.Delete(ctx, key)
	_ = s.Delete(ctx, key)
	if _, err := s.Get(ctx, key); !errors.Is(err, ErrClaimNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}
