package main

import (
	"cmp"
	"slices"
	"strconv"

	landflow "github.com/landflow/landflow/sdks/go"
)

// GmailTriggerNode polls for new messages matching its filters. State:
// {lastInternalDate (ms), seenIds: [recent ids]}. Later polls search
// after:lastInternalDate and emit messages not seen yet, oldest first.
type GmailTriggerNode struct{}

const (
	gmailManualMessages = 5
	// gmailMaxPerPoll caps the messages one poll looks at.
	gmailMaxPerPoll = 250
	// gmailSeenIDs is how many recent ids the state keeps to drop repeats
	// within the same second.
	gmailSeenIDs = 100
)

func (GmailTriggerNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name:             "gmailTrigger",
		DisplayName:      "Gmail Trigger",
		Description:      "Starts the workflow when new emails arrive in Gmail",
		Version:          landflow.V(1),
		Kind:             landflow.KindTrigger,
		TriggerSource:    landflow.TriggerPoll,
		Categories:       []string{"Communication"},
		Icon:             "file:icons/gmail.svg",
		Color:            "#EA4335",
		Subtitle:         "{{event}}",
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		DocumentationURL: "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list",
		Keywords:         []string{"email", "mail", "new message", "inbox", "poll"},
		Credentials:      credentialRequirements(),
		Properties: []landflow.PropertyDescriptor{
			authProperty(),
			landflow.PollIntervalProperty(60),
			{
				Name: "event", DisplayName: "Event", Type: landflow.PropOptions, Default: "messageReceived", NoDataExpression: true,
				Options: []landflow.PropertyOption{{Name: "Message Received", Value: "messageReceived"}},
			},
			simplifyProperty(nil),
			gmailFilters(nil),
		},
	}
}

func (GmailTriggerNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	c, err := newClient(ctx, ctx.ParamString("authentication", 0, "serviceAccount"))
	if err != nil {
		return nil, err
	}
	filters := asMap(ctx.Param("filters", 0))
	simple := ctx.ParamBool("simple", 0, true)

	if ctx.Mode() == landflow.ModeManual {
		refs, err := listMessages(ctx, c, gmailListQuery(filters), gmailManualMessages)
		if err != nil {
			return nil, err
		}
		msgs, raws, err := fetchMessages(ctx, c, refs)
		if err != nil {
			return nil, err
		}
		return [][]landflow.Item{messageItems(msgs, raws, simple)}, nil
	}

	state := landflow.CredentialData(ctx.PollState())
	if ctx.IsFirstPoll() || !state.Has("lastInternalDate") {
		// Baseline: remember the newest matching message, emit nothing.
		last, seen := now().UnixMilli(), []string{}
		refs, err := listMessages(ctx, c, gmailListQuery(filters), 1)
		if err != nil {
			return nil, err
		}
		if len(refs) > 0 {
			m, err := getMessage(ctx, c, refs[0].ID, "minimal")
			if err != nil {
				return nil, err
			}
			if ms, ok := m.internalTime(); ok {
				last, seen = ms, []string{m.ID}
			}
		}
		ctx.SetPollState(map[string]any{"lastInternalDate": last, "seenIds": seen})
		return nil, nil
	}

	last := int64(state.Float("lastInternalDate", 0))
	seen := stringList(state["seenIds"])
	// after: takes seconds; one second of overlap, deduplicated by seenIds.
	query := gmailListQuery(filters, "after:"+strconv.FormatInt(last/1000-1, 10))
	refs, err := listMessages(ctx, c, query, gmailMaxPerPoll)
	if err != nil {
		return nil, err
	}
	refs = slices.DeleteFunc(refs, func(r messageRef) bool { return slices.Contains(seen, r.ID) })
	msgs, raws, err := fetchMessages(ctx, c, refs)
	if err != nil {
		return nil, err
	}
	var newMsgs []*gmailMessage
	var newRaws []map[string]any
	for k, m := range msgs {
		if ms, ok := m.internalTime(); ok && ms >= last {
			newMsgs = append(newMsgs, m)
			newRaws = append(newRaws, raws[k])
		}
	}
	items := messageItems(newMsgs, newRaws, simple) // sorts oldest first

	newLast := last
	var newSeen []string
	for k := len(newMsgs) - 1; k >= 0; k-- { // newest first
		ms, _ := newMsgs[k].internalTime()
		newLast = max(newLast, ms)
		newSeen = append(newSeen, newMsgs[k].ID)
	}
	newSeen = append(newSeen, seen...)
	if len(newSeen) > gmailSeenIDs {
		newSeen = newSeen[:gmailSeenIDs]
	}
	ctx.SetPollState(map[string]any{"lastInternalDate": newLast, "seenIds": newSeen})
	if len(items) > 0 {
		ctx.Metrics().Counter("landflow.google.poll.new_items", landflow.WithDescription("New items found by Google polling triggers")).
			Add(float64(len(items)), landflow.Attrs{"trigger": "gmail"})
		ctx.Logger.Info("%d new message(s)", len(items))
	}
	return [][]landflow.Item{items}, nil
}

// messageItems sorts messages oldest first (in place, raws alongside) and
// shapes them as items.
func messageItems(msgs []*gmailMessage, raws []map[string]any, simple bool) []landflow.Item {
	type pair struct {
		m   *gmailMessage
		raw map[string]any
	}
	pairs := make([]pair, len(msgs))
	for k := range msgs {
		pairs[k] = pair{msgs[k], raws[k]}
	}
	slices.SortStableFunc(pairs, func(a, b pair) int {
		ta, _ := a.m.internalTime()
		tb, _ := b.m.internalTime()
		return cmp.Compare(ta, tb)
	})
	out := make([]landflow.Item, len(pairs))
	for k, p := range pairs {
		msgs[k], raws[k] = p.m, p.raw
		if simple {
			out[k] = landflow.Item{JSON: p.m.simplify()}
		} else {
			out[k] = landflow.Item{JSON: p.raw}
		}
	}
	return out
}

// LoadOptionsWithContext serves the label picker.
func (GmailTriggerNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadGmailLabels(ctx)
}
