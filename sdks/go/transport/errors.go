package transport

// Typed errors of Client.Call. The selector acts on Knowledge: a call moves to
// another transport only when it provably was not delivered (NotDelivered);
// otherwise the error surfaces, so nothing runs twice (docs/transports.md
// "Choosing a transport per call", rule 7). Mirrors packages/transports/src/errors.ts.

import (
	"errors"
	"fmt"
	"time"
)

// Knowledge is what is known about whether the plugin got the request.
type Knowledge string

const (
	NotDelivered   Knowledge = "not-delivered"
	MaybeDelivered Knowledge = "maybe-delivered"
	Delivered      Knowledge = "delivered"
)

// MessagingError is implemented by every error Client.Call returns for a
// messaging reason (never for a caller bug such as a nil body).
type MessagingError interface {
	error
	// Knowledge says whether the call may have run.
	Knowledge() Knowledge
	// Code is the short machine-readable code ("unroutable", "deadline", "manifest_mismatch", …).
	Code() string
}

// UndeliverableReason says why a call is provably undelivered.
type UndeliverableReason string

const (
	// Unroutable: the driver reported that nobody can take the event (NATS no responders, RabbitMQ mandatory).
	ReasonUnroutable UndeliverableReason = "unroutable"
	// NoConsumers: every instance the registry channel had announced has stopped heartbeating, or the channel shows zero consumers.
	ReasonNoConsumers UndeliverableReason = "no_consumers"
	// NotConnected: the connection was not open (connect failed, or the client is closed) before anything was published.
	ReasonNotConnected UndeliverableReason = "not_connected"
	// TooLarge: the encoded event is bigger than the driver's MaxMessageBytes (or the header budget).
	ReasonTooLargeEvent UndeliverableReason = "too_large"
	// Aborted: the call was cancelled before it was published.
	ReasonAborted UndeliverableReason = "aborted"
	// ClaimFailed: the body is too big for the broker and the claim store could not take it (nothing was published).
	ReasonClaimFailed UndeliverableReason = "claim_failed"
)

// UndeliverableError: provably not delivered; safe to send over another transport.
type UndeliverableError struct {
	Reason  UndeliverableReason
	Message string
}

func (e *UndeliverableError) Error() string        { return e.Message }
func (e *UndeliverableError) Knowledge() Knowledge { return NotDelivered }
func (e *UndeliverableError) Code() string         { return string(e.Reason) }

// TimeoutError: the deadline passed without a reply. The plugin may have run the call.
type TimeoutError struct {
	Deadline time.Time
	Message  string
}

func (e *TimeoutError) Error() string        { return e.Message }
func (e *TimeoutError) Knowledge() Knowledge { return MaybeDelivered }
func (e *TimeoutError) Code() string         { return "deadline" }

// CancelledError: the caller cancelled after the request was published; a
// cancel event went out, but the plugin may have finished first.
type CancelledError struct{ Message string }

func (e *CancelledError) Error() string {
	if e.Message == "" {
		return "the call was cancelled"
	}
	return e.Message
}
func (e *CancelledError) Knowledge() Knowledge { return MaybeDelivered }
func (e *CancelledError) Code() string         { return "cancelled" }

// ConnectionLostError: the connection (and with it the reply inbox) was lost while the call was in flight.
type ConnectionLostError struct{ Message string }

func (e *ConnectionLostError) Error() string {
	if e.Message == "" {
		return "connection lost; the call may have run"
	}
	return e.Message
}
func (e *ConnectionLostError) Knowledge() Knowledge { return MaybeDelivered }
func (e *ConnectionLostError) Code() string         { return "connection_lost" }

// RemoteError: the plugin answered with an error code in lferror (the body is
// {error, …}). Delivered, so never retried blindly.
type RemoteError struct {
	RemoteCode RemoteErrorCode
	Message    string
	// Details is the response body as decoded JSON (an object), nil when none.
	Details map[string]any
}

func (e *RemoteError) Error() string        { return e.Message }
func (e *RemoteError) Knowledge() Knowledge { return Delivered }
func (e *RemoteError) Code() string         { return string(e.RemoteCode) }

// ClaimUnavailableError: a body travelling through the claim store could not be
// read (expired or deleted, the store is down, size or digest do not match). In
// the request direction the plugin refused the call before running it
// (NotDelivered, so the selector may use another transport); in the response
// direction it has already run it (Delivered).
type ClaimUnavailableError struct {
	Message string
	// Response is true when the plugin's reply was unreadable.
	Response bool
}

func (e *ClaimUnavailableError) Error() string { return e.Message }
func (e *ClaimUnavailableError) Knowledge() Knowledge {
	if e.Response {
		return Delivered
	}
	return NotDelivered
}
func (e *ClaimUnavailableError) Code() string { return string(CodeClaimUnavailable) }

// ManifestMismatchError: the plugin's manifest differs from the one the host
// knows: pull the manifest again, then retry. It unwraps to a *RemoteError with
// code manifest_mismatch.
type ManifestMismatchError struct {
	Expected string
	Actual   string
}

func (e *ManifestMismatchError) Error() string {
	expected, actual := e.Expected, e.Actual
	if expected == "" {
		expected = "none"
	}
	if actual == "" {
		actual = "unknown"
	}
	return fmt.Sprintf("manifest mismatch: the host knows %s, the plugin runs %s", expected, actual)
}
func (e *ManifestMismatchError) Knowledge() Knowledge { return Delivered }
func (e *ManifestMismatchError) Code() string         { return string(CodeManifestMismatch) }
func (e *ManifestMismatchError) Unwrap() error {
	return &RemoteError{RemoteCode: CodeManifestMismatch, Message: e.Error(), Details: map[string]any{"manifestHash": e.Actual}}
}

// UsageError: the caller's own mistake (bad arguments, client not started). Nothing was sent.
type UsageError struct{ Message string }

func (e *UsageError) Error() string        { return e.Message }
func (e *UsageError) Knowledge() Knowledge { return NotDelivered }
func (e *UsageError) Code() string         { return "usage" }

// AsMessagingError returns the MessagingError in err's chain, if any.
func AsMessagingError(err error) (MessagingError, bool) {
	var me MessagingError
	if errors.As(err, &me) {
		return me, true
	}
	return nil, false
}

// IsProvablyUndelivered is true when the selector may send the same call over another transport.
func IsProvablyUndelivered(err error) bool {
	me, ok := AsMessagingError(err)
	return ok && me.Knowledge() == NotDelivered
}
