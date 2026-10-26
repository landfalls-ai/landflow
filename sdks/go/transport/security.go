package transport

// Security over brokers (docs/transports.md "Security over brokers",
// docs/protocol.md §14.7). Byte-compatible with packages/transports/src/security.ts.
//
// Keys. One shared secret, LANDFLOW_TRANSPORT_SECRET (falling back to
// LANDFLOW_REGISTRY_SECRET), known to the host and to every plugin. Per plugin,
// two 32-byte keys come from HKDF-SHA256 over it (no salt):
//
//	encKey = HKDF-SHA256(secret, info = "landflow transport v1\n" + pluginId + "\nenc", 32 bytes)
//	sigKey = HKDF-SHA256(secret, info = "landflow transport v1\n" + pluginId + "\nsig", 32 bytes)
//
// A key id, lfkeyid = hex(SHA-256("landflow transport keyid v1\n" + secret))[0..16],
// travels with each event so a receiver with several secrets (rotation:
// LANDFLOW_TRANSPORT_SECRET_PREVIOUS, comma-separated) picks the right one.
//
// Encryption. The whole body of every request and response: AES-256-GCM with a
// random 96-bit nonce, body = nonce ‖ ciphertext ‖ tag, additional data
// id + "\n" + type. Announce, withdraw and cancel bodies stay plain.
//
// Signing. lfsig = hex(HMAC-SHA256(sigKey, canonical)), encrypt-then-MAC. The
// canonical form is one line per attribute present, in KnownAttributes order
// and excluding lfsig, "name=value\n", followed by hex(SHA-256(body)) + "\n"
// over the on-wire body bytes. A receiver refuses unsigned events, unknown key
// ids, bad signatures, a time farther than the clock skew from its clock, and
// ids it has already accepted inside the replay window.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	TransportSecretEnv         = "LANDFLOW_TRANSPORT_SECRET"
	TransportSecretPreviousEnv = "LANDFLOW_TRANSPORT_SECRET_PREVIOUS"
	RegistrySecretEnv          = "LANDFLOW_REGISTRY_SECRET"
	HKDFInfoPrefix             = "landflow transport v1"
	keyIDPrefix                = "landflow transport keyid v1"
	nonceBytes                 = 12
	tagBytes                   = 16
	// DefaultClockSkew is the tolerated clock difference between sender and receiver.
	DefaultClockSkew = 5 * time.Minute
)

// SecurityReason says why a SecurityError happened.
type SecurityReason string

const (
	ReasonUnsigned      SecurityReason = "unsigned"
	ReasonUnknownKey    SecurityReason = "unknown_key"
	ReasonBadSignature  SecurityReason = "bad_signature"
	ReasonClockSkew     SecurityReason = "clock_skew"
	ReasonReplay        SecurityReason = "replay"
	ReasonDecryptFailed SecurityReason = "decrypt_failed"
	ReasonWrongPlugin   SecurityReason = "wrong_plugin"
)

// SecurityError: a received event failed verification. The core drops the
// event (and nacks without requeue), never processes it.
type SecurityError struct {
	Reason  SecurityReason
	Message string
}

func (e *SecurityError) Error() string { return e.Message }

func securityErr(reason SecurityReason, format string, args ...any) *SecurityError {
	return &SecurityError{Reason: reason, Message: fmt.Sprintf(format, args...)}
}

// ErrMissingSecret: messaging cannot start without a secret.
var ErrMissingSecret = fmt.Errorf("messaging over brokers needs a shared secret: set %s (or %s) to the same value on the host and on every plugin", TransportSecretEnv, RegistrySecretEnv)

// DerivedKeys are one plugin's keys under one secret.
type DerivedKeys struct {
	KeyID string
	Enc   []byte
	Sig   []byte
}

// KeyIDOf is the key id of a secret.
func KeyIDOf(secret string) string {
	sum := sha256.Sum256([]byte(keyIDPrefix + "\n" + secret))
	return hex.EncodeToString(sum[:])[:16]
}

// DeriveKeys derives pluginID's keys from secret.
func DeriveKeys(secret, pluginID string) DerivedKeys {
	derive := func(purpose string) []byte {
		key, err := hkdf.Key(sha256.New, []byte(secret), nil, HKDFInfoPrefix+"\n"+pluginID+"\n"+purpose, 32)
		if err != nil {
			panic("transport: hkdf: " + err.Error())
		}
		return key
	}
	return DerivedKeys{KeyID: KeyIDOf(secret), Enc: derive("enc"), Sig: derive("sig")}
}

// Keyring holds the secrets a process has: one current (signs and encrypts) and
// any number of previous ones (verify and decrypt only). Derived keys are
// cached per plugin. Safe for concurrent use.
type Keyring struct {
	currentKeyID string
	secrets      map[string]string
	mu           sync.Mutex
	cache        map[string]DerivedKeys
}

// NewKeyring builds a keyring; it returns ErrMissingSecret for an empty current secret.
func NewKeyring(current string, previous ...string) (*Keyring, error) {
	if current == "" {
		return nil, ErrMissingSecret
	}
	k := &Keyring{currentKeyID: KeyIDOf(current), secrets: map[string]string{}, cache: map[string]DerivedKeys{}}
	k.secrets[k.currentKeyID] = current
	for _, s := range previous {
		if s != "" {
			k.secrets[KeyIDOf(s)] = s
		}
	}
	return k, nil
}

// MustKeyring is NewKeyring that panics on an empty secret (tests).
func MustKeyring(current string, previous ...string) *Keyring {
	k, err := NewKeyring(current, previous...)
	if err != nil {
		panic(err)
	}
	return k
}

// KeyringFromEnv reads LANDFLOW_TRANSPORT_SECRET (else LANDFLOW_REGISTRY_SECRET)
// and LANDFLOW_TRANSPORT_SECRET_PREVIOUS from getenv (nil = os.Getenv); it
// returns ErrMissingSecret when neither is set.
func KeyringFromEnv(getenv func(string) string) (*Keyring, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	current := getenv(TransportSecretEnv)
	if current == "" {
		current = getenv(RegistrySecretEnv)
	}
	if current == "" {
		return nil, ErrMissingSecret
	}
	var previous []string
	for _, s := range strings.Split(getenv(TransportSecretPreviousEnv), ",") {
		if s = strings.TrimSpace(s); s != "" {
			previous = append(previous, s)
		}
	}
	return NewKeyring(current, previous...)
}

// CurrentKeyID is the id of the key that signs and encrypts.
func (k *Keyring) CurrentKeyID() string { return k.currentKeyID }

// Has reports whether the keyring knows keyID.
func (k *Keyring) Has(keyID string) bool { _, ok := k.secrets[keyID]; return ok }

// Keys returns pluginID's keys under keyID ("" = the current key); ok is false for an unknown key id.
func (k *Keyring) Keys(pluginID, keyID string) (DerivedKeys, bool) {
	if keyID == "" {
		keyID = k.currentKeyID
	}
	secret, ok := k.secrets[keyID]
	if !ok {
		return DerivedKeys{}, false
	}
	cacheKey := keyID + "\n" + pluginID
	k.mu.Lock()
	defer k.mu.Unlock()
	keys, ok := k.cache[cacheKey]
	if !ok {
		keys = DeriveKeys(secret, pluginID)
		k.cache[cacheKey] = keys
	}
	return keys, true
}

// CanonicalForm is what the signature covers: name=value lines in KnownAttributes order (never lfsig) then the body digest.
func CanonicalForm(attributes Attributes, body []byte) string {
	var b strings.Builder
	for _, name := range KnownAttributes {
		if name == "lfsig" {
			continue
		}
		if value := attributes.Get(name); value != "" {
			b.WriteString(name + "=" + value + "\n")
		}
	}
	sum := sha256.Sum256(body)
	b.WriteString(hex.EncodeToString(sum[:]) + "\n")
	return b.String()
}

// Signature is hex HMAC-SHA256 of the canonical form under sigKey.
func Signature(sigKey []byte, attributes Attributes, body []byte) string {
	mac := hmac.New(sha256.New, sigKey)
	mac.Write([]byte(CanonicalForm(attributes, body)))
	return hex.EncodeToString(mac.Sum(nil))
}

func aad(attributes Attributes) []byte { return []byte(attributes.ID + "\n" + attributes.Type) }

// EncryptBody seals plaintext under encKey: nonce ‖ ciphertext ‖ tag, AAD id + "\n" + type. nonce nil = random.
func EncryptBody(encKey []byte, attributes Attributes, plaintext, nonce []byte) []byte {
	if nonce == nil {
		nonce = make([]byte, nonceBytes)
		if _, err := rand.Read(nonce); err != nil {
			panic("transport: crypto/rand failed: " + err.Error())
		}
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		panic("transport: aes: " + err.Error())
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		panic("transport: gcm: " + err.Error())
	}
	out := make([]byte, 0, len(nonce)+len(plaintext)+tagBytes)
	out = append(out, nonce...)
	return gcm.Seal(out, nonce, plaintext, aad(attributes))
}

// DecryptBody opens a sealed body; it returns a *SecurityError (decrypt_failed) for a wrong key or a tampered body.
func DecryptBody(encKey []byte, attributes Attributes, sealed []byte) ([]byte, error) {
	if len(sealed) < nonceBytes+tagBytes {
		return nil, securityErr(ReasonDecryptFailed, "encrypted body is too short")
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, securityErr(ReasonDecryptFailed, "bad key: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, securityErr(ReasonDecryptFailed, "gcm: %v", err)
	}
	plain, err := gcm.Open(nil, sealed[:nonceBytes], sealed[nonceBytes:], aad(attributes))
	if err != nil {
		return nil, securityErr(ReasonDecryptFailed, "encrypted body does not decrypt (wrong key or tampered)")
	}
	if plain == nil {
		plain = []byte{}
	}
	return plain, nil
}

// ReplayGuard remembers accepted event ids for a window, so a replayed event is
// refused. Sweeps lazily; bounded memory. Safe for concurrent use.
type ReplayGuard struct {
	window     time.Duration
	maxEntries int
	mu         sync.Mutex
	seen       map[string]time.Time
	order      []string // insertion order, for sweeping the oldest first
}

// NewReplayGuard builds a guard; window 0 = 2 × DefaultClockSkew, maxEntries 0 = 100 000.
func NewReplayGuard(window time.Duration, maxEntries int) *ReplayGuard {
	if window <= 0 {
		window = 2 * DefaultClockSkew
	}
	if maxEntries <= 0 {
		maxEntries = 100_000
	}
	return &ReplayGuard{window: window, maxEntries: maxEntries, seen: map[string]time.Time{}}
}

// Accept is true the first time an id is seen inside the window; false for a replay.
func (g *ReplayGuard) Accept(id string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sweep(now)
	if _, dup := g.seen[id]; dup {
		return false
	}
	g.seen[id] = now.Add(g.window)
	g.order = append(g.order, id)
	return true
}

// Forget drops an id (the core nacked the event without using it, so a redelivery is legitimate).
func (g *ReplayGuard) Forget(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.seen, id)
}

// Size is the number of ids remembered.
func (g *ReplayGuard) Size() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.seen)
}

func (g *ReplayGuard) sweep(now time.Time) {
	if len(g.seen) < g.maxEntries {
		// Cheap amortised sweep: look at the oldest entries only.
		budget := 16
		for len(g.order) > 0 && budget > 0 {
			id := g.order[0]
			expires, ok := g.seen[id]
			if ok && expires.After(now) {
				break
			}
			g.order = g.order[1:]
			if ok {
				delete(g.seen, id)
			}
			budget--
		}
		return
	}
	kept := g.order[:0]
	for _, id := range g.order {
		expires, ok := g.seen[id]
		if !ok {
			continue
		}
		if !expires.After(now) {
			delete(g.seen, id)
			continue
		}
		kept = append(kept, id)
	}
	g.order = kept
	// Still full: drop the oldest half rather than refuse new traffic.
	if len(g.seen) >= g.maxEntries {
		drop := g.maxEntries / 2
		if drop > len(g.order) {
			drop = len(g.order)
		}
		for _, id := range g.order[:drop] {
			delete(g.seen, id)
		}
		g.order = append([]string(nil), g.order[drop:]...)
	}
}

// SealOptions tunes Seal.
type SealOptions struct {
	// Encrypt the body (requests and responses). Announce, withdraw and cancel bodies stay plain.
	Encrypt bool
	// Nonce is a test hook: a fixed nonce for known-answer vectors.
	Nonce []byte
}

// Seal encrypts (optionally) and signs a plain event under pluginID's current
// keys. It returns a new event; the input is not changed.
func Seal(keyring *Keyring, pluginID string, event RawEvent, opts SealOptions) RawEvent {
	keys, _ := keyring.Keys(pluginID, "")
	attributes := event.Attributes
	attributes.LfKeyID = keys.KeyID
	attributes.LfSig = ""
	body := event.Body
	if opts.Encrypt {
		attributes.LfEnc = EncAESGCM
		attributes.DataContentType = EncryptedContentType
		body = EncryptBody(keys.Enc, attributes, event.Body, opts.Nonce)
	} else {
		attributes.LfEnc = ""
		attributes.DataContentType = JSONContentType
	}
	attributes.LfSig = Signature(keys.Sig, attributes, body)
	return RawEvent{Attributes: attributes, Body: body}
}

// OpenOptions tunes Open.
type OpenOptions struct {
	// Now is the receiver's clock (zero = time.Now()).
	Now time.Time
	// ClockSkew tolerance (0 = DefaultClockSkew).
	ClockSkew time.Duration
	// Replay, when given, refuses ids already accepted.
	Replay *ReplayGuard
}

// Open verifies a received event under pluginID's keys and decrypts its body.
// It returns a *SecurityError; on success the returned event has a plain JSON
// body and the attributes as received (lfsig, lfkeyid, lfenc included, for logging).
func Open(keyring *Keyring, pluginID string, event RawEvent, opts OpenOptions) (RawEvent, error) {
	attributes := event.Attributes
	if attributes.LfSig == "" || attributes.LfKeyID == "" {
		return RawEvent{}, securityErr(ReasonUnsigned, "event %s is not signed", attributes.ID)
	}
	keys, ok := keyring.Keys(pluginID, attributes.LfKeyID)
	if !ok {
		return RawEvent{}, securityErr(ReasonUnknownKey, "event %s is signed with unknown key %s", attributes.ID, attributes.LfKeyID)
	}
	expected, _ := hex.DecodeString(Signature(keys.Sig, attributes, event.Body))
	given, err := hex.DecodeString(attributes.LfSig)
	if err != nil || !hmac.Equal(expected, given) {
		return RawEvent{}, securityErr(ReasonBadSignature, "event %s has a bad signature", attributes.ID)
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	skew := opts.ClockSkew
	if skew <= 0 {
		skew = DefaultClockSkew
	}
	sent, err := time.Parse(time.RFC3339Nano, attributes.Time)
	if err != nil || now.Sub(sent) > skew || sent.Sub(now) > skew {
		return RawEvent{}, securityErr(ReasonClockSkew, "event %s was sent at %s, outside the %d ms clock-skew window", attributes.ID, attributes.Time, skew.Milliseconds())
	}
	if opts.Replay != nil && !opts.Replay.Accept(attributes.ID, now) {
		return RawEvent{}, securityErr(ReasonReplay, "event %s was already received (replay)", attributes.ID)
	}
	body := event.Body
	if attributes.LfEnc != "" {
		if body, err = DecryptBody(keys.Enc, attributes, event.Body); err != nil {
			return RawEvent{}, err
		}
	}
	return RawEvent{Attributes: attributes, Body: body}, nil
}

// RegistryProof is the protocol §13 proof: hex HMAC-SHA256 of
// "landflow-registry-proof/v1\n<pluginId>\n<challenge>", keyed with the registry secret.
func RegistryProof(secret, pluginID, challenge string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("landflow-registry-proof/v1\n" + pluginID + "\n" + challenge))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyRegistryProof checks a proof (constant-time); false for an empty or malformed one.
func VerifyRegistryProof(secret, pluginID, challenge, proof string) bool {
	if len(proof) != 64 {
		return false
	}
	given, err := hex.DecodeString(proof)
	if err != nil {
		return false
	}
	expected, _ := hex.DecodeString(RegistryProof(secret, pluginID, challenge))
	return hmac.Equal(expected, given)
}
