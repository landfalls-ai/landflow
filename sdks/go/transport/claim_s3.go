package transport

// S3ClaimStore: an S3-compatible claim store (MinIO, LocalStack, S3) over plain
// net/http with AWS Signature V4, so the core module
// takes no AWS dependency. Path-style addressing by default (what MinIO needs);
// virtual-hosted style with ForcePathStyle false. Credentials: static keys, or
// the in-cluster chain of claim_creds.go (web identity / IRSA, container
// credentials); never ~/.aws files or EC2 IMDS (see claim_creds.go for why).

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// S3ClaimStoreOptions configures an S3ClaimStore.
type S3ClaimStoreOptions struct {
	Bucket string
	// Prefix inside the bucket, e.g. "landflow-claims/".
	Prefix   string
	Endpoint string
	Region   string
	// AccessKeyID / SecretAccessKey / SessionToken are static credentials. Without them, Credentials is used; without that,
	// the chain of ResolveClaimCredentials runs over Getenv.
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	// Credentials supplies (and refreshes) the credentials; it wins over the chain but not over static keys.
	Credentials ClaimCredentialProvider
	// Getenv feeds the credential chain (nil = os.Getenv).
	Getenv func(string) string
	// ForcePathStyle: http://endpoint/bucket/key (MinIO, LocalStack). ParseClaimStore defaults it to true.
	ForcePathStyle bool
	// AllowAWS: the operator deliberately uses the real AWS endpoint (no Endpoint).
	AllowAWS bool
	// HTTPClient overrides the default client (60 s timeout).
	HTTPClient *http.Client
	// Now is the clock for signing (nil = time.Now).
	Now func() time.Time
}

type S3ClaimStore struct {
	opts   S3ClaimStoreOptions
	prefix string
	client *http.Client
	base   *url.URL
	creds  ClaimCredentialProvider
}

// NewS3ClaimStore validates the options. It refuses to start without an explicit endpoint unless AllowAWS is set.
func NewS3ClaimStore(opts S3ClaimStoreOptions) (*S3ClaimStore, error) {
	if opts.Bucket == "" {
		return nil, errors.New("claim store: the bucket is empty")
	}
	if opts.Endpoint == "" && !opts.AllowAWS {
		return nil, errors.New("claim store: refusing to use the default (AWS) endpoint; set ?endpoint=… (MinIO, LocalStack) or ?aws=true if you mean the real S3")
	}
	if opts.Region == "" {
		opts.Region = "us-east-1"
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	creds := opts.Credentials
	if opts.AccessKeyID != "" && opts.SecretAccessKey != "" {
		creds = staticClaimCredentials{ClaimCredentials{AccessKeyID: opts.AccessKeyID, SecretAccessKey: opts.SecretAccessKey, SessionToken: opts.SessionToken}}
	} else if creds == nil {
		var err error
		if creds, err = ResolveClaimCredentials(opts.Getenv, opts.Region, opts.AllowAWS, opts.HTTPClient, opts.Now); err != nil {
			return nil, err
		}
	}
	endpoint := opts.Endpoint
	if endpoint == "" {
		endpoint = "https://s3." + opts.Region + ".amazonaws.com"
	}
	base, err := url.Parse(endpoint)
	if err != nil || base.Host == "" {
		return nil, fmt.Errorf("claim store: endpoint %q is not a URL", endpoint)
	}
	prefix := opts.Prefix
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: claimOperationTimeout}
	}
	return &S3ClaimStore{opts: opts, prefix: prefix, client: client, base: base, creds: creds}, nil
}

func (s *S3ClaimStore) Kind() string { return "s3" }

// CredentialSource names where the store's credentials come from ("static keys", "web identity", "container credentials").
func (s *S3ClaimStore) CredentialSource() string { return s.creds.Source() }

// objectURL returns the host and escaped path (and query) for key ("" = the bucket).
func (s *S3ClaimStore) target(key string, query url.Values) (host, path string) {
	host = s.base.Host
	segments := ""
	if key != "" {
		segments = "/" + s.prefix + key
	}
	if s.opts.ForcePathStyle {
		return host, strings.TrimRight(s.base.Path, "/") + "/" + s.opts.Bucket + segments
	}
	return s.opts.Bucket + "." + host, strings.TrimRight(s.base.Path, "/") + segments + func() string {
		if segments == "" {
			return "/"
		}
		return ""
	}()
}

func s3Escape(path string) string {
	var b strings.Builder
	for i := 0; i < len(path); i++ {
		c := path[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func (s *S3ClaimStore) do(ctx context.Context, method, key string, query url.Values, body []byte) (*http.Response, error) {
	creds, err := s.creds.Retrieve(ctx)
	if err != nil {
		return nil, fmt.Errorf("claim store credentials: %w", err)
	}
	host, path := s.target(key, query)
	if path == "" {
		path = "/"
	}
	canonicalURI := s3Escape(path)
	pairs := make([]string, 0, len(query))
	for k, vs := range query {
		for _, v := range vs {
			pairs = append(pairs, s3QueryEscape(k)+"="+s3QueryEscape(v))
		}
	}
	sort.Strings(pairs)
	canonicalQuery := strings.Join(pairs, "&")
	now := s.opts.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	payloadHash := SHA256Hex(body)
	headers := map[string]string{"host": host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate}
	if creds.SessionToken != "" {
		headers["x-amz-security-token"] = creds.SessionToken
	}
	names := make([]string, 0, len(headers))
	for n := range headers {
		names = append(names, n)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, n := range names {
		canonicalHeaders.WriteString(n + ":" + strings.TrimSpace(headers[n]) + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	canonicalRequest := strings.Join([]string{method, canonicalURI, canonicalQuery, canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
	scope := day + "/" + s.opts.Region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + SHA256Hex([]byte(canonicalRequest))
	signingKey := hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256([]byte("AWS4"+creds.SecretAccessKey), day), s.opts.Region), "s3"), "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(signingKey, toSign))
	target := s.base.Scheme + "://" + host + canonicalURI
	if canonicalQuery != "" {
		target += "?" + canonicalQuery
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for n, v := range headers {
		if n != "host" {
			req.Header.Set(n, v)
		}
	}
	req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", creds.AccessKeyID, scope, signedHeaders, signature))
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	return s.client.Do(req)
}

func s3QueryEscape(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "+", "%20") }

func s3Error(op string, res *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
	return fmt.Errorf("s3 %s: %s: %s", op, res.Status, strings.TrimSpace(string(b)))
}

func (s *S3ClaimStore) Put(ctx context.Context, key string, body []byte) error {
	res, err := s.do(ctx, http.MethodPut, key, nil, body)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return s3Error("put", res)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return nil
}

func (s *S3ClaimStore) Get(ctx context.Context, key string) ([]byte, error) {
	res, err := s.do(ctx, http.MethodGet, key, nil, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, ErrClaimNotFound
	}
	if res.StatusCode/100 != 2 {
		return nil, s3Error("get", res)
	}
	return io.ReadAll(res.Body)
}

func (s *S3ClaimStore) Delete(ctx context.Context, key string) error {
	res, err := s.do(ctx, http.MethodDelete, key, nil, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 && res.StatusCode != http.StatusNotFound {
		return s3Error("delete", res)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return nil
}

func (s *S3ClaimStore) List(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {s.prefix + prefix}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		res, err := s.do(ctx, http.MethodGet, "", q, nil)
		if err != nil {
			return nil, err
		}
		if res.StatusCode/100 != 2 {
			err := s3Error("list", res)
			res.Body.Close()
			return nil, err
		}
		var page struct {
			IsTruncated           bool     `xml:"IsTruncated"`
			NextContinuationToken string   `xml:"NextContinuationToken"`
			Keys                  []string `xml:"Contents>Key"`
		}
		err = xml.NewDecoder(res.Body).Decode(&page)
		res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("s3 list: %w", err)
		}
		for _, k := range page.Keys {
			keys = append(keys, strings.TrimPrefix(k, s.prefix))
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return keys, nil
		}
		token = page.NextContinuationToken
	}
}
