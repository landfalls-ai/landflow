package landflow

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Webhook signature verification: HMAC-SHA256 over the raw request body, as
// GitHub (X-Hub-Signature-256: sha256=<hex>), Stripe (Stripe-Signature:
// t=<ts>,v1=<hex>) and Slack (X-Slack-Signature: v0=<hex> with
// X-Slack-Request-Timestamp) sign their calls. App webhook triggers
// (docs/protocol.md §12) call these from Webhook with ctx.RawBody(); the
// TypeScript and Python SDKs have the same helpers. Comparisons are
// constant-time, and the timestamped schemes reject calls outside the
// tolerance so a captured request cannot be replayed later.
//
//	if !landflow.VerifyGitHubSignature(secret, ctx.RawBody(), ctx.Header("X-Hub-Signature-256")) {
//		return &landflow.WebhookResult{Response: &landflow.WebhookReply{Status: 401}}, nil
//	}

// DefaultSignatureTolerance is how far a signed timestamp may be from now
// (Stripe's and Slack's default: five minutes).
const DefaultSignatureTolerance = 5 * time.Minute

// HMACSHA256Hex is the hex HMAC-SHA256 of payload with secret.
func HMACSHA256Hex(secret, payload []byte) string {
	return hex.EncodeToString(hmacSum(secret, payload))
}

// HMACSHA256Base64 is the base64 HMAC-SHA256 of payload with secret.
func HMACSHA256Base64(secret, payload []byte) string {
	return base64.StdEncoding.EncodeToString(hmacSum(secret, payload))
}

func hmacSum(secret, payload []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return mac.Sum(nil)
}

// SafeEqual compares two strings in constant time.
func SafeEqual(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

// VerifyHMACSHA256 reports whether signature (hex, compared case-insensitively,
// after prefix such as "sha256=") is the HMAC-SHA256 of payload. An empty
// secret or signature never verifies.
func VerifyHMACSHA256(secret, payload []byte, signature, prefix string) bool {
	text := strings.TrimSpace(signature)
	if text == "" || len(secret) == 0 {
		return false
	}
	if prefix != "" {
		if len(text) < len(prefix) || !strings.EqualFold(text[:len(prefix)], prefix) {
			return false
		}
		text = text[len(prefix):]
	}
	return SafeEqual(strings.ToLower(text), HMACSHA256Hex(secret, payload))
}

// VerifyHMACSHA256Base64 reports whether signature is the base64 HMAC-SHA256 of payload.
func VerifyHMACSHA256Base64(secret, payload []byte, signature string) bool {
	text := strings.TrimSpace(signature)
	return text != "" && len(secret) > 0 && SafeEqual(text, HMACSHA256Base64(secret, payload))
}

func fresh(timestamp int64, tolerance time.Duration, now time.Time) bool {
	if now.IsZero() {
		now = time.Now()
	}
	delta := now.Sub(time.Unix(timestamp, 0))
	if delta < 0 {
		delta = -delta
	}
	return delta <= tolerance
}

// GitHubSignature is GitHub's X-Hub-Signature-256 value for body: "sha256=<hex>".
func GitHubSignature(secret string, body []byte) string {
	return "sha256=" + HMACSHA256Hex([]byte(secret), body)
}

// VerifyGitHubSignature reports whether header (X-Hub-Signature-256) signs body with the webhook's secret.
func VerifyGitHubSignature(secret string, body []byte, header string) bool {
	return VerifyHMACSHA256([]byte(secret), body, header, "sha256=")
}

// SignatureOptions tunes the timestamped schemes: Tolerance (default
// DefaultSignatureTolerance) and Now (default time.Now(); tests).
type SignatureOptions struct {
	Tolerance time.Duration
	Now       time.Time
}

func (o SignatureOptions) tolerance() time.Duration {
	if o.Tolerance <= 0 {
		return DefaultSignatureTolerance
	}
	return o.Tolerance
}

// StripeSignature is a Stripe-Signature value: "t=<timestamp>,v1=<hmac of "<timestamp>.<body>">".
func StripeSignature(secret string, body []byte, timestamp int64) string {
	payload := append([]byte(strconv.FormatInt(timestamp, 10)+"."), body...)
	return fmt.Sprintf("t=%d,v1=%s", timestamp, HMACSHA256Hex([]byte(secret), payload))
}

// VerifyStripeSignature reports whether a Stripe-Signature-style header signs
// body with t within the tolerance. Several v1 entries (secret rotation) are accepted.
func VerifyStripeSignature(secret string, body []byte, header string, opts SignatureOptions) bool {
	var timestamp string
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch {
		case key == "t":
			timestamp = value
		case key == "v1" && value != "":
			signatures = append(signatures, value)
		}
	}
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || ts < 0 || len(signatures) == 0 || !fresh(ts, opts.tolerance(), opts.Now) {
		return false
	}
	payload := append([]byte(timestamp+"."), body...)
	ok := false
	for _, signature := range signatures {
		ok = VerifyHMACSHA256([]byte(secret), payload, signature, "") || ok
	}
	return ok
}

// SlackSignature is Slack's X-Slack-Signature for body sent at timestamp (X-Slack-Request-Timestamp).
func SlackSignature(signingSecret string, body []byte, timestamp string) string {
	return "v0=" + HMACSHA256Hex([]byte(signingSecret), append([]byte("v0:"+timestamp+":"), body...))
}

// VerifySlackSignature reports whether Slack's X-Slack-Signature signs body
// with the app's signing secret, sent within the tolerance.
func VerifySlackSignature(signingSecret string, body []byte, timestamp, signature string, opts SignatureOptions) bool {
	timestamp = strings.TrimSpace(timestamp)
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || ts < 0 || !fresh(ts, opts.tolerance(), opts.Now) {
		return false
	}
	return VerifyHMACSHA256([]byte(signingSecret), append([]byte("v0:"+timestamp+":"), body...), signature, "v0=")
}
