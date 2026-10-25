package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/mail"
	"net/textproto"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	landflow "github.com/landflow/landflow/sdks/go"
)

// GmailNode is Gmail's message resource: send, reply, get, get many, add and
// remove labels, mark as read or unread. All calls act as "me": the OAuth2
// user, or the service account's impersonated user (domain-wide delegation).
type GmailNode struct{}

const (
	gmailMessages = "/gmail/v1/users/me/messages"
	// gmailFetchWorkers bounds parallel messages.get calls.
	gmailFetchWorkers = 5
	// gmailRawLimit: bigger messages go to the upload endpoint instead of
	// messages.send's JSON "raw" field.
	gmailRawLimit = 5 << 20
	// gmailMaxMessage is Gmail's limit for an uploaded message.
	gmailMaxMessage = 35 << 20
)

// attachmentsProperty names the input item's binary files to attach.
var attachmentsProperty = landflow.PropertyDescriptor{
	Name: "attachments", DisplayName: "Attachments", Type: landflow.PropString, Default: "", Placeholder: "data, invoice",
	Description: "Binary properties of the input item to attach, separated by commas (a file from Read Files, HTTP Request, a form upload…)",
}

// systemLabels are offered statically (the editor's multi-select does not
// load options yet); the labels loader adds the user's own labels.
var systemLabels = []landflow.PropertyOption{
	{Name: "INBOX", Value: "INBOX"},
	{Name: "UNREAD", Value: "UNREAD"},
	{Name: "STARRED", Value: "STARRED"},
	{Name: "IMPORTANT", Value: "IMPORTANT"},
	{Name: "SENT", Value: "SENT"},
	{Name: "SPAM", Value: "SPAM"},
	{Name: "TRASH", Value: "TRASH"},
	{Name: "CATEGORY_PERSONAL", Value: "CATEGORY_PERSONAL"},
	{Name: "CATEGORY_SOCIAL", Value: "CATEGORY_SOCIAL"},
	{Name: "CATEGORY_PROMOTIONS", Value: "CATEGORY_PROMOTIONS"},
	{Name: "CATEGORY_UPDATES", Value: "CATEGORY_UPDATES"},
	{Name: "CATEGORY_FORUMS", Value: "CATEGORY_FORUMS"},
}

func labelProperty(name, displayName string, required bool, d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: name, DisplayName: displayName, Type: landflow.PropMultiOptions, Default: []any{}, Required: required,
		Description: "Label IDs (system labels such as INBOX, or your own labels)",
		Options:     systemLabels, TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "labels"}, DisplayOptions: d,
	}
}

// gmailFilters are the Get Many and trigger filters.
func gmailFilters(d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "filters", DisplayName: "Filters", Type: landflow.PropCollection, Default: map[string]any{},
		Placeholder: "Add Filter", DisplayOptions: d,
		Values: []landflow.PropertyDescriptor{
			{Name: "includeSpamTrash", DisplayName: "Include Spam and Trash", Type: landflow.PropBoolean, Default: false,
				Description: "Whether to include messages from SPAM and TRASH"},
			labelProperty("labelIds", "Label Names or IDs", false, nil),
			{Name: "q", DisplayName: "Search", Type: landflow.PropString, Default: "", Placeholder: "has:attachment",
				Description: "Gmail search syntax, as in the Gmail search box"},
			{Name: "readStatus", DisplayName: "Read Status", Type: landflow.PropOptions, Default: "both",
				Options: []landflow.PropertyOption{
					{Name: "Unread and Read Emails", Value: "both"},
					{Name: "Unread Emails Only", Value: "unread"},
					{Name: "Read Emails Only", Value: "read"},
				}},
			{Name: "sender", DisplayName: "Sender", Type: landflow.PropString, Default: "",
				Description: "Sender name or email to filter by"},
		},
	}
}

func (GmailNode) Description() landflow.NodeDescriptor {
	byID := show("message", "get", "reply", "addLabels", "removeLabels", "markAsRead", "markAsUnread")
	paging := returnAllLimit(show("message", "getAll"), 50, 500)
	return landflow.NodeDescriptor{
		Name:             "gmail",
		DisplayName:      "Gmail",
		Description:      "Send, read and label Gmail messages",
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       []string{"Communication"},
		Icon:             "file:icons/gmail.svg",
		Color:            "#EA4335",
		Subtitle:         "{{operation}}: {{resource}}",
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/gmail/api/reference/rest",
		Keywords:         []string{"email", "mail", "google mail", "send", "inbox", "label"},
		Credentials:      credentialRequirements(),

		UsableAsTool: true,
		ToolDescription: "Use Gmail as the connected user. operation=send emails sendTo with subject and message " +
			"(emailType text or html); reply answers messageId in its thread; get returns one message (simplified: " +
			"from, to, subject, date, text, html); getAll searches with filters.q in Gmail search syntax; addLabels, " +
			"removeLabels, markAsRead and markAsUnread change messageId's labels.",

		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			resourceProperty("message", landflow.PropertyOption{Name: "Message", Value: "message"}),
			operationProperty("message", "send",
				landflow.PropertyOption{Name: "Add Label", Value: "addLabels", Description: "Add labels to a message", Action: "Add label to message"},
				landflow.PropertyOption{Name: "Get", Value: "get", Description: "Get a message", Action: "Get a message"},
				landflow.PropertyOption{Name: "Get Many", Value: "getAll", Description: "Get many messages", Action: "Get many messages"},
				landflow.PropertyOption{Name: "Mark as Read", Value: "markAsRead", Action: "Mark a message as read"},
				landflow.PropertyOption{Name: "Mark as Unread", Value: "markAsUnread", Action: "Mark a message as unread"},
				landflow.PropertyOption{Name: "Remove Label", Value: "removeLabels", Description: "Remove labels from a message", Action: "Remove label from message"},
				landflow.PropertyOption{Name: "Reply", Value: "reply", Description: "Reply to a message in its thread", Action: "Reply to a message"},
				landflow.PropertyOption{Name: "Send", Value: "send", Description: "Send a message", Action: "Send a message"},
			),
			{Name: "messageId", DisplayName: "Message ID", Type: landflow.PropString, Default: "", Required: true, DisplayOptions: byID},
			{Name: "sendTo", DisplayName: "To", Type: landflow.PropString, Default: "", Required: true,
				Placeholder: "info@example.com", Description: "Recipients, separated by commas",
				DisplayOptions: show("message", "send")},
			{Name: "subject", DisplayName: "Subject", Type: landflow.PropString, Default: "", Required: true,
				DisplayOptions: show("message", "send")},
			{Name: "emailType", DisplayName: "Email Type", Type: landflow.PropOptions, Default: "text",
				Options:        []landflow.PropertyOption{{Name: "Text", Value: "text"}, {Name: "HTML", Value: "html"}},
				DisplayOptions: show("message", "send", "reply")},
			{Name: "message", DisplayName: "Message", Type: landflow.PropString, Default: "", Required: true,
				TypeOptions: &landflow.TypeOptions{Rows: landflow.Ptr(5)}, DisplayOptions: show("message", "send", "reply")},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("message", "send"),
				Values: []landflow.PropertyDescriptor{
					attachmentsProperty,
					{Name: "bccList", DisplayName: "BCC", Type: landflow.PropString, Default: "", Description: "Addresses separated by commas"},
					{Name: "ccList", DisplayName: "CC", Type: landflow.PropString, Default: "", Description: "Addresses separated by commas"},
					{Name: "replyTo", DisplayName: "Reply To", Type: landflow.PropString, Default: ""},
					{Name: "senderName", DisplayName: "Sender Name", Type: landflow.PropString, Default: "", Description: "Display name shown to recipients"},
				}},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{},
				Placeholder: "Add Option", DisplayOptions: show("message", "reply"),
				Values: []landflow.PropertyDescriptor{
					attachmentsProperty,
					{Name: "bccList", DisplayName: "BCC", Type: landflow.PropString, Default: ""},
					{Name: "ccList", DisplayName: "CC", Type: landflow.PropString, Default: ""},
					{Name: "senderName", DisplayName: "Sender Name", Type: landflow.PropString, Default: ""},
					{Name: "replyToSenderOnly", DisplayName: "Reply to Sender Only", Type: landflow.PropBoolean, Default: false,
						Description: "Whether to reply to the sender only or to every recipient of the original message"},
				}},
			simplifyProperty(show("message", "get", "getAll")),
			paging[0],
			paging[1],
			gmailFilters(show("message", "getAll")),
			labelProperty("labelIds", "Label Names or IDs", true, show("message", "addLabels", "removeLabels")),
		},
	}
}

func (GmailNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	g := &gmailRun{ctx: ctx, c: c}
	var out []landflow.Item
	for i := range items {
		operation := ctx.ParamString("operation", i, "send")
		var results []map[string]any
		switch operation {
		case "send":
			results, err = one(g.send(i))
		case "reply":
			results, err = one(g.reply(i))
		case "get":
			results, err = one(g.get(i))
		case "getAll":
			results, err = g.getMany(i)
		case "addLabels", "removeLabels", "markAsRead", "markAsUnread":
			results, err = one(g.modify(i, operation))
		default:
			err = userError("Pick an operation listed for the message resource.", "Unsupported operation %q", operation)
		}
		if err != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, itemError(i, err)))
				continue
			}
			return nil, itemError(i, err)
		}
		out = emit(out, i, results...)
	}
	return [][]landflow.Item{out}, nil
}

// gmailRun is the state of one execution.
type gmailRun struct {
	ctx *landflow.ExecuteContext
	c   *client

	profileOnce sync.Once
	email       string
	profileErr  error
}

// me returns the mailbox address (needed for Sender Name and reply-all).
func (g *gmailRun) me() (string, error) {
	g.profileOnce.Do(func() {
		var p struct {
			EmailAddress string `json:"emailAddress"`
		}
		g.profileErr = g.c.do(g.ctx, apiGmail, http.MethodGet, "/gmail/v1/users/me/profile", nil, nil, &p)
		g.email = p.EmailAddress
	})
	return g.email, g.profileErr
}

// from is the From header for a sender name ("" lets Gmail fill it in).
func (g *gmailRun) from(senderName string) (string, error) {
	if strings.TrimSpace(senderName) == "" {
		return "", nil
	}
	email, err := g.me()
	if err != nil {
		return "", err
	}
	return (&mail.Address{Name: strings.TrimSpace(senderName), Address: email}).String(), nil
}

func (g *gmailRun) send(i int) (map[string]any, error) {
	to, err := requireParam(g.ctx, "sendTo", "To", i)
	if err != nil {
		return nil, err
	}
	opts := asMap(g.ctx.Param("options", i))
	from, err := g.from(getString(opts, "senderName", ""))
	if err != nil {
		return nil, err
	}
	attachments, err := g.attachments(i, opts)
	if err != nil {
		return nil, err
	}
	m := outgoingMail{
		Attachments: attachments,
		From:        from,
		To:          to,
		Cc:          getString(opts, "ccList", ""),
		Bcc:         getString(opts, "bccList", ""),
		ReplyTo:     getString(opts, "replyTo", ""),
		Subject:     g.ctx.ParamString("subject", i, ""),
		HTML:        g.ctx.ParamString("emailType", i, "text") == "html",
		Body:        g.ctx.ParamString("message", i, ""),
	}
	return g.deliver(m, "", "send")
}

// reply answers a message in its thread with In-Reply-To and References.
func (g *gmailRun) reply(i int) (map[string]any, error) {
	id, err := requireParam(g.ctx, "messageId", "Message ID", i)
	if err != nil {
		return nil, err
	}
	orig, err := getMessage(g.ctx, g.c, id, "metadata", "Subject", "From", "To", "Cc", "Reply-To", "Message-ID", "References")
	if err != nil {
		return nil, err
	}
	opts := asMap(g.ctx.Param("options", i))
	to := orig.header("Reply-To")
	if to == "" {
		to = orig.header("From")
	}
	cc := getString(opts, "ccList", "")
	if !getBool(opts, "replyToSenderOnly", false) {
		me, err := g.me()
		if err != nil {
			return nil, err
		}
		seen := map[string]bool{strings.ToLower(me): true}
		for _, a := range addresses(to) {
			seen[a] = true
		}
		var extraTo, extraCc []string
		for _, a := range addresses(orig.header("To")) {
			if !seen[a] {
				seen[a] = true
				extraTo = append(extraTo, a)
			}
		}
		for _, a := range addresses(orig.header("Cc")) {
			if !seen[a] {
				seen[a] = true
				extraCc = append(extraCc, a)
			}
		}
		to = joinNonEmpty(append([]string{to}, extraTo...))
		cc = joinNonEmpty(append([]string{cc}, extraCc...))
	}
	subject := orig.header("Subject")
	if !strings.HasPrefix(strings.ToLower(subject), "re:") {
		subject = strings.TrimSpace("Re: " + subject)
	}
	messageID := orig.header("Message-ID")
	from, err := g.from(getString(opts, "senderName", ""))
	if err != nil {
		return nil, err
	}
	attachments, err := g.attachments(i, opts)
	if err != nil {
		return nil, err
	}
	m := outgoingMail{
		Attachments: attachments,
		From:        from,
		To:          to,
		Cc:          cc,
		Bcc:         getString(opts, "bccList", ""),
		Subject:     subject,
		InReplyTo:   messageID,
		References:  strings.TrimSpace(orig.header("References") + " " + messageID),
		HTML:        g.ctx.ParamString("emailType", i, "text") == "html",
		Body:        g.ctx.ParamString("message", i, ""),
	}
	return g.deliver(m, orig.ThreadID, "reply")
}

func joinNonEmpty(parts []string) string {
	return strings.Join(slices.DeleteFunc(parts, func(s string) bool { return strings.TrimSpace(s) == "" }), ", ")
}

// attachmentNames reads the Attachments option ("data, invoice"), also in
// n8n's shape {attachmentsBinary: [{property: "data"}]} (attachmentsUi).
func attachmentNames(opts map[string]any) []string {
	var names []string
	add := func(list string) {
		for _, name := range strings.Split(list, ",") {
			if name = strings.TrimSpace(name); name != "" && !slices.Contains(names, name) {
				names = append(names, name)
			}
		}
	}
	add(getString(opts, "attachments", ""))
	if ui := asMap(opts["attachmentsUi"]); ui != nil {
		if list, ok := ui["attachmentsBinary"].([]any); ok {
			for _, entry := range list {
				add(getString(asMap(entry), "property", ""))
			}
		}
	}
	return names
}

// attachments loads the bytes of the binary files the Attachments option names.
func (g *gmailRun) attachments(i int, opts map[string]any) ([]mailAttachment, error) {
	var out []mailAttachment
	for _, name := range attachmentNames(opts) {
		ref, err := g.ctx.BinaryRef(i, name)
		if err != nil {
			return nil, userError("Attachments lists binary properties of the input item; check the previous node's Binary output.", "%v", err)
		}
		data, err := g.ctx.ReadBinary(ref)
		if err != nil {
			return nil, userError("The host's binary store could not be read.", "Attachment %q: %v", name, err)
		}
		fileName := ref.FileName
		if fileName == "" {
			fileName = name
			if ref.FileExtension != "" {
				fileName += "." + ref.FileExtension
			}
		}
		out = append(out, mailAttachment{FileName: fileName, MimeType: ref.MimeType, Data: data})
	}
	return out, nil
}

// deliver sends m (in threadID when set) and counts it. Messages over
// gmailRawLimit go to the media upload endpoint.
func (g *gmailRun) deliver(m outgoingMail, threadID, operation string) (map[string]any, error) {
	raw := m.bytes()
	if len(raw) > gmailMaxMessage {
		return nil, userError("Gmail accepts messages up to 35 MB, attachments included; send big files as Drive links.",
			"The message is %.1f MB", float64(len(raw))/(1<<20))
	}
	var resp map[string]any
	if len(raw) > gmailRawLimit {
		if err := g.upload(raw, threadID, &resp); err != nil {
			return nil, err
		}
	} else {
		body := map[string]any{"raw": base64.RawURLEncoding.EncodeToString(raw)}
		if threadID != "" {
			body["threadId"] = threadID
		}
		if err := g.c.do(g.ctx, apiGmail, http.MethodPost, gmailMessages+"/send", nil, body, &resp); err != nil {
			return nil, err
		}
	}
	g.ctx.Metrics().Counter("landflow.google.gmail.messages_sent", landflow.WithDescription("Messages sent through Gmail")).
		Add(1, landflow.Attrs{"operation": operation})
	return resp, nil
}

// upload sends a raw message through /upload/gmail/v1/users/me/messages/send:
// uploadType=media, or multipart (JSON metadata, then the message) to keep a
// reply in its thread.
func (g *gmailRun) upload(raw []byte, threadID string, out any) error {
	query := url.Values{"uploadType": {"media"}}
	contentType, payload := "message/rfc822", raw
	if threadID != "" {
		query.Set("uploadType", "multipart")
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		meta, _ := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json; charset=UTF-8"}})
		_ = json.NewEncoder(meta).Encode(map[string]any{"threadId": threadID})
		msg, _ := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {"message/rfc822"}})
		_, _ = msg.Write(raw)
		_ = mw.Close()
		contentType, payload = "multipart/related; boundary="+mw.Boundary(), buf.Bytes()
	}
	return g.c.send(g.ctx, apiGmail, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(g.ctx, http.MethodPost, g.c.url(apiGmail, "/upload"+gmailMessages+"/send", query), bytes.NewReader(payload))
		if err == nil {
			req.Header.Set("Content-Type", contentType)
		}
		return req, err
	}, func(resp *http.Response) error {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("%s returned a response that is not JSON: %v", apiGmail.title, err)
		}
		return nil
	})
}

func (g *gmailRun) get(i int) (map[string]any, error) {
	id, err := requireParam(g.ctx, "messageId", "Message ID", i)
	if err != nil {
		return nil, err
	}
	m, raw, err := getMessageRaw(g.ctx, g.c, id, "full")
	if err != nil {
		return nil, err
	}
	if g.ctx.ParamBool("simple", i, true) {
		return m.simplify(), nil
	}
	return raw, nil
}

// getMany searches messages, then fetches each one.
func (g *gmailRun) getMany(i int) ([]map[string]any, error) {
	query := gmailListQuery(asMap(g.ctx.Param("filters", i)))
	refs, err := listMessages(g.ctx, g.c, query, limitFor(g.ctx, i, 50))
	if err != nil {
		return nil, err
	}
	msgs, raws, err := fetchMessages(g.ctx, g.c, refs)
	if err != nil {
		return nil, err
	}
	simple := g.ctx.ParamBool("simple", i, true)
	out := make([]map[string]any, len(msgs))
	for k := range msgs {
		if simple {
			out[k] = msgs[k].simplify()
		} else {
			out[k] = raws[k]
		}
	}
	return out, nil
}

// modify changes a message's labels.
func (g *gmailRun) modify(i int, operation string) (map[string]any, error) {
	id, err := requireParam(g.ctx, "messageId", "Message ID", i)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	switch operation {
	case "markAsRead":
		body["removeLabelIds"] = []string{"UNREAD"}
	case "markAsUnread":
		body["addLabelIds"] = []string{"UNREAD"}
	default:
		labels := stringList(g.ctx.Param("labelIds", i))
		if len(labels) == 0 {
			return nil, userError("Pick at least one label.", "Label Names or IDs is required")
		}
		key := "addLabelIds"
		if operation == "removeLabels" {
			key = "removeLabelIds"
		}
		body[key] = labels
	}
	var resp map[string]any
	err = g.c.do(g.ctx, apiGmail, http.MethodPost, gmailMessages+"/"+url.PathEscape(id)+"/modify", nil, body, &resp)
	return resp, err
}

// ---------------------------------------------------------------------------
// Shared with the trigger
// ---------------------------------------------------------------------------

type messageRef struct {
	ID       string `json:"id"`
	ThreadID string `json:"threadId"`
}

// gmailListQuery builds messages.list parameters from the filters.
func gmailListQuery(filters map[string]any, extraTerms ...string) url.Values {
	query := url.Values{}
	var terms []string
	if q := strings.TrimSpace(getString(filters, "q", "")); q != "" {
		terms = append(terms, q)
	}
	switch getString(filters, "readStatus", "both") {
	case "unread":
		terms = append(terms, "is:unread")
	case "read":
		terms = append(terms, "is:read")
	}
	if sender := strings.TrimSpace(getString(filters, "sender", "")); sender != "" {
		terms = append(terms, "from:"+sender)
	}
	terms = append(terms, extraTerms...)
	if len(terms) > 0 {
		query.Set("q", strings.Join(terms, " "))
	}
	for _, l := range stringList(filters["labelIds"]) {
		query.Add("labelIds", l)
	}
	if getBool(filters, "includeSpamTrash", false) {
		query.Set("includeSpamTrash", "true")
	}
	return query
}

// listMessages pages through messages.list (newest first) up to want
// messages (-1: all).
func listMessages(ctx spanContext, c *client, base url.Values, want int) ([]messageRef, error) {
	var refs []messageRef
	err := paginate(ctx, "google.gmail.messages.list", want, func(ctx context.Context, token string, remaining int) (int, string, error) {
		query := url.Values{}
		for k, v := range base {
			query[k] = v
		}
		query.Set("maxResults", strconv.Itoa(pageSize(remaining, 500)))
		if token != "" {
			query.Set("pageToken", token)
		}
		var page struct {
			Messages      []messageRef `json:"messages"`
			NextPageToken string       `json:"nextPageToken"`
		}
		if err := c.do(ctx, apiGmail, http.MethodGet, gmailMessages, query, nil, &page); err != nil {
			return 0, "", err
		}
		if remaining >= 0 && len(page.Messages) > remaining {
			page.Messages = page.Messages[:remaining]
		}
		refs = append(refs, page.Messages...)
		return len(page.Messages), page.NextPageToken, nil
	})
	return refs, err
}

// fetchMessages gets each message in full, a few at a time, in one span.
func fetchMessages(ctx spanContext, c *client, refs []messageRef) ([]*gmailMessage, []map[string]any, error) {
	msgs := make([]*gmailMessage, len(refs))
	raws := make([]map[string]any, len(refs))
	if len(refs) == 0 {
		return msgs, raws, nil
	}
	err := ctx.Span("google.gmail.messages.fetch", landflow.Attrs{"google.items": len(refs)}, func(span landflow.Span) error {
		return forEach(len(refs), gmailFetchWorkers, func(k int) error {
			m, raw, err := getMessageRaw(span, c, refs[k].ID, "full")
			msgs[k], raws[k] = m, raw
			return err
		})
	})
	return msgs, raws, err
}

func getMessage(ctx context.Context, c *client, id, format string, headers ...string) (*gmailMessage, error) {
	m, _, err := getMessageRaw(ctx, c, id, format, headers...)
	return m, err
}

// getMessageRaw returns a message both typed and as the raw API object.
func getMessageRaw(ctx context.Context, c *client, id, format string, headers ...string) (*gmailMessage, map[string]any, error) {
	query := url.Values{"format": {format}}
	for _, h := range headers {
		query.Add("metadataHeaders", h)
	}
	var raw json.RawMessage
	if err := c.do(ctx, apiGmail, http.MethodGet, gmailMessages+"/"+url.PathEscape(id), query, nil, &raw); err != nil {
		return nil, nil, err
	}
	var m gmailMessage
	var obj map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil, fmt.Errorf("unreadable Gmail message: %v", err)
	}
	_ = json.Unmarshal(raw, &obj)
	return &m, obj, nil
}

// LoadOptionsWithContext serves the label picker.
func (GmailNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadGmailLabels(ctx)
}

func loadGmailLabels(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	if ctx.Method() != "labels" {
		return nil, fmt.Errorf("unknown loadOptions method %q (supported: labels)", ctx.Method())
	}
	c, err := newClient(ctx, ctx.ParamString("authentication", "serviceAccount"))
	if err != nil {
		return nil, err
	}
	var resp struct {
		Labels []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"labels"`
	}
	if err := c.do(ctx, apiGmail, http.MethodGet, "/gmail/v1/users/me/labels", nil, nil, &resp); err != nil {
		return nil, err
	}
	sort.SliceStable(resp.Labels, func(a, b int) bool {
		la, lb := resp.Labels[a], resp.Labels[b]
		if (la.Type == "user") != (lb.Type == "user") {
			return la.Type == "user" // the user's own labels first
		}
		return strings.ToLower(la.Name) < strings.ToLower(lb.Name)
	})
	opts := make([]landflow.PropertyOption, 0, len(resp.Labels))
	for _, l := range resp.Labels {
		opts = append(opts, landflow.PropertyOption{Name: l.Name, Value: l.ID})
	}
	return opts, nil
}
