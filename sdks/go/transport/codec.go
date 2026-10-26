package transport

// The codec the core uses on both sides: picks the CloudEvents mode from the
// driver's capabilities, seals (encrypts and signs) outgoing events, and
// decodes, verifies and decrypts incoming ones.

import (
	"errors"
	"log"
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
