package transport

// The codec the core uses on both sides: picks the CloudEvents mode from the
// driver's capabilities, seals (encrypts and signs) outgoing events, and
// decodes, verifies and decrypts incoming ones.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"
)

// Logger receives the core's log lines. level is "debug", "info", "warn" or
// "error"; fields are key/value pairs.
type Logger func(level, message string, fields ...any)

// SilentLogger drops everything.
func SilentLogger(string, string, ...any) {}

// StdLogger logs through a *log.Logger with the [landflow:messaging] prefix (nil = log.Default()).
func StdLogger(l *log.Logger) Logger {
	if l == nil {
		l = log.Default()
	}
	return func(level, message string, fields ...any) {
		if level == "debug" {
			return
		}
		if len(fields) == 0 {
			l.Printf("[landflow:messaging] %s %s", level, message)
			return
		}
		l.Printf("[landflow:messaging] %s %s %v", level, message, fields)
	}
}

// PackedEvent is an encoded, sealed event ready to publish.
type PackedEvent struct {
	Attributes Attributes
	Wire       WireEvent
	Size       WireSize
}

// CodecOptions tunes a Codec.
type CodecOptions struct {
	ClockSkew time.Duration
	// Replay protection for received events; the server uses one, the client none (replies correlate to pending calls).
	Replay *ReplayGuard
	// Now is the clock (nil = time.Now).
	Now func() time.Time
	// Claims, when set, carries an event that does not fit the broker by reference (the claim check).
	Claims ClaimStore
}

// Codec packs and unpacks events for one driver.
type Codec struct {
	Mode         WireMode
	keyring      *Keyring
	capabilities Capabilities
	opts         CodecOptions
}

// NewCodec builds a codec: binary mode when the driver has headers, structured otherwise.
func NewCodec(keyring *Keyring, capabilities Capabilities, opts CodecOptions) *Codec {
	mode := ModeStructured
	if capabilities.Headers {
		mode = ModeBinary
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Codec{Mode: mode, keyring: keyring, capabilities: capabilities, opts: opts}
}

// Now is the codec's clock.
func (c *Codec) Now() time.Time { return c.opts.Now() }

// Base returns the attributes every event starts from.
func (c *Codec) Base(source, typ string) Attributes {
	return Attributes{SpecVersion: CESpecVersion, ID: NewEventID(), Source: source, Type: typ, Time: FormatTime(c.opts.Now()), DataContentType: JSONContentType}
}

// Pack serialises data (any JSON-marshalable value, json.RawMessage or valid
// JSON bytes), seals it under pluginID's key and encodes it. It checks the
// broker's size limits and returns an *EnvelopeError (too_large).
func (c *Codec) Pack(pluginID string, attributes Attributes, data any, encrypt bool) (PackedEvent, error) {
	body, err := SerializeBody(data)
	if err != nil {
		return PackedEvent{}, err
	}
	return c.PackBody(pluginID, attributes, body, encrypt)
}

// PackBody is Pack for an already serialised JSON body.
func (c *Codec) PackBody(pluginID string, attributes Attributes, body []byte, encrypt bool) (PackedEvent, error) {
	sealed := Seal(c.keyring, pluginID, RawEvent{Attributes: attributes, Body: body}, SealOptions{Encrypt: encrypt})
	wire, size, err := EncodeWire(sealed, c.Mode)
	if err != nil {
		return PackedEvent{}, err
	}
	if size.TotalBytes > c.capabilities.MaxMessageBytes {
		return PackedEvent{}, envelopeErr(ReasonTooLarge, "event is %d bytes; the broker takes at most %d", size.TotalBytes, c.capabilities.MaxMessageBytes)
	}
	if c.capabilities.MaxHeaderBytes > 0 && size.HeaderBytes > c.capabilities.MaxHeaderBytes {
		return PackedEvent{}, envelopeErr(ReasonTooLarge, "event headers are %d bytes; the broker takes at most %d", size.HeaderBytes, c.capabilities.MaxHeaderBytes)
	}
	return PackedEvent{Attributes: sealed.Attributes, Wire: wire, Size: size}, nil
}

// ClaimedEvent is a PackedEvent that may have gone by reference.
type ClaimedEvent struct {
	PackedEvent
	// ClaimKey is the object holding the body, "" when the event fit.
	ClaimKey string
}

func (c *Codec) fits(size WireSize) bool {
	return size.TotalBytes <= c.capabilities.MaxMessageBytes && (c.capabilities.MaxHeaderBytes <= 0 || size.HeaderBytes <= c.capabilities.MaxHeaderBytes)
}

// PackBodyClaimed is PackBody, but an encrypted event that does not fit the
// broker's limits is stored in the claim store and sent by reference
// (ClaimKey says where; the caller deletes it when the call fails). Without a
// store, or when even the reference does not fit, it returns the *EnvelopeError
// (too_large) PackBody does; a store failure is a *ClaimError (store).
func (c *Codec) PackBodyClaimed(ctx context.Context, pluginID string, attributes Attributes, body []byte, encrypt bool) (ClaimedEvent, error) {
	if c.opts.Claims == nil || !encrypt {
		packed, err := c.PackBody(pluginID, attributes, body, encrypt)
		return ClaimedEvent{PackedEvent: packed}, err
	}
	sealed := Seal(c.keyring, pluginID, RawEvent{Attributes: attributes, Body: body}, SealOptions{Encrypt: encrypt})
	wire, size, err := EncodeWire(sealed, c.Mode)
	if err != nil {
		return ClaimedEvent{}, err
	}
	if c.fits(size) {
		return ClaimedEvent{PackedEvent: PackedEvent{Attributes: sealed.Attributes, Wire: wire, Size: size}}, nil
	}
	key := ClaimKeyFor(c.opts.Now(), sealed.Attributes.ID)
	claimed := WithClaim(c.keyring, pluginID, sealed, key)
	wire, size, err = EncodeWire(RawEvent{Attributes: claimed.Attributes}, c.Mode)
	if err != nil {
		return ClaimedEvent{}, err
	}
	if !c.fits(size) {
		return ClaimedEvent{}, envelopeErr(ReasonTooLarge, "even by reference the event is %d bytes (headers %d); the broker takes at most %d", size.TotalBytes, size.HeaderBytes, c.capabilities.MaxMessageBytes)
	}
	if err := c.opts.Claims.Put(ctx, key, claimed.Body); err != nil {
		return ClaimedEvent{}, &ClaimError{Reason: "store", Message: fmt.Sprintf("could not store the %d-byte body in the claim store: %v", len(claimed.Body), err)}
	}
	return ClaimedEvent{PackedEvent: PackedEvent{Attributes: claimed.Attributes, Wire: wire, Size: size}, ClaimKey: key}, nil
}

// PackBodyClaimedAny is PackBodyClaimed for any JSON-marshalable value.
func (c *Codec) PackBodyClaimedAny(ctx context.Context, pluginID string, attributes Attributes, data any, encrypt bool) (ClaimedEvent, error) {
	body, err := SerializeBody(data)
	if err != nil {
		return ClaimedEvent{}, err
	}
	return c.PackBodyClaimed(ctx, pluginID, attributes, body, encrypt)
}

// ResolveClaim completes an event that carries lfclaim: it checks the
// signature (the body's digest is lfclaimsha256), fetches the body and checks
// its size and digest. It returns a *SecurityError (bad signature: drop the
// event) or a *ClaimError (store down, object missing or wrong: the sender can
// be told). Events without a claim pass through, with an empty key.
func (c *Codec) ResolveClaim(ctx context.Context, raw RawEvent, pluginID string) (RawEvent, string, error) {
	a := raw.Attributes
	if a.LfClaim == "" {
		return raw, "", nil
	}
	if err := VerifyClaimed(c.keyring, pluginID, a); err != nil {
		return raw, "", err
	}
	if c.opts.Claims == nil {
		return raw, "", &ClaimError{Reason: "invalid", Message: "the event carries its body in a claim store and none is configured here (LANDFLOW_CLAIM_STORE)"}
	}
	if len(raw.Body) != 0 || !claimKeyPattern.MatchString(a.LfClaim) {
		return raw, "", &ClaimError{Reason: "invalid", Message: "malformed claim reference"}
	}
	body, err := c.opts.Claims.Get(ctx, a.LfClaim)
	if errors.Is(err, ErrClaimNotFound) {
		return raw, "", &ClaimError{Reason: "missing", Message: fmt.Sprintf("the claim %s is gone (expired or already deleted)", a.LfClaim)}
	}
	if err != nil {
		return raw, "", &ClaimError{Reason: "store", Message: fmt.Sprintf("could not fetch the claim %s: %v", a.LfClaim, err)}
	}
	if strconv.Itoa(len(body)) != a.LfClaimSize {
		return raw, "", &ClaimError{Reason: "size", Message: fmt.Sprintf("the claim %s is %d bytes, not the %s announced", a.LfClaim, len(body), a.LfClaimSize)}
	}
	if SHA256Hex(body) != a.LfClaimSHA256 {
		return raw, "", &ClaimError{Reason: "digest", Message: fmt.Sprintf("the claim %s does not match its digest", a.LfClaim)}
	}
	return RawEvent{Attributes: a, Body: body}, a.LfClaim, nil
}

// Peek decodes without verifying: the attributes are needed to know which plugin's key applies.
func (c *Codec) Peek(wire WireEvent) (RawEvent, error) {
	return DecodeWire(wire, DecodeOptions{MaxBytes: c.capabilities.MaxMessageBytes})
}

// ForgetReplay lets an id through again (the event was put back for another consumer).
func (c *Codec) ForgetReplay(id string) {
	if c.opts.Replay != nil {
		c.opts.Replay.Forget(id)
	}
}

// Unpack verifies a peeked event under pluginID's key with the codec's replay
// guard and returns it with a plain JSON body.
func (c *Codec) Unpack(raw RawEvent, pluginID string) (RawEvent, error) {
	return c.UnpackWith(raw, pluginID, c.opts.Replay)
}

// UnpackWith is Unpack with an explicit replay guard (nil = none).
func (c *Codec) UnpackWith(raw RawEvent, pluginID string, replay *ReplayGuard) (RawEvent, error) {
	return Open(c.keyring, pluginID, raw, OpenOptions{ClockSkew: c.opts.ClockSkew, Replay: replay, Now: c.opts.Now()})
}

// IsDropReason reports whether err is an envelope or security failure: the core drops such events.
func IsDropReason(err error) bool {
	var ee *EnvelopeError
	var se *SecurityError
	return errors.As(err, &ee) || errors.As(err, &se)
}
