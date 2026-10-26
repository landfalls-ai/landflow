package transport

// The claim check (docs/protocol.md §14.6 "Size"): an event whose headers and
// body do not fit the broker's limits goes by reference. The sender writes the
// already-encrypted body to a shared object store (S3-compatible; MinIO in dev)
// under a fresh key, publishes the event with an empty body plus lfclaim /
// lfclaimsize / lfclaimsha256 (signed like every other attribute), and the
// receiver fetches, checks size and digest, and carries on as usual. The store
// only ever sees ciphertext. Mirrors packages/transports/src/claim.ts.
//
//   - ClaimStore is the small interface; MemoryClaimStore is for tests, S3ClaimStore
//     (claim_s3.go: stdlib only, SigV4; credential chain in claim_creds.go) for S3-compatible buckets.
//   - ClaimStoreFromEnv reads one setting, LANDFLOW_CLAIM_STORE=s3://<bucket>/<prefix>?endpoint=…&region=…&forcePathStyle=true
//     (or memory://), with credentials in LANDFLOW_CLAIM_ACCESS_KEY_ID / LANDFLOW_CLAIM_SECRET_ACCESS_KEY (falling back to
//     AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN). An S3 store refuses to start without an explicit endpoint
//     unless the URL says aws=true.
//   - Lifetime: the receiver deletes the object once it has acknowledged the event; a sender deletes the request object of a
//     call that failed; the key is claims/<epoch ms, 13 digits>/<event id>, so SweepClaims (run by the client and the server
//     every 10 min) deletes whatever is older than the TTL (default 1 h) after a crash.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	ClaimKeyPrefix        = "claims/"
	DefaultClaimTTL       = time.Hour
	ClaimSweepInterval    = 10 * time.Minute
	ClaimStoreEnv         = "LANDFLOW_CLAIM_STORE"
	claimOperationTimeout = 60 * time.Second
)

var claimKeyPattern = regexp.MustCompile(`^claims/\d{13}/[A-Za-z0-9._-]{1,128}$`)
var claimIDUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// ErrClaimNotFound is what ClaimStore.Get returns for a missing object.
var ErrClaimNotFound = errors.New("claim not found")

// ClaimStore is the shared store claim-checked bodies travel through.
type ClaimStore interface {
	Kind() string
	Put(ctx context.Context, key string, body []byte) error
	// Get returns ErrClaimNotFound when the object does not exist (expired or deleted).
	Get(ctx context.Context, key string) ([]byte, error)
	// Delete is idempotent: deleting a missing object is not an error.
	Delete(ctx context.Context, key string) error
	// List returns the keys (relative to the store's prefix) starting with prefix.
	List(ctx context.Context, prefix string) ([]string, error)
}

// ClaimError: the claim could not be written, fetched or verified. Reason says which.
type ClaimError struct {
	Reason  string // "store", "missing", "size", "digest" or "invalid"
	Message string
}

func (e *ClaimError) Error() string { return e.Message }

// ClaimKeyFor makes the key of a new claim: claims/<13-digit epoch ms>/<event id>.
func ClaimKeyFor(now time.Time, eventID string) string {
	id := claimIDUnsafe.ReplaceAllString(eventID, "_")
	if len(id) > 128 {
		id = id[:128]
	}
	return fmt.Sprintf("%s%013d/%s", ClaimKeyPrefix, now.UnixMilli(), id)
}

// ClaimKeyTime is the time a claim key carries (ok false for a key that is not one of ours).
func ClaimKeyTime(key string) (time.Time, bool) {
	if !claimKeyPattern.MatchString(key) {
		return time.Time{}, false
	}
	ms, err := strconv.ParseInt(key[len(ClaimKeyPrefix):len(ClaimKeyPrefix)+13], 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(ms), true
}

// SHA256Hex is the lowercase hex SHA-256 of b.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// MemoryClaimStore is an in-process store for tests. Puts / Deletes count calls; Keys lists what is stored now.
type MemoryClaimStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	Puts    int
	Gets    int
	Deletes int
	// FailNext makes the next "put" or "get" fail, to exercise store outages.
	FailNext string
}

func NewMemoryClaimStore() *MemoryClaimStore { return &MemoryClaimStore{objects: map[string][]byte{}} }

func (m *MemoryClaimStore) Kind() string { return "memory" }

func (m *MemoryClaimStore) Put(_ context.Context, key string, body []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailNext == "put" {
		m.FailNext = ""
		return errors.New("memory claim store: put failed")
	}
	m.Puts++
	m.objects[key] = append([]byte(nil), body...)
	return nil
}

func (m *MemoryClaimStore) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailNext == "get" {
		m.FailNext = ""
		return nil, errors.New("memory claim store: get failed")
	}
	m.Gets++
	body, ok := m.objects[key]
	if !ok {
		return nil, ErrClaimNotFound
	}
	return append([]byte(nil), body...), nil
}

func (m *MemoryClaimStore) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Deletes++
	delete(m.objects, key)
	return nil
}

func (m *MemoryClaimStore) List(_ context.Context, prefix string) ([]string, error) {
	return m.Keys(prefix), nil
}

// Keys lists the stored keys with the prefix, sorted.
func (m *MemoryClaimStore) Keys(prefix string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keys []string
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// Set stores raw bytes under a key without counting a put (tests tamper with objects this way).
func (m *MemoryClaimStore) Set(key string, body []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = append([]byte(nil), body...)
}

// Object returns a stored object (nil when absent).
func (m *MemoryClaimStore) Object(key string) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.objects[key]
}

// ClaimSetting is a configured claim store.
type ClaimSetting struct {
	Store ClaimStore
	TTL   time.Duration
	// Describe is the setting without credentials, for display.
	Describe string
}

// ParseClaimStore parses a LANDFLOW_CLAIM_STORE value. getenv supplies the credentials (nil = os.Getenv).
func ParseClaimStore(value string, getenv func(string) string) (*ClaimSetting, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" {
		return nil, fmt.Errorf("%s %q is not a URL (expected s3://<bucket>/<prefix>?endpoint=…)", ClaimStoreEnv, value)
	}
	q := u.Query()
	ttl := DefaultClaimTTL
	if t := q.Get("ttl"); t != "" {
		secs, err := strconv.ParseFloat(t, 64)
		if err != nil || secs <= 0 {
			return nil, fmt.Errorf("%s: ttl must be a positive number of seconds", ClaimStoreEnv)
		}
		ttl = time.Duration(secs * float64(time.Second))
	}
	switch u.Scheme {
	case "memory":
		return &ClaimSetting{Store: NewMemoryClaimStore(), TTL: ttl, Describe: "memory (in this process only)"}, nil
	case "s3":
		first := func(names ...string) string {
			for _, n := range names {
				if v := getenv(n); v != "" {
					return v
				}
			}
			return ""
		}
		prefix := strings.TrimPrefix(u.Path, "/")
		store, err := NewS3ClaimStore(S3ClaimStoreOptions{
			Bucket:          u.Host,
			Prefix:          prefix,
			Endpoint:        q.Get("endpoint"),
			Region:          q.Get("region"),
			ForcePathStyle:  q.Get("forcePathStyle") != "false",
			AllowAWS:        q.Get("aws") == "true",
			AccessKeyID:     first("LANDFLOW_CLAIM_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
			SecretAccessKey: first("LANDFLOW_CLAIM_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
			SessionToken:    getenv("AWS_SESSION_TOKEN"),
			Getenv:          getenv,
		})
		if err != nil {
			return nil, err
		}
		describe := "s3://" + u.Host + "/" + prefix
		if ep := q.Get("endpoint"); ep != "" {
			describe += " @ " + ep
		}
		describe += " (credentials: " + store.CredentialSource() + ")"
		return &ClaimSetting{Store: store, TTL: ttl, Describe: describe}, nil
	}
	return nil, fmt.Errorf("%s: scheme %q is not supported (s3: or memory:)", ClaimStoreEnv, u.Scheme)
}

// ClaimStoreFromEnv is the store LANDFLOW_CLAIM_STORE configures, or nil when it is unset.
func ClaimStoreFromEnv() (*ClaimSetting, error) {
	value := strings.TrimSpace(os.Getenv(ClaimStoreEnv))
	if value == "" {
		return nil, nil
	}
	return ParseClaimStore(value, nil)
}

// SweepClaims deletes the claims older than ttl (the key carries the time) and returns how many it deleted.
func SweepClaims(ctx context.Context, store ClaimStore, ttl time.Duration, now time.Time) (int, error) {
	keys, err := store.List(ctx, ClaimKeyPrefix)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, key := range keys {
		if at, ok := ClaimKeyTime(key); ok && at.Before(now.Add(-ttl)) {
			if err := store.Delete(ctx, key); err != nil {
				return deleted, err
			}
			deleted++
		}
	}
	return deleted, nil
}

// startClaimSweeper sweeps now and then until stop is closed.
func startClaimSweeper(store ClaimStore, ttl time.Duration, interval time.Duration, stop <-chan struct{}, log Logger, now func() time.Time) {
	if interval <= 0 {
		interval = ClaimSweepInterval
	}
	if ttl <= 0 {
		ttl = DefaultClaimTTL
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				ctx, cancel := context.WithTimeout(context.Background(), claimOperationTimeout)
				if _, err := SweepClaims(ctx, store, ttl, now()); err != nil {
					log("debug", "claim sweep failed", "error", err.Error())
				}
				cancel()
			}
		}
	}()
}
