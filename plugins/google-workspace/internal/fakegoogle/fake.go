// Package fakegoogle is an in-memory imitation of the Google APIs the plugin
// calls: the OAuth 2.0 token endpoint (JWT-bearer and refresh-token grants),
// Sheets, Gmail, Drive, Calendar, Docs and userinfo. It is a test double: it
// verifies the service-account JWT, checks bearer tokens and the shape of
// requests, and keeps just enough state to answer them. Plugin tests serve it
// with httptest; cmd/fakegoogle serves it for the live check.
package fakegoogle

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const jwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer"

// Server is the fake. Configure the exported fields before serving it; read
// state while it serves through Do.
type Server struct {
	mu sync.Mutex

	// PublicKey verifies service-account JWT signatures (nil: not checked).
	PublicKey *rsa.PublicKey
	// ServiceAccountEmail, when set, must be the JWT's iss.
	ServiceAccountEmail string
	// ClientID, ClientSecret and RefreshToken accept the refresh-token grant.
	ClientID, ClientSecret, RefreshToken string
	// OAuthScope is returned as "scope" by the refresh-token grant.
	OAuthScope string
	// TokenTTL is expires_in in seconds (default 3600).
	TokenTTL int
	// PageSize, when set, caps the page size of list calls (to test paging).
	PageSize int
	// Log, when set, receives one line per request (method and path only).
	Log func(format string, args ...any)

	Exchanges []Exchange
	Requests  []Request

	Spreadsheets map[string]*Spreadsheet
	Mail         *Mailbox
	Files        map[string]*File
	Calendars    map[string]*Calendar
	Documents    map[string]*Document

	tokens   map[string]tokenInfo
	failures []failure
	nextID   int
}

// Exchange records one call of the token endpoint.
type Exchange struct {
	GrantType string
	Claims    map[string]any // the verified JWT claims (service account)
	Error     string         // OAuth error code when rejected
}

// Request records one API call (the token endpoint's body is not kept).
type Request struct {
	Method string
	Path   string // decoded
	Query  url.Values
	Header http.Header
	Body   []byte
}

type tokenInfo struct {
	serviceAccount bool
	subject        string
	expires        time.Time
}

type failure struct {
	method, path string
	status       int
	message      string
}

// New returns a fake with an empty mailbox (me@example.com), a primary
// calendar in Europe/Berlin and no files.
func New() *Server {
	return &Server{
		TokenTTL:     3600,
		OAuthScope:   "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets https://mail.google.com/",
		tokens:       map[string]tokenInfo{},
		Spreadsheets: map[string]*Spreadsheet{},
		Mail:         &Mailbox{Email: "me@example.com", Labels: defaultLabels()},
		Files:        map[string]*File{},
		Calendars: map[string]*Calendar{
			"me@example.com": {ID: "me@example.com", Summary: "Me", TimeZone: "Europe/Berlin", Primary: true},
		},
		Documents: map[string]*Document{},
	}
}

// Do runs fn with the fake's state locked.
func (s *Server) Do(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
}

// Fail makes the next request whose method matches (or method "") and whose
// path contains path answer status with a Google error.
func (s *Server) Fail(method, path string, status int, message string) {
	s.Do(func() { s.failures = append(s.failures, failure{method, path, status, message}) })
}

// RevokeTokens forgets every issued access token (calls then get 401).
func (s *Server) RevokeTokens() { s.Do(func() { s.tokens = map[string]tokenInfo{} }) }

// Calls returns the recorded requests with this method whose path starts
// with prefix.
func (s *Server) Calls(method, prefix string) []Request {
	var out []Request
	s.Do(func() {
		for _, r := range s.Requests {
			if (method == "" || r.Method == method) && strings.HasPrefix(r.Path, prefix) {
				out = append(out, r)
			}
		}
	})
	return out
}

// ExchangeList returns a copy of the token exchanges.
func (s *Server) ExchangeList() []Exchange {
	var out []Exchange
	s.Do(func() { out = append(out, s.Exchanges...) })
	return out
}

// pageSize applies PageSize to a requested page size.
func (s *Server) pageSize(requested, def int) int {
	if requested <= 0 {
		requested = def
	}
	if s.PageSize > 0 && requested > s.PageSize {
		return s.PageSize
	}
	return requested
}

func (s *Server) id(prefix string) string {
	s.nextID++
	return fmt.Sprintf("%s-%d", prefix, s.nextID)
}

// ServeHTTP routes a request.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	segs := splitPath(r.URL.EscapedPath())
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Log != nil {
		s.Log("%s %s", r.Method, r.URL.Path)
	}
	if r.URL.Path == "/token" {
		s.token(w, r, body)
		return
	}
	s.Requests = append(s.Requests, Request{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Header: r.Header.Clone(), Body: body})
	if len(segs) > 0 && segs[0] == "_fake" {
		s.admin(w, r, segs[1:], body)
		return
	}
	for k, f := range s.failures {
		if (f.method == "" || f.method == r.Method) && strings.Contains(r.URL.Path, f.path) {
			s.failures = append(s.failures[:k], s.failures[k+1:]...)
			writeError(w, f.status, f.message)
			return
		}
	}
	info, ok := s.authorize(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "Request had invalid authentication credentials. Expected OAuth 2 access token.")
		return
	}
	switch {
	case hasPrefix(segs, "v4", "spreadsheets"):
		s.sheets(w, r, segs[2:], body)
	case hasPrefix(segs, "gmail", "v1", "users", "me"):
		if info.serviceAccount && info.subject == "" {
			writeError(w, http.StatusBadRequest, "Precondition check failed.")
			return
		}
		s.gmail(w, r, segs[4:], body)
	case hasPrefix(segs, "drive", "v3", "files"):
		s.drive(w, r, segs[3:], body)
	case hasPrefix(segs, "upload", "gmail", "v1", "users", "me", "messages", "send"):
		if info.serviceAccount && info.subject == "" {
			writeError(w, http.StatusBadRequest, "Precondition check failed.")
			return
		}
		s.uploadMessage(w, r, body)
	case hasPrefix(segs, "upload", "drive", "v3", "files"):
		s.upload(w, r, body)
	case hasPrefix(segs, "calendar", "v3"):
		s.calendar(w, r, segs[2:], body)
	case hasPrefix(segs, "v1", "documents"):
		s.docs(w, r, segs[2:], body)
	case hasPrefix(segs, "oauth2", "v3", "userinfo"):
		writeJSON(w, http.StatusOK, map[string]any{"email": s.Mail.Email, "email_verified": true})
	default:
		writeError(w, http.StatusNotFound, "Method not found: "+r.URL.Path)
	}
}

func (s *Server) authorize(r *http.Request) (tokenInfo, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return tokenInfo{}, false
	}
	info, ok := s.tokens[token]
	return info, ok && time.Now().Before(info.expires)
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

func (s *Server) token(w http.ResponseWriter, r *http.Request, body []byte) {
	form, _ := url.ParseQuery(string(body))
	ex := Exchange{GrantType: form.Get("grant_type")}
	reject := func(status int, code, desc string) {
		ex.Error = code
		s.Exchanges = append(s.Exchanges, ex)
		writeJSON(w, status, map[string]any{"error": code, "error_description": desc})
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		reject(http.StatusBadRequest, "invalid_request", "POST a form-encoded body")
		return
	}
	info := tokenInfo{}
	scope := ""
	switch ex.GrantType {
	case jwtBearerGrant:
		claims, err := s.verifyJWT(form.Get("assertion"), "http://"+r.Host+r.URL.Path)
		if err != nil {
			reject(http.StatusBadRequest, "invalid_grant", err.Error())
			return
		}
		ex.Claims = claims
		info.serviceAccount = true
		info.subject, _ = claims["sub"].(string)
	case "refresh_token":
		if s.RefreshToken == "" || form.Get("client_id") != s.ClientID || form.Get("client_secret") != s.ClientSecret {
			reject(http.StatusUnauthorized, "invalid_client", "The OAuth client was not found.")
			return
		}
		if form.Get("refresh_token") != s.RefreshToken {
			reject(http.StatusBadRequest, "invalid_grant", "Token has been expired or revoked.")
			return
		}
		scope = s.OAuthScope
	default:
		reject(http.StatusBadRequest, "unsupported_grant_type", "Invalid grant_type: "+ex.GrantType)
		return
	}
	ttl := s.TokenTTL
	if ttl <= 0 {
		ttl = 3600
	}
	token := fmt.Sprintf("ya29.fake-%d-%s", len(s.Exchanges)+1, randomHex(6))
	info.expires = time.Now().Add(time.Duration(ttl) * time.Second)
	s.tokens[token] = info
	s.Exchanges = append(s.Exchanges, ex)
	resp := map[string]any{"access_token": token, "expires_in": ttl, "token_type": "Bearer"}
	if scope != "" {
		resp["scope"] = scope
	}
	writeJSON(w, http.StatusOK, resp)
}

// verifyJWT checks an RS256 service-account assertion as Google does: the
// signature, iss, aud (the token URL), scope and a lifetime of at most an hour.
func (s *Server) verifyJWT(assertion, aud string) (map[string]any, error) {
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 {
		return nil, errors.New("Invalid JWT: Token must be a short-lived token and in a reasonable timeframe")
	}
	var header map[string]any
	if err := decodeSegment(parts[0], &header); err != nil || header["alg"] != "RS256" {
		return nil, errors.New("Invalid JWT: unsupported algorithm (want RS256)")
	}
	if s.PublicKey != nil {
		sig, err := base64.RawURLEncoding.DecodeString(parts[2])
		sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if err != nil || rsa.VerifyPKCS1v15(s.PublicKey, crypto.SHA256, sum[:], sig) != nil {
			return nil, errors.New("Invalid JWT Signature.")
		}
	}
	var claims map[string]any
	if err := decodeSegment(parts[1], &claims); err != nil {
		return nil, errors.New("Invalid JWT: claims are not JSON")
	}
	iss, _ := claims["iss"].(string)
	if iss == "" || (s.ServiceAccountEmail != "" && iss != s.ServiceAccountEmail) {
		return nil, errors.New("Invalid email or User ID")
	}
	if claims["aud"] != aud {
		return nil, fmt.Errorf("Invalid JWT: aud must be %s", aud)
	}
	if scope, _ := claims["scope"].(string); strings.TrimSpace(scope) == "" {
		return nil, errors.New("Invalid OAuth scope or ID token audience provided.")
	}
	iat, _ := claims["iat"].(float64)
	exp, _ := claims["exp"].(float64)
	if exp <= iat || exp-iat > 3600 {
		return nil, errors.New("Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.")
	}
	return claims, nil
}

func decodeSegment(seg string, out any) error {
	data, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// ---------------------------------------------------------------------------
// Admin endpoints for the live check (/_fake/…)
// ---------------------------------------------------------------------------

func (s *Server) admin(w http.ResponseWriter, r *http.Request, segs []string, body []byte) {
	switch {
	case r.Method == http.MethodPost && hasPrefix(segs, "gmail", "messages"):
		var m SimpleMessage
		if err := json.Unmarshal(body, &m); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		msg := s.addMessage(m)
		writeJSON(w, http.StatusOK, map[string]any{"id": msg.ID, "internalDate": msg.InternalDate})
	case r.Method == http.MethodPost && len(segs) == 3 && segs[0] == "sheets" && segs[2] == "rows":
		var req struct {
			Sheet string  `json:"sheet"`
			Rows  [][]any `json:"rows"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		sh := s.findSheet(segs[1], req.Sheet)
		if sh == nil {
			writeError(w, http.StatusNotFound, "no such sheet")
			return
		}
		sh.Rows = append(trimRows(sh.Rows), req.Rows...)
		writeJSON(w, http.StatusOK, map[string]any{"rows": len(sh.Rows)})
	case r.Method == http.MethodGet && hasPrefix(segs, "state"):
		writeJSON(w, http.StatusOK, s.state())
	default:
		writeError(w, http.StatusNotFound, "unknown admin endpoint")
	}
}

// state summarises the fake for the live check (no tokens, no bodies).
func (s *Server) state() map[string]any {
	sheets := map[string]any{}
	for id, sp := range s.Spreadsheets {
		tabs := map[string]any{}
		for _, sh := range sp.Sheets {
			tabs[sh.Title] = trimRows(sh.Rows)
		}
		sheets[id] = map[string]any{"title": sp.Title, "sheets": tabs}
	}
	var sent []map[string]any
	for _, m := range s.Mail.Messages {
		if contains(m.LabelIDs, "SENT") {
			sent = append(sent, map[string]any{"id": m.ID, "threadId": m.ThreadID, "headers": m.Payload["headers"]})
		}
	}
	var exchanges []map[string]any
	for _, ex := range s.Exchanges {
		e := map[string]any{"grantType": ex.GrantType}
		if ex.Error != "" {
			e["error"] = ex.Error
		}
		if ex.Claims != nil {
			e["iss"], e["sub"], e["scopes"] = ex.Claims["iss"], ex.Claims["sub"], len(strings.Fields(fmt.Sprint(ex.Claims["scope"])))
		}
		exchanges = append(exchanges, e)
	}
	return map[string]any{"spreadsheets": sheets, "messages": len(s.Mail.Messages), "sent": sent, "exchanges": exchanges, "requests": len(s.Requests)}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func splitPath(escaped string) []string {
	var out []string
	for _, seg := range strings.Split(escaped, "/") {
		if seg == "" {
			continue
		}
		if dec, err := url.PathUnescape(seg); err == nil {
			seg = dec
		}
		out = append(out, seg)
	}
	return out
}

func hasPrefix(segs []string, prefix ...string) bool {
	if len(segs) < len(prefix) {
		return false
	}
	for i, p := range prefix {
		if segs[i] != p {
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes Google's JSON error envelope.
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{
		"code": status, "message": message, "status": statusName(status),
		"errors": []any{map[string]any{"message": message, "domain": "global", "reason": strings.ToLower(statusName(status))}},
	}})
}

func statusName(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "INVALID_ARGUMENT"
	case http.StatusUnauthorized:
		return "UNAUTHENTICATED"
	case http.StatusForbidden:
		return "PERMISSION_DENIED"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusTooManyRequests:
		return "RESOURCE_EXHAUSTED"
	}
	if status >= 500 {
		return "INTERNAL"
	}
	return "UNKNOWN"
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func contains(list []string, v string) bool {
	for _, e := range list {
		if e == v {
			return true
		}
	}
	return false
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
