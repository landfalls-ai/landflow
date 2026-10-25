package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"mime"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
	landflow "github.com/landflow/landflow/sdks/go"
)

// sentMail parses the raw MIME of the sent message with this id.
func sentMail(t *testing.T, h *harness, id string) (*mail.Message, string, string) {
	t.Helper()
	var raw []byte
	var thread string
	h.fake.Do(func() {
		for _, m := range h.fake.Mail.Messages {
			if m.ID == id {
				raw, thread = m.Raw, m.ThreadID
			}
		}
	})
	if raw == nil {
		t.Fatalf("no sent message %q", id)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	enc, _ := io.ReadAll(msg.Body)
	body, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(string(enc), "\r\n", ""))
	if err != nil {
		t.Fatalf("body is not base64: %v", err)
	}
	return msg, string(body), thread
}

func decodedHeader(msg *mail.Message, name string) string {
	v, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get(name))
	if err != nil {
		return msg.Header.Get(name)
	}
	return v
}

func TestGmailSend(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	params := map[string]any{
		"resource": "message", "operation": "send", "sendTo": "Ann Example <ann@example.com>; bob@example.com",
		"subject": "Grüße – quarterly report", "emailType": "text", "message": "Line one\nLine two",
		"options": map[string]any{"ccList": "cc@example.com", "bccList": "bcc@example.com", "replyTo": "replies@example.com", "senderName": "Landflow Bot"},
	}
	out := h.ok(h.exec("gmail", params, execOpts{items: []map[string]any{{}, {}}}))
	if len(out) != 2 || out[0]["id"] == "" || !slices.Equal(stringList(out[0]["labelIds"]), []string{"SENT"}) {
		t.Fatalf("output = %v", out)
	}
	msg, body, _ := sentMail(t, h, out[0]["id"].(string))
	for name, want := range map[string]string{
		"From": `"Landflow Bot" <me@example.com>`, "To": `"Ann Example" <ann@example.com>, bob@example.com`,
		"Cc": "cc@example.com", "Bcc": "bcc@example.com", "Reply-To": "replies@example.com",
		"Subject": "Grüße – quarterly report", "Content-Type": `text/plain; charset="UTF-8"`, "Content-Transfer-Encoding": "base64",
	} {
		if got := decodedHeader(msg, name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if body != "Line one\r\nLine two" {
		t.Errorf("body = %q", body)
	}
	// The profile (for the sender name) is fetched once per execution.
	if n := len(h.fake.Calls(http.MethodGet, "/gmail/v1/users/me/profile")); n != 1 {
		t.Errorf("%d profile calls", n)
	}
	if got := tel.counter(t, "landflow.google.gmail.messages_sent", map[string]string{"operation": "send"}); got != 2 {
		t.Errorf("messages_sent{send} = %v", got)
	}

	// HTML, and a subject that tries to smuggle a header.
	html := cloneMap(params)
	html["emailType"], html["message"], html["subject"] = "html", "<p>Hi</p>", "Hi\r\nBcc: attacker@example.com"
	html["options"] = map[string]any{}
	out = h.ok(h.exec("gmail", html, execOpts{}))
	msg, body, _ = sentMail(t, h, out[0]["id"].(string))
	if msg.Header.Get("Bcc") != "" || decodedHeader(msg, "Subject") != "Hi Bcc: attacker@example.com" ||
		!strings.HasPrefix(msg.Header.Get("Content-Type"), "text/html") || body != "<p>Hi</p>" || msg.Header.Get("From") != "" {
		t.Errorf("html message headers = %v body %q", msg.Header, body)
	}

	resp := h.exec("gmail", map[string]any{"resource": "message", "operation": "send", "sendTo": ""}, execOpts{})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "To") {
		t.Errorf("missing To error = %+v", resp.Error)
	}
}

func TestGmailReply(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	orig := h.fake.AddMessage(fakegoogle.SimpleMessage{
		From: "Carol <carol@example.com>", To: "me@example.com, Dan <dan@example.com>", Cc: "erin@example.com",
		Subject: "Quote", Text: "Can you send a quote?", MessageID: "<orig-1@mail.example.com>", References: "<root-0@mail.example.com>",
	})
	params := map[string]any{"resource": "message", "operation": "reply", "messageId": orig.ID, "message": "Here it is.", "emailType": "text", "options": map[string]any{}}
	out := h.ok(h.exec("gmail", params, execOpts{}))
	msg, body, thread := sentMail(t, h, out[0]["id"].(string))
	if thread != orig.ThreadID || out[0]["threadId"] != orig.ThreadID {
		t.Errorf("reply thread = %q, want %q", thread, orig.ThreadID)
	}
	for name, want := range map[string]string{
		"To": `"Carol" <carol@example.com>, dan@example.com`, "Cc": "erin@example.com", "Subject": "Re: Quote",
		"In-Reply-To": "<orig-1@mail.example.com>", "References": "<root-0@mail.example.com> <orig-1@mail.example.com>",
	} {
		if got := decodedHeader(msg, name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if body != "Here it is." {
		t.Errorf("body = %q", body)
	}

	params["options"] = map[string]any{"replyToSenderOnly": true}
	out = h.ok(h.exec("gmail", params, execOpts{}))
	msg, _, _ = sentMail(t, h, out[0]["id"].(string))
	if msg.Header.Get("To") != `"Carol" <carol@example.com>` || msg.Header.Get("Cc") != "" {
		t.Errorf("sender-only reply To=%q Cc=%q", msg.Header.Get("To"), msg.Header.Get("Cc"))
	}
	if got := tel.counter(t, "landflow.google.gmail.messages_sent", map[string]string{"operation": "reply"}); got != 2 {
		t.Errorf("messages_sent{reply} = %v", got)
	}
}

func TestGmailGetAndGetAll(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	base := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	m := h.fake.AddMessage(fakegoogle.SimpleMessage{
		From: "=?UTF-8?Q?Jos=C3=A9?= <jose@example.com>", To: "me@example.com", Subject: "Invoice 42",
		Text: "Plain body", HTML: "<b>HTML body</b>", Time: base,
	})
	got := h.ok(h.exec("gmail", map[string]any{"resource": "message", "operation": "get", "messageId": m.ID}, execOpts{}))
	want := map[string]any{"from": "José <jose@example.com>", "subject": "Invoice 42", "text": "Plain body", "html": "<b>HTML body</b>",
		"date": "2026-10-01T08:00:00Z", "id": m.ID, "threadId": m.ThreadID}
	for k, v := range want {
		if got[0][k] != v {
			t.Errorf("get %s = %v, want %v", k, got[0][k], v)
		}
	}
	raw := h.ok(h.exec("gmail", map[string]any{"resource": "message", "operation": "get", "messageId": m.ID, "simple": false}, execOpts{}))
	if raw[0]["payload"] == nil || raw[0]["internalDate"] != itoa(base.UnixMilli()) {
		t.Errorf("raw get = %v", raw[0])
	}

	for k := range 6 {
		labels := []string{"INBOX"}
		if k%2 == 0 {
			labels = append(labels, "UNREAD")
		}
		h.fake.AddMessage(fakegoogle.SimpleMessage{From: "news@example.com", To: "me@example.com", Subject: "News", Text: "n", Labels: labels,
			Time: base.Add(time.Duration(k+1) * time.Hour)})
	}
	h.fake.PageSize = 3
	all := h.ok(h.exec("gmail", map[string]any{"resource": "message", "operation": "getAll", "returnAll": true}, execOpts{}))
	if len(all) != 7 || all[0]["date"] != "2026-10-01T14:00:00Z" {
		t.Errorf("getAll returned %d, first %v", len(all), all[0]["date"])
	}
	list := tel.spansNamed("google.gmail.messages.list")
	if len(list) != 1 {
		t.Fatalf("list spans = %d", len(list))
	}
	if pages, _ := spanAttr(list[0], "google.pages"); pages != "3" {
		t.Errorf("google.pages = %s", pages)
	}
	if len(tel.spansNamed("google.gmail.messages.fetch")) != 1 {
		t.Error("no google.gmail.messages.fetch span")
	}

	limited := h.ok(h.exec("gmail", map[string]any{"resource": "message", "operation": "getAll", "limit": 2}, execOpts{}))
	if len(limited) != 2 {
		t.Errorf("limit 2 returned %d", len(limited))
	}
	filtered := h.ok(h.exec("gmail", map[string]any{"resource": "message", "operation": "getAll", "returnAll": true,
		"filters": map[string]any{"readStatus": "unread", "sender": "news@example.com", "labelIds": []any{"INBOX"}}}, execOpts{}))
	if len(filtered) != 3 {
		t.Errorf("unread from news = %d messages", len(filtered))
	}
	if last := lastListQuery(h); last.Get("q") != "is:unread from:news@example.com" || last.Get("labelIds") != "INBOX" {
		t.Errorf("list query = %v", last)
	}
}

// lastListQuery returns the query of the latest messages.list call.
func lastListQuery(h *harness) url.Values {
	var last url.Values
	for _, c := range h.fake.Calls(http.MethodGet, gmailMessages) {
		if c.Path == gmailMessages {
			last = c.Query
		}
	}
	return last
}

func TestGmailLabels(t *testing.T) {
	h := newHarness(t)
	m := h.fake.AddMessage(fakegoogle.SimpleMessage{From: "a@example.com", To: "me@example.com", Subject: "s"})
	labels := func() []string {
		var out []string
		h.fake.Do(func() { out = slices.Clone(h.fake.Mail.Messages[0].LabelIDs) })
		return out
	}
	op := func(operation string, extra map[string]any) *landflow.ExecuteResponse {
		p := map[string]any{"resource": "message", "operation": operation, "messageId": m.ID}
		for k, v := range extra {
			p[k] = v
		}
		return h.exec("gmail", p, execOpts{})
	}
	h.ok(op("addLabels", map[string]any{"labelIds": []any{"Label_1", "Label_2"}}))
	h.ok(op("markAsRead", nil))
	h.ok(op("removeLabels", map[string]any{"labelIds": []any{"Label_2"}}))
	if got := labels(); !slices.Equal(got, []string{"INBOX", "Label_1"}) {
		t.Errorf("labels = %v", got)
	}
	out := h.ok(op("markAsUnread", nil))
	if !slices.Contains(stringList(out[0]["labelIds"]), "UNREAD") {
		t.Errorf("markAsUnread = %v", out)
	}
	if resp := op("addLabels", map[string]any{"labelIds": []any{}}); resp.Error == nil || !strings.Contains(resp.Error.Message, "Label") {
		t.Errorf("empty labels error = %+v", resp.Error)
	}
	if resp := op("get", map[string]any{"messageId": "nope"}); resp.Error == nil || resp.Error.Message != "Gmail API error 404: Requested entity was not found." {
		t.Errorf("unknown message error = %+v", resp.Error)
	}

	opts := h.loadOptions("gmail", "labels", map[string]any{}, nil)
	var names []string
	for _, o := range opts {
		names = append(names, o.Name)
	}
	if !slices.Equal(names, []string{"Alerts", "Invoices", "INBOX", "SENT", "SPAM", "TRASH", "UNREAD"}) {
		t.Errorf("label options = %v", names)
	}
}

func TestGmailNeedsDelegation(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	sa := h.sa()
	delete(sa, "delegatedEmail")
	resp := h.exec("gmail", map[string]any{"resource": "message", "operation": "getAll", "limit": 1}, execOpts{creds: map[string]any{credServiceAccount: sa}})
	if resp.Error == nil || resp.Error.Message != "Gmail API error 400: Precondition check failed." ||
		!strings.Contains(resp.Error.Description, "domain-wide delegation") {
		t.Errorf("error = %+v", resp.Error)
	}
	if got := tel.counter(t, "landflow.google.api_errors", map[string]string{"api": "gmail", "status_class": "4xx"}); got != 1 {
		t.Errorf("api_errors{gmail,4xx} = %v", got)
	}
}

func TestGmailTrigger(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	t0 := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	old := h.fake.AddMessage(fakegoogle.SimpleMessage{From: "a@example.com", To: "me@example.com", Subject: "Old", Text: "old", Time: t0})
	params := map[string]any{"pollInterval": 60, "simple": true, "filters": map[string]any{}}

	first := h.exec("gmailTrigger", params, execOpts{mode: landflow.ModePoll})
	if items := h.ok(first); len(items) != 0 || first.PollState["lastInternalDate"] != t0.UnixMilli() ||
		!slices.Equal(stringList(first.PollState["seenIds"]), []string{old.ID}) {
		t.Fatalf("first poll = %v, state %v", items, first.PollState)
	}

	// Two new messages, one in the same second as the old one.
	same := h.fake.AddMessage(fakegoogle.SimpleMessage{From: "b@example.com", To: "me@example.com", Subject: "Same second", Text: "s", Time: t0.Add(400 * time.Millisecond)})
	later := h.fake.AddMessage(fakegoogle.SimpleMessage{From: "c@example.com", To: "me@example.com", Subject: "Later", Text: "l", Time: t0.Add(time.Minute)})
	second := h.exec("gmailTrigger", params, execOpts{mode: landflow.ModePoll, pollState: first.PollState})
	items := h.ok(second)
	if len(items) != 2 || items[0]["id"] != same.ID || items[1]["id"] != later.ID || items[1]["subject"] != "Later" {
		t.Fatalf("second poll = %v", items)
	}
	if q := lastListQuery(h).Get("q"); q != "after:"+itoa(t0.Unix()-1) {
		t.Errorf("poll query = %q", q)
	}
	if second.PollState["lastInternalDate"] != later.InternalDate || len(stringList(second.PollState["seenIds"])) != 3 {
		t.Errorf("second state = %v", second.PollState)
	}

	third := h.exec("gmailTrigger", params, execOpts{mode: landflow.ModePoll, pollState: second.PollState})
	if items := h.ok(third); len(items) != 0 {
		t.Errorf("third poll repeated %d message(s)", len(items))
	}
	if got := tel.counter(t, "landflow.google.poll.new_items", map[string]string{"trigger": "gmail"}); got != 2 {
		t.Errorf("poll.new_items{gmail} = %v", got)
	}

	// Filters apply to polls; the manual run shows recent messages oldest first.
	filtered := cloneMap(params)
	filtered["filters"] = map[string]any{"sender": "c@example.com", "readStatus": "unread"}
	h.ok(h.exec("gmailTrigger", filtered, execOpts{mode: landflow.ModePoll, pollState: third.PollState}))
	if q := lastListQuery(h).Get("q"); !strings.HasPrefix(q, "is:unread from:c@example.com after:") {
		t.Errorf("filtered poll query = %q", q)
	}
	manual := h.exec("gmailTrigger", params, execOpts{mode: landflow.ModeManual})
	if items := h.ok(manual); len(items) != 3 || items[0]["id"] != old.ID || manual.PollState != nil {
		t.Errorf("manual = %v, state %v", items, manual.PollState)
	}

	// An empty mailbox baselines at "now".
	empty := newHarness(t)
	fixed := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	now = func() time.Time { return fixed }
	t.Cleanup(func() { now = time.Now })
	resp := empty.exec("gmailTrigger", params, execOpts{mode: landflow.ModePoll})
	if resp.PollState["lastInternalDate"] != fixed.UnixMilli() {
		t.Errorf("empty mailbox state = %v", resp.PollState)
	}
}

func itoa(n int64) string { return landflow.Stringify(n) }

func TestOutgoingMailMIME(t *testing.T) {
	m := outgoingMail{
		From: "Zoë <zoe@example.com>", To: "a@example.com;b@example.com", Subject: "Ünïcode subject",
		Body: strings.Repeat("x", 100), Date: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
	raw := string(m.bytes())
	for _, want := range []string{
		"From: =?utf-8?q?Zo=C3=AB?= <zoe@example.com>\r\n", "To: a@example.com, b@example.com\r\n",
		"Subject: =?UTF-8?b?", "Date: Fri, 02 Jan 2026 03:04:05 +0000\r\n", "MIME-Version: 1.0\r\n",
	} {
		if !strings.Contains(raw, want) {
			t.Errorf("raw message lacks %q:\n%s", want, raw)
		}
	}
	_, body, _ := strings.Cut(raw, "\r\n\r\n")
	lines := strings.Split(strings.TrimSuffix(body, "\r\n"), "\r\n")
	if len(lines) != 2 || len(lines[0]) != 76 {
		t.Errorf("body lines = %q", lines)
	}
	if strings.ContainsAny(m.raw(), "+/=") {
		t.Error("raw is not unpadded base64url")
	}
	if got := formatAddressList("not an address <<"); got != "not an address <<" {
		t.Errorf("unparseable list = %q", got)
	}

	latin1 := base64.RawURLEncoding.EncodeToString([]byte{'c', 'a', 'f', 0xe9})
	if got := decodeBody(latin1, "ISO-8859-1"); got != "café" {
		t.Errorf("latin-1 body = %q", got)
	}
	if got := decodeBody(base64.URLEncoding.EncodeToString([]byte("padded")), "utf-8"); got != "padded" {
		t.Errorf("padded body = %q", got)
	}
}
