package transport

// The S3 claim store's credential chain against fakes on 127.0.0.1 (ports 7520-7539): a fake STS and a fake container
// credentials endpoint. Nothing here reaches a real AWS endpoint. Not parallel: the tests set package variables.
//
//	go test -race -run ClaimCred .

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// listenOn starts h on a free port in 7520-7539.
func listenOn(t *testing.T, h http.Handler) string {
	t.Helper()
	for port := 7520; port <= 7539; port++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		srv := &httptest.Server{Listener: l, Config: &http.Server{Handler: h}}
		srv.Start()
		t.Cleanup(srv.Close)
		return srv.URL
	}
	t.Fatal("no free port in 7520-7539")
	return ""
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeSTS answers AssumeRoleWithWebIdentity; each call mints credentials expiring ttl after clock.
type fakeSTS struct {
	calls    atomic.Int32
	mu       sync.Mutex
	forms    []map[string]string
	clock    *fakeClock
	ttl      time.Duration
	failNext atomic.Bool
}

func (f *fakeSTS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("Authorization") != "" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
		http.Error(w, "bad request", 400)
		return
	}
	_ = r.ParseForm()
	form := map[string]string{}
	for k := range r.PostForm {
		form[k] = r.PostForm.Get(k)
	}
	f.mu.Lock()
	f.forms = append(f.forms, form)
	f.mu.Unlock()
	n := f.calls.Add(1)
	if f.failNext.CompareAndSwap(true, false) {
		w.WriteHeader(403)
		fmt.Fprint(w, `<ErrorResponse><Error><Code>AccessDenied</Code><Message>nope</Message></Error></ErrorResponse>`)
		return
	}
	exp := f.clock.Now().Add(f.ttl).UTC().Format(time.RFC3339)
	fmt.Fprintf(w, `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials>`+
		`<AccessKeyId>ASIAWEB%d</AccessKeyId><SecretAccessKey>websecret%d</SecretAccessKey><SessionToken>webtoken%d</SessionToken><Expiration>%s</Expiration>`+
		`</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`, n, n, n, exp)
}

func envMap(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func writeTokenFile(t *testing.T, content string) string {
	p := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestClaimCredWebIdentityRefreshAndTokenReread(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	sts := &fakeSTS{clock: clock, ttl: time.Hour}
	url := listenOn(t, sts)
	tokenFile := writeTokenFile(t, "jwt-one\n")
	p, err := ResolveClaimCredentials(envMap(map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": tokenFile, "AWS_ROLE_ARN": "arn:aws:iam::1:role/r", "AWS_ROLE_SESSION_NAME": "sess", "AWS_ENDPOINT_URL_STS": url}), "us-east-1", false, nil, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if p.Source() != "web identity" || sts.calls.Load() != 0 {
		t.Fatalf("lazy: %s %d", p.Source(), sts.calls.Load())
	}
	c1, err := p.Retrieve(ctx)
	if err != nil || c1.AccessKeyID != "ASIAWEB1" || c1.SessionToken != "webtoken1" || !c1.Expires.Equal(clock.Now().Add(time.Hour)) {
		t.Fatalf("first: %+v %v", c1, err)
	}
	f := sts.forms[0]
	if f["Action"] != "AssumeRoleWithWebIdentity" || f["Version"] != "2011-06-15" || f["RoleArn"] != "arn:aws:iam::1:role/r" || f["RoleSessionName"] != "sess" || f["WebIdentityToken"] != "jwt-one" {
		t.Fatalf("form: %v", f)
	}
	clock.Add(54 * time.Minute) // 6 min left: cached
	if c, _ := p.Retrieve(ctx); c.AccessKeyID != "ASIAWEB1" || sts.calls.Load() != 1 {
		t.Fatalf("should be cached: %+v %d", c, sts.calls.Load())
	}
	if err := os.WriteFile(tokenFile, []byte("jwt-two"), 0o600); err != nil {
		t.Fatal(err)
	}
	clock.Add(90 * time.Second) // 4.5 min left: inside the 5 min margin
	c2, err := p.Retrieve(ctx)
	if err != nil || c2.AccessKeyID != "ASIAWEB2" || sts.forms[1]["WebIdentityToken"] != "jwt-two" {
		t.Fatalf("refresh: %+v %v %v", c2, err, sts.forms)
	}
	// A failed refresh keeps the still-valid set; once it is truly expired the error surfaces.
	clock.Add(56 * time.Minute)
	sts.failNext.Store(true)
	if c, err := p.Retrieve(ctx); err != nil || c.AccessKeyID != "ASIAWEB2" {
		t.Fatalf("keep old: %+v %v", c, err)
	}
	clock.Add(10 * time.Minute)
	sts.failNext.Store(true)
	if _, err := p.Retrieve(ctx); err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Fatalf("expired: %v", err)
	}
}

func TestClaimCredWebIdentityNeedsAWSTrueOrEndpoint(t *testing.T) {
	env := map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": "/nonexistent", "AWS_ROLE_ARN": "arn:aws:iam::1:role/r"}
	_, err := ResolveClaimCredentials(envMap(env), "eu-west-1", false, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "AWS_ENDPOINT_URL_STS") || !strings.Contains(err.Error(), "aws=true") {
		t.Fatalf("no aws=true: %v", err)
	}
	p, err := ResolveClaimCredentials(envMap(env), "eu-west-1", true, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := p.(*cachedClaimCredentials).inner.(*webIdentityClaimCredentials).endpoint; got != "https://sts.eu-west-1.amazonaws.com" {
		t.Fatalf("regional endpoint: %s", got)
	}
	env["AWS_ENDPOINT_URL"] = "http://127.0.0.1:1"
	p, _ = ResolveClaimCredentials(envMap(env), "eu-west-1", true, nil, nil)
	if got := p.(*cachedClaimCredentials).inner.(*webIdentityClaimCredentials).endpoint; got != "http://127.0.0.1:1" {
		t.Fatalf("AWS_ENDPOINT_URL: %s", got)
	}
	env["AWS_ENDPOINT_URL_STS"] = "http://127.0.0.1:2"
	p, _ = ResolveClaimCredentials(envMap(env), "eu-west-1", true, nil, nil)
	if got := p.(*cachedClaimCredentials).inner.(*webIdentityClaimCredentials).endpoint; got != "http://127.0.0.1:2" {
		t.Fatalf("AWS_ENDPOINT_URL_STS: %s", got)
	}
}

func TestClaimCredContainerCredentials(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	var calls atomic.Int32
	var lastAuth atomic.Value
	url := listenOn(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		lastAuth.Store(r.Header.Get("Authorization") + "|" + r.URL.Path)
		fmt.Fprintf(w, `{"AccessKeyId":"ASIACTR%d","SecretAccessKey":"s%d","Token":"t%d","Expiration":%q}`, n, n, n, clock.Now().Add(10*time.Minute).UTC().Format(time.RFC3339))
	}))
	tokenFile := writeTokenFile(t, "tok-1\n")
	p, err := ResolveClaimCredentials(envMap(map[string]string{"AWS_CONTAINER_CREDENTIALS_FULL_URI": url + "/creds", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": tokenFile, "AWS_CONTAINER_AUTHORIZATION_TOKEN": "ignored"}), "us-east-1", false, nil, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	c, err := p.Retrieve(ctx)
	if err != nil || c.AccessKeyID != "ASIACTR1" || c.SessionToken != "t1" || lastAuth.Load() != "tok-1|/creds" {
		t.Fatalf("first: %+v %v %v", c, err, lastAuth.Load())
	}
	_, _ = p.Retrieve(ctx)
	if calls.Load() != 1 {
		t.Fatalf("cached: %d", calls.Load())
	}
	_ = os.WriteFile(tokenFile, []byte("tok-2"), 0o600)
	clock.Add(6 * time.Minute) // 4 min left: refresh, and the token file is re-read
	if c, _ := p.Retrieve(ctx); c.AccessKeyID != "ASIACTR2" || lastAuth.Load() != "tok-2|/creds" {
		t.Fatalf("refresh: %+v %v", c, lastAuth.Load())
	}
	// The token from the environment, and the relative URI against the (test-redirected) link-local base.
	old := claimContainerRelativeBase
	claimContainerRelativeBase = url
	defer func() { claimContainerRelativeBase = old }()
	p, err = ResolveClaimCredentials(envMap(map[string]string{"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/v2/credentials/abc", "AWS_CONTAINER_AUTHORIZATION_TOKEN": "env-tok"}), "us-east-1", false, nil, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Retrieve(ctx); err != nil || lastAuth.Load() != "env-tok|/v2/credentials/abc" {
		t.Fatalf("relative: %v %v", err, lastAuth.Load())
	}
	if _, err := ResolveClaimCredentials(envMap(map[string]string{"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "v2/x"}), "", false, nil, nil); err == nil {
		t.Fatal("relative without slash accepted")
	}
}

func TestClaimCredContainerFullURIHostRule(t *testing.T) {
	for uri, ok := range map[string]bool{
		"http://127.0.0.1:7520/c":             true,
		"http://localhost/c":                  true,
		"http://[::1]:80/c":                   true,
		"http://169.254.170.2/c":              true,
		"http://169.254.170.23/c":             true,
		"http://[fd00:ec2::23]/c":             true,
		"http://10.0.0.5/c":                   false,
		"http://169.254.169.254/c":            false,
		"http://creds.example.com/c":          false,
		"https://creds.example.com/c":         true,
		"https://10.0.0.5/c":                  true,
		"http://127.0.0.1.evil.example.com/c": false,
		"ftp://127.0.0.1/c":                   false,
	} {
		_, err := ResolveClaimCredentials(envMap(map[string]string{"AWS_CONTAINER_CREDENTIALS_FULL_URI": uri}), "us-east-1", false, nil, nil)
		if (err == nil) != ok {
			t.Errorf("%s: accepted=%v want %v (%v)", uri, err == nil, ok, err)
		}
	}
}

func TestClaimCredPriorityOrder(t *testing.T) {
	all := map[string]string{
		"AWS_WEB_IDENTITY_TOKEN_FILE": "/x", "AWS_ROLE_ARN": "arn", "AWS_ENDPOINT_URL_STS": "http://127.0.0.1:1",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1:2/c",
	}
	src := func(m map[string]string) string {
		p, err := ResolveClaimCredentials(envMap(m), "us-east-1", false, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return p.Source()
	}
	if got := src(all); got != "web identity" {
		t.Fatalf("web identity before container: %s", got)
	}
	withAWS := map[string]string{"AWS_ACCESS_KEY_ID": "a", "AWS_SECRET_ACCESS_KEY": "b"}
	for k, v := range all {
		withAWS[k] = v
	}
	if got := src(withAWS); got != "static keys" {
		t.Fatalf("AWS_* static before web identity: %s", got)
	}
	// LANDFLOW_CLAIM_* wins over AWS_*.
	p, _ := ResolveClaimCredentials(envMap(map[string]string{"LANDFLOW_CLAIM_ACCESS_KEY_ID": "L", "LANDFLOW_CLAIM_SECRET_ACCESS_KEY": "S", "AWS_ACCESS_KEY_ID": "a", "AWS_SECRET_ACCESS_KEY": "b", "AWS_SESSION_TOKEN": "t"}), "us-east-1", false, nil, nil)
	if c, _ := p.Retrieve(context.Background()); c.AccessKeyID != "L" || c.SessionToken != "t" {
		t.Fatalf("landflow keys: %+v", c)
	}
	// Half a pair is not a pair: it falls through to the next source.
	if got := src(map[string]string{"AWS_ACCESS_KEY_ID": "a", "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://127.0.0.1:2/c"}); got != "container credentials" {
		t.Fatalf("half pair: %s", got)
	}
}

func TestClaimCredNothingFoundListsEverySource(t *testing.T) {
	_, err := ResolveClaimCredentials(envMap(nil), "us-east-1", false, nil, nil)
	if err == nil {
		t.Fatal("no error")
	}
	for _, want := range []string{"LANDFLOW_CLAIM_ACCESS_KEY_ID", "LANDFLOW_CLAIM_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "~/.aws", "IMDS"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %s: %v", want, err)
		}
	}
	if _, err := ParseClaimStore("s3://b/p?endpoint=http://127.0.0.1:1", envMap(nil)); err == nil || !strings.Contains(err.Error(), "AWS_WEB_IDENTITY_TOKEN_FILE") {
		t.Fatalf("via ParseClaimStore: %v", err)
	}
}

// The store signs with the session token and names its credential source, without secrets.
func TestClaimCredStoreSignsWithSessionTokenAndDescribes(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	sts := &fakeSTS{clock: clock, ttl: time.Hour}
	stsURL := listenOn(t, sts)
	var mu sync.Mutex
	var seen []string
	s3URL := listenOn(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("x-amz-security-token")+"|"+r.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(200)
	}))
	tokenFile := writeTokenFile(t, "jwt")
	setting, err := ParseClaimStore("s3://bkt/pfx?endpoint="+s3URL, envMap(map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": tokenFile, "AWS_ROLE_ARN": "arn:aws:iam::1:role/r", "AWS_ENDPOINT_URL_STS": stsURL}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(setting.Describe, "(credentials: web identity)") || strings.Contains(setting.Describe, "websecret") || strings.Contains(setting.Describe, "jwt") {
		t.Fatalf("describe: %s", setting.Describe)
	}
	store := setting.Store.(*S3ClaimStore)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ { // concurrent use: one STS call, every request signed with its session token
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.Put(ctx, "claims/x", []byte("body")); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if sts.calls.Load() != 1 || len(seen) != 20 {
		t.Fatalf("calls=%d requests=%d", sts.calls.Load(), len(seen))
	}
	for _, s := range seen {
		if !strings.HasPrefix(s, "webtoken1|") || !strings.Contains(s, "Credential=ASIAWEB1/") || !strings.Contains(s, "x-amz-security-token") {
			t.Fatalf("request: %s", s)
		}
	}
}

func TestClaimCredConcurrentRefresh(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	sts := &fakeSTS{clock: clock, ttl: 6 * time.Minute} // always inside a minute of the margin after a minute passes
	url := listenOn(t, sts)
	p, err := ResolveClaimCredentials(envMap(map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": writeTokenFile(t, "j"), "AWS_ROLE_ARN": "a", "AWS_ENDPOINT_URL_STS": url}), "us-east-1", false, nil, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	// Four rounds of 20 callers at once; the clock moves a minute per round, which lands inside the margin each time: one STS call per round.
	for round := 0; round < 4; round++ {
		if round > 0 {
			clock.Add(time.Minute)
		}
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := p.Retrieve(context.Background()); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
	}
	if n := sts.calls.Load(); n != 4 {
		t.Fatalf("calls: %d", n)
	}
}

// Live: STS and S3 on LocalStack (it answers AssumeRoleWithWebIdentity). Dummy keys only; the bucket must exist.
//
//	AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null LANDFLOW_TEST_CLAIM_LOCALSTACK=http://127.0.0.1:54566 LANDFLOW_TEST_CLAIM_LOCALSTACK_BUCKET=tmp-t6h-claims go test -run ClaimCredLocalStack .
func TestClaimCredLocalStack(t *testing.T) {
	endpoint, bucket := os.Getenv("LANDFLOW_TEST_CLAIM_LOCALSTACK"), os.Getenv("LANDFLOW_TEST_CLAIM_LOCALSTACK_BUCKET")
	if endpoint == "" || bucket == "" {
		t.Skip("set LANDFLOW_TEST_CLAIM_LOCALSTACK=http://127.0.0.1:54566 and LANDFLOW_TEST_CLAIM_LOCALSTACK_BUCKET=<existing bucket> to run against LocalStack")
	}
	env := map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": writeTokenFile(t, "localstack-jwt"), "AWS_ROLE_ARN": "arn:aws:iam::000000000000:role/tmp-t6h", "AWS_ENDPOINT_URL_STS": endpoint}
	setting, err := ParseClaimStore("s3://"+bucket+"/claims-test-go-"+randomHex(3)+"?endpoint="+endpoint, envMap(env))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(setting.Describe, "credentials: web identity") {
		t.Fatal(setting.Describe)
	}
	ctx := context.Background()
	key := ClaimKeyFor(time.Now(), "live"+randomHex(3))
	if err := setting.Store.Put(ctx, key, []byte("sealed body")); err != nil {
		t.Fatal(err)
	}
	got, err := setting.Store.Get(ctx, key)
	if err != nil || string(got) != "sealed body" {
		t.Fatalf("get: %q %v", got, err)
	}
	if err := setting.Store.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := setting.Store.Get(ctx, key); err == nil {
		t.Fatal("still there")
	}
}
