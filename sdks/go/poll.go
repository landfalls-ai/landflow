package landflow

// Polling triggers (docs/protocol.md §8). A node with Kind: KindTrigger and
// TriggerSource: TriggerPoll is called with mode "poll" every pollInterval
// seconds while its workflow is active:
//
//	func (FeedTrigger) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
//		entries, err := fetch(ctx) // newest first
//		if err != nil {
//			return nil, err
//		}
//		if ctx.Mode() == landflow.ModeManual { // editor "Execute": show recent data, no state
//			return [][]landflow.Item{toItems(entries[:min(3, len(entries))])}, nil
//		}
//		last, _ := ctx.PollState()["lastId"].(string)
//		if len(entries) > 0 {
//			ctx.SetPollState(map[string]any{"lastId": entries[0].ID})
//		}
//		if ctx.IsFirstPoll() { // baseline only: do not replay history
//			return nil, nil
//		}
//		return [][]landflow.Item{toItems(newerThan(entries, last))}, nil
//	}
//
// NewPlugin adds PollIntervalProperty(60) to a poll trigger that declares no
// pollInterval property.

const (
	// PollIntervalName is the property the host reads the poll interval from.
	PollIntervalName = "pollInterval"
	// DefaultPollIntervalSeconds and MinPollIntervalSeconds bound pollInterval.
	DefaultPollIntervalSeconds = 60
	MinPollIntervalSeconds     = 10
)

// PollIntervalProperty returns the pollInterval number property (seconds,
// minimum 10) with the given default (60 when <= 0).
func PollIntervalProperty(defaultSeconds int) PropertyDescriptor {
	if defaultSeconds <= 0 {
		defaultSeconds = DefaultPollIntervalSeconds
	}
	defaultSeconds = max(defaultSeconds, MinPollIntervalSeconds)
	return PropertyDescriptor{
		Name: PollIntervalName, DisplayName: "Poll Interval", Type: PropNumber, Default: defaultSeconds,
		Description:      "Seconds between checks for new events while the workflow is active (minimum 10)",
		NoDataExpression: true,
		TypeOptions:      &TypeOptions{MinValue: Ptr(float64(MinPollIntervalSeconds)), NumberPrecision: Ptr(0)},
	}
}
