package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	ghSecret = "It's a Secret to Everybody"
	ghBody   = "Hello, World!"
)

func TestGitHubSignatureDocumentedExample(t *testing.T) {
	// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
	want := "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
	if got := GitHubSignature(ghSecret, []byte(ghBody)); got != want {
		t.Fatalf("GitHubSignature = %s", got)
	}
	checks := []struct {
		secret, body, header string
		ok                   bool
	}{
		{ghSecret, ghBody, want, true},
		{ghSecret, ghBody, "sha256=" + strings.ToUpper(want[7:]), true},
		{ghSecret, ghBody + " ", want, false},
		{"other", ghBody, want, false},
		{ghSecret, ghBody, want[7:], false},
		{ghSecret, ghBody, "", false},
		{"", ghBody, GitHubSignature("", []byte(ghBody)), false},
	}
	for i, c := range checks {
		if got := VerifyGitHubSignature(c.secret, []byte(c.body), c.header); got != c.ok {
			t.Errorf("check %d: VerifyGitHubSignature = %v, want %v", i, got, c.ok)
		}
	}
	if !VerifyHMACSHA256Base64([]byte("k"), []byte("p"), HMACSHA256Base64([]byte("k"), []byte("p"))) || VerifyHMACSHA256([]byte("k"), []byte("p"), HMACSHA256Hex([]byte("k"), []byte("q")), "") {
		t.Error("plain HMAC verification")
	}
}

func TestStripeAndSlackSignatures(t *testing.T) {
	now := time.Unix(1_760_000_000, 0)
	header := StripeSignature("whsec_test", []byte(ghBody), now.Unix())
	at := func(d time.Duration) SignatureOptions { return SignatureOptions{Now: now.Add(d)} }
	if !VerifyStripeSignature("whsec_test", []byte(ghBody), header, at(0)) ||
		!VerifyStripeSignature("whsec_test", []byte(ghBody), header+",v1="+strings.Repeat("0", 64), at(0)) ||
		VerifyStripeSignature("whsec_test", []byte(ghBody+"!"), header, at(0)) ||
		VerifyStripeSignature("whsec_test", []byte(ghBody), header, at(301*time.Second)) ||
		!VerifyStripeSignature("whsec_test", []byte(ghBody), header, SignatureOptions{Now: now.Add(301 * time.Second), Tolerance: 10 * time.Minute}) ||
		VerifyStripeSignature("whsec_test", []byte(ghBody), "garbage", at(0)) {
		t.Errorf("stripe checks failed for %s", header)
	}

	slackNow := time.Unix(1_531_420_618, 0)
	body := []byte("token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather")
	signature := SlackSignature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420618")
	if !VerifySlackSignature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420618", signature, SignatureOptions{Now: slackNow}) ||
		VerifySlackSignature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420618", signature, SignatureOptions{Now: slackNow.Add(10 * time.Minute)}) ||
		VerifySlackSignature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420619", signature, SignatureOptions{Now: slackNow}) ||
		VerifySlackSignature("wrong", body, "1531420618", signature, SignatureOptions{Now: slackNow}) {
		t.Errorf("slack checks failed for %s", signature)
	}
}

// ---- A fake service with a hooks API ----------------------------------------

type hookService struct {
	mu     sync.Mutex
	hooks  map[string]map[string]any
	nextID int
	srv    *httptest.Server
}

func newHookService(t *testing.T) *hookService {
	s := &hookService{hooks: map[string]map[string]any{}, nextID: 1}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		id := strings.TrimPrefix(r.URL.Path, "/hooks/")
		send := func(status int, v any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			if v != nil {
				_ = json.NewEncoder(w).Encode(v)
			}
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/hooks":
			var in map[string]any
			_ = json.NewDecoder(r.Body).Decode(&in)
			hook := map[string]any{"id": fmt.Sprintf("h%d", s.nextID), "url": in["url"], "secret": in["secret"]}
			s.nextID++
			s.hooks[hook["id"].(string)] = hook
			send(201, hook)
		case r.Method == http.MethodGet && s.hooks[id] != nil:
			send(200, s.hooks[id])
		case r.Method == http.MethodDelete && s.hooks[id] != nil:
			delete(s.hooks, id)
			send(204, nil)
		default:
			send(404, map[string]any{"message": "Not Found"})
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *hookService) has(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hooks[id] != nil
}

type hookTrigger struct {
	svc  *hookService
	name string
	fail bool
}

func (h hookTrigger) Description() NodeDescriptor {
	return NodeDescriptor{
		Name: h.name, DisplayName: "Hook Trigger", Version: V(1), Kind: KindTrigger, TriggerSource: TriggerAppWebhook,
		Outputs:    []PortDescriptor{MainPort()},
		Properties: []PropertyDescriptor{{Name: "events", DisplayName: "Events", Type: PropString, Default: "push"}},
	}
}

func (hookTrigger) Execute(*ExecuteContext) ([][]Item, error) { return nil, nil }

func (h hookTrigger) WebhookCheckExists(ctx *WebhookContext) (bool, error) {
	id, _ := ctx.StaticData()["hookId"].(string)
	if id == "" {
		return false, nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.svc.srv.URL+"/hooks/"+id, nil)
	resp, err := HTTPClient(ctx).Do(req)
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	return resp.StatusCode == 200, nil
}

func (h hookTrigger) WebhookCreate(ctx *WebhookContext) error {
	if h.fail {
		return NewNodeError("service down")
	}
	secret := fmt.Sprintf("s-%d", time.Now().UnixNano())
	payload, _ := json.Marshal(map[string]any{"url": ctx.WebhookURL(), "secret": secret, "events": ctx.ParamString("events", "")})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.svc.srv.URL+"/hooks", bytes.NewReader(payload))
	resp, err := HTTPClient(ctx).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var hook map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&hook)
	ctx.Logger.Info("hook created")
	ctx.StaticData()["hookId"] = hook["id"]
	ctx.StaticData()["secret"] = secret
	return nil
}

func (h hookTrigger) WebhookDelete(ctx *WebhookContext) error {
	if id, _ := ctx.StaticData()["hookId"].(string); id != "" {
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, h.svc.srv.URL+"/hooks/"+id, nil)
		if resp, err := HTTPClient(ctx).Do(req); err == nil {
			resp.Body.Close()
		}
	}
	ctx.SetStaticData(nil)
	return nil
}

func (hookTrigger) Webhook(ctx *WebhookContext) (*WebhookResult, error) {
	secret, _ := ctx.StaticData()["secret"].(string)
	if !VerifyGitHubSignature(secret, ctx.RawBody(), ctx.Header("X-Hub-Signature-256")) {
		return &WebhookResult{Response: JSONReply(401, map[string]any{"error": "bad signature"})}, nil
	}
	if ctx.BodyObject()["zen"] != nil {
		return &WebhookResult{Response: &WebhookReply{Status: 200, Body: "pong"}}, nil
	}
	ctx.StaticData()["lastDelivery"] = ctx.Header("x-delivery")
	return &WebhookResult{Items: []Item{{JSON: map[string]any{"event": ctx.Header("x-event"), "body": ctx.Body()}}}, IdempotencyKey: ctx.Header("x-delivery")}, nil
}

type webhookTransport struct {
	method  func(*WebhookMethodRequest) (*WebhookMethodResponse, error)
	webhook func(*WebhookRequest) (*WebhookResponse, error)
}

func webhookPlugin(svc *hookService) *Plugin {
	return NewPlugin(PluginInfo{ID: "hooks", Name: "Hooks", Version: "1.0.0"},
		hookTrigger{svc: svc, name: "hookTrigger"}, hookTrigger{svc: svc, name: "failingTrigger", fail: true}, upperNode{})
}

func methodRequest(method WebhookMethodName, node string, static map[string]any) *WebhookMethodRequest {
	return &WebhookMethodRequest{
		Protocol: ProtocolVersion, Method: method, WorkflowID: "wf1",
		Node: NodeRef{ID: "n1", Name: "Hook", Type: "hooks." + node, TypeVersion: 1}, Parameters: map[string]any{},
		WebhookURL: "https://landflow.example/api/webhook/app/wf1/n1", StaticData: static,
	}
}

func webhookRequest(static map[string]any, body string, headers map[string]string) *WebhookRequest {
	return &WebhookRequest{
		Protocol: ProtocolVersion, WorkflowID: "wf1", Node: NodeRef{ID: "n1", Name: "Hook", Type: "hooks.hookTrigger", TypeVersion: 1},
		Parameters: map[string]any{}, WebhookURL: "https://landflow.example/api/webhook/app/wf1/n1", StaticData: static,
		Request: IncomingWebhookRequest{Method: "POST", Path: "/api/webhook/app/wf1/n1", Headers: headers, Query: map[string]string{}, Body: []byte(body)},
	}
}

func postWebhookJSON[T any](t *testing.T, url string, body any) *T {
	t.Helper()
	data, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("POST %s: %d %s", url, resp.StatusCode, raw)
	}
	out := new(T)
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAppWebhookLifecycle(t *testing.T) {
	svc := newHookService(t)
	plugin := webhookPlugin(svc)
	httpSrv := httptest.NewServer(plugin.Handler())
	t.Cleanup(httpSrv.Close)
	client := bufconnClient(t, plugin)
	ctx := context.Background()

	transports := map[string]webhookTransport{
		"in-process": {
			method:  func(r *WebhookMethodRequest) (*WebhookMethodResponse, error) { return plugin.WebhookMethod(ctx, r) },
			webhook: func(r *WebhookRequest) (*WebhookResponse, error) { return plugin.ReceiveWebhook(ctx, r) },
		},
		"http": {
			method: func(r *WebhookMethodRequest) (*WebhookMethodResponse, error) {
				return postWebhookJSON[WebhookMethodResponse](t, httpSrv.URL+PathWebhookMethod, r), nil
			},
			webhook: func(r *WebhookRequest) (*WebhookResponse, error) {
				return postWebhookJSON[WebhookResponse](t, httpSrv.URL+PathWebhook, r), nil
			},
		},
		"grpc": {
			method: func(r *WebhookMethodRequest) (*WebhookMethodResponse, error) {
				msg, err := WebhookMethodRequestToProto(r)
				if err != nil {
					return nil, err
				}
				out, err := client.WebhookMethod(ctx, msg)
				if err != nil {
					return nil, err
				}
				return WebhookMethodResponseFromProto(out)
			},
			webhook: func(r *WebhookRequest) (*WebhookResponse, error) {
				msg, err := WebhookRequestToProto(r)
				if err != nil {
					return nil, err
				}
				out, err := client.ReceiveWebhook(ctx, msg)
				if err != nil {
					return nil, err
				}
				return WebhookResponseFromProto(out)
			},
		},
	}

	for name, tr := range transports {
		t.Run(name, func(t *testing.T) {
			must := func(resp any, err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			check, err := tr.method(methodRequest(WebhookMethodCheckExists, "hookTrigger", map[string]any{}))
			must(check, err)
			if check.Exists || check.Error != nil {
				t.Fatalf("checkExists before create = %+v", check)
			}
			created, err := tr.method(methodRequest(WebhookMethodCreate, "hookTrigger", map[string]any{}))
			must(created, err)
			if created.Error != nil || created.StaticData == nil {
				t.Fatalf("create = %+v", created)
			}
			static := created.StaticData
			hookID, _ := static["hookId"].(string)
			if !svc.has(hookID) || len(created.Logs) != 1 || created.Logs[0].Message != "hook created" {
				t.Fatalf("create: hook %q, logs %+v", hookID, created.Logs)
			}
			check, err = tr.method(methodRequest(WebhookMethodCheckExists, "hookTrigger", static))
			must(check, err)
			if !check.Exists {
				t.Fatalf("checkExists after create = %+v", check)
			}

			body := `{"action":"opened","number":7}`
			headers := map[string]string{"content-type": "application/json", "x-hub-signature-256": GitHubSignature(static["secret"].(string), []byte(body)), "x-event": "issues", "x-delivery": "d-1"}
			received, err := tr.webhook(webhookRequest(static, body, headers))
			must(received, err)
			if len(received.Items) != 1 || received.Items[0].JSON["event"] != "issues" || received.IdempotencyKey != "d-1" || received.Response != nil {
				t.Fatalf("webhook = %+v", received)
			}
			if inner, _ := received.Items[0].JSON["body"].(map[string]any); inner["action"] != "opened" {
				t.Fatalf("webhook body = %+v", received.Items[0].JSON)
			}
			if received.StaticData["lastDelivery"] != "d-1" || received.StaticData["hookId"] != hookID {
				t.Fatalf("webhook static data = %+v", received.StaticData)
			}

			headers["x-hub-signature-256"] = "sha256=" + strings.Repeat("0", 64)
			bad, err := tr.webhook(webhookRequest(static, body, headers))
			must(bad, err)
			if len(bad.Items) != 0 || bad.Response == nil || bad.Response.Status != 401 || bad.Response.Headers["content-type"] != "application/json; charset=utf-8" || bad.StaticData != nil {
				t.Fatalf("bad signature = %+v", bad)
			}

			ping := `{"zen":"Keep it logically awesome."}`
			headers["x-hub-signature-256"] = GitHubSignature(static["secret"].(string), []byte(ping))
			pong, err := tr.webhook(webhookRequest(static, ping, headers))
			must(pong, err)
			if len(pong.Items) != 0 || pong.Response == nil || pong.Response.Body != "pong" {
				t.Fatalf("ping = %+v", pong)
			}

			deleted, err := tr.method(methodRequest(WebhookMethodDelete, "hookTrigger", static))
			must(deleted, err)
			if deleted.Error != nil || deleted.StaticData == nil || len(deleted.StaticData) != 0 || svc.has(hookID) {
				t.Fatalf("delete = %+v (hook still there: %v)", deleted, svc.has(hookID))
			}

			failed, err := tr.method(methodRequest(WebhookMethodCreate, "failingTrigger", map[string]any{}))
			must(failed, err)
			if failed.Error == nil || failed.Error.Message != "service down" {
				t.Fatalf("failing create = %+v", failed)
			}
			notTrigger, err := tr.method(methodRequest(WebhookMethodCreate, "upper", map[string]any{}))
			must(notTrigger, err)
			if notTrigger.Error == nil || !strings.Contains(notTrigger.Error.Message, "not an app webhook trigger") {
				t.Fatalf("non-trigger = %+v", notTrigger)
			}
		})
	}
}

func TestAppWebhookValidation(t *testing.T) {
	svc := newHookService(t)
	plugin := webhookPlugin(svc)
	if doc := plugin.WellKnown(); doc.Endpoints.WebhookMethod != PathWebhookMethod || doc.Endpoints.Webhook != PathWebhook {
		t.Errorf("well-known endpoints = %+v", doc.Endpoints)
	}
	if doc := testPlugin().WellKnown(); doc.Endpoints.Webhook != "" {
		t.Errorf("plain plugin lists webhook endpoints: %+v", doc.Endpoints)
	}
	if _, err := plugin.WebhookMethod(context.Background(), methodRequest("rename", "hookTrigger", nil)); err == nil || !strings.Contains(err.Error(), "bad request") {
		t.Errorf("unknown method error = %v", err)
	}
	if _, err := plugin.WebhookMethod(context.Background(), methodRequest(WebhookMethodCreate, "nope", nil)); err == nil || !strings.Contains(err.Error(), "unknown node type") {
		t.Errorf("unknown node error = %v", err)
	}
	_, err := BuildPlugin(PluginInfo{ID: "bad", Name: "Bad", Version: "1.0.0"}, appWebhookWithoutMethods{})
	if err == nil || !strings.Contains(err.Error(), "must implement landflow.WebhookNode") {
		t.Errorf("BuildPlugin error = %v", err)
	}
	if got := parseWebhookBody([]byte("payload=%7B%22a%22%3A1%7D"), "application/x-www-form-urlencoded"); fmt.Sprint(got) != "map[a:1]" {
		t.Errorf("form payload = %v", got)
	}
	if got := parseWebhookBody([]byte("hello"), "text/plain"); got != "hello" {
		t.Errorf("text body = %v", got)
	}
}

type appWebhookWithoutMethods struct{}

func (appWebhookWithoutMethods) Description() NodeDescriptor {
	return NodeDescriptor{Name: "incomplete", DisplayName: "Incomplete", Version: V(1), Kind: KindTrigger, TriggerSource: TriggerAppWebhook, Outputs: []PortDescriptor{MainPort()}}
}

func (appWebhookWithoutMethods) Execute(*ExecuteContext) ([][]Item, error) { return nil, nil }
