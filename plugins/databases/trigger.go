package main

import (
	"errors"
	"slices"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// pollTrigger is the "New Row" trigger shared by Postgres and SQLite. It
// polls a table for rows whose tracking column (an id or created_at that
// only grows) is greater than the last value seen:
//
//	first poll   SELECT CAST(MAX(col) AS TEXT) … → state {lastValue}, no items
//	later polls  SELECT *, CAST(col AS TEXT) … WHERE col > $1 ORDER BY col ASC LIMIT n
//	manual run   the latest 5 rows (oldest first), state untouched
//
// n8n's Postgres Trigger uses LISTEN/NOTIFY and installs a trigger function
// in the database. Polling works with any user that can SELECT the table,
// needs no triggers, functions or extra privileges, and catches rows
// inserted while the workflow was off (up to "Max Rows per Poll" per poll).
type pollTrigger struct {
	d           *dialect
	name        string
	displayName string
	product     string
	icon        string
	color       string
	docURL      string
	notice      string
}

const manualRows = 5

func (n pollTrigger) Description() landflow.NodeDescriptor {
	tableDeps := []string{}
	var props []landflow.PropertyDescriptor
	if n.notice != "" {
		props = append(props, landflow.PropertyDescriptor{Name: "pollingNotice", DisplayName: n.notice, Type: landflow.PropNotice, Default: ""})
	}
	props = append(props,
		landflow.PropertyDescriptor{
			Name: "event", DisplayName: "Event", Type: landflow.PropOptions, Default: "newRow", NoDataExpression: true,
			Options: []landflow.PropertyOption{{Name: "New Row", Value: "newRow", Description: "A row whose tracking column is greater than any seen before"}},
		},
		landflow.PollIntervalProperty(60),
	)
	if n.d.hasSchemas {
		tableDeps = []string{"schema"}
		props = append(props, landflow.PropertyDescriptor{
			Name: "schema", DisplayName: "Schema", Type: landflow.PropOptions, Default: "public",
			Options:     []landflow.PropertyOption{{Name: "public", Value: "public"}},
			TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "getSchemas"},
		})
	}
	props = append(props,
		landflow.PropertyDescriptor{
			Name: "table", DisplayName: "Table", Type: landflow.PropOptions, Default: "", Required: true,
			TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "getTables", LoadOptionsDependsOn: tableDeps},
		},
		landflow.PropertyDescriptor{
			Name: "trackingColumn", DisplayName: "Tracking Column", Type: landflow.PropOptions, Default: "", Required: true,
			Description: "A column that only grows, such as an auto-increment id or a created_at timestamp. " +
				"Rows are emitted in its order; use a unique column so no two rows share a value.",
			TypeOptions: &landflow.TypeOptions{LoadOptionsMethod: "getColumns", LoadOptionsDependsOn: append(tableDeps, "table")},
		},
		landflow.PropertyDescriptor{
			Name: "limit", DisplayName: "Max Rows per Poll", Type: landflow.PropNumber, Default: 100,
			Description: "Rows emitted per poll at most; the rest follow on the next polls",
			TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(10000.0), NumberPrecision: landflow.Ptr(0)},
		},
	)
	return landflow.NodeDescriptor{
		Name:             n.name,
		DisplayName:      n.displayName,
		Description:      "Starts the workflow when new rows appear in a " + n.product + " table (polling)",
		Version:          landflow.V(1),
		Kind:             landflow.KindTrigger,
		TriggerSource:    landflow.TriggerPoll,
		Categories:       categories,
		Icon:             n.icon,
		Color:            n.color,
		Subtitle:         "New rows in {{table}}",
		DocumentationURL: n.docURL,
		Keywords:         []string{"new row", "insert", "poll", "trigger", n.d.system},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		Credentials:      []landflow.NodeCredentialRequirement{{Name: n.d.credential, Required: true}},
		Properties:       props,
	}
}

func (n pollTrigger) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials(n.d.credential)
	if err != nil {
		return nil, err
	}
	s, release, err := openSession(ctx, n.d, creds)
	if err != nil {
		return nil, err
	}
	defer release()

	t, err := s.target(ctx, 0)
	if err != nil {
		return nil, notItemSpecific(err)
	}
	name := ctx.ParamString("trackingColumn", 0, "")
	if strings.TrimSpace(name) == "" {
		return nil, landflow.NewNodeError("No tracking column selected").
			WithDescription("Choose a column that only grows, such as id or created_at.")
	}
	col, err := t.column(0, name, "Tracking column")
	if err != nil {
		return nil, notItemSpecific(err)
	}
	limit := min(max(ctx.ParamInt("limit", 0, 100), 1), 10000)

	// Manual run: the latest rows, oldest first, without touching the state.
	if ctx.Mode() != landflow.ModePoll {
		rows, err := s.query(ctx, s.db, s.d.buildLatest(t.schema, t.name, col, manualRows), cursorAlias)
		if err != nil {
			return nil, dbError(ctx, -1, err)
		}
		slices.Reverse(rows)
		return [][]landflow.Item{toItems(rows)}, nil
	}

	state := ctx.PollState()
	last, ok := state["lastValue"]
	if ctx.IsFirstPoll() || !ok {
		// Baseline: remember the current maximum, emit nothing.
		rows, err := s.query(ctx, s.db, s.d.buildMax(t.schema, t.name, col))
		if err != nil {
			return nil, dbError(ctx, -1, err)
		}
		var baseline any
		if len(rows) > 0 {
			baseline = rows[0][cursorAlias]
		}
		ctx.SetPollState(map[string]any{"lastValue": baseline})
		ctx.Logger.With("db.system", n.d.system).Info("baseline for %s.%s: %v", t.label(), col, baseline)
		return nil, nil
	}

	rows, err := s.query(ctx, s.db, s.d.buildNewRows(t.schema, t.name, col, last, limit))
	if err != nil {
		return nil, dbError(ctx, -1, err)
	}
	for _, r := range rows {
		last = r[cursorAlias]
		delete(r, cursorAlias)
	}
	ctx.SetPollState(map[string]any{"lastValue": last})
	s.obs.newRows(len(rows))
	if len(rows) > 0 {
		ctx.Logger.With("db.system", n.d.system, "rows", len(rows)).Info("%d new row(s) in %s", len(rows), t.label())
	}
	return [][]landflow.Item{toItems(rows)}, nil
}

func (n pollTrigger) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadCatalogueOptions(ctx, n.d)
}

func toItems(rows []map[string]any) []landflow.Item {
	out := make([]landflow.Item, len(rows))
	for i, r := range rows {
		out[i] = landflow.Item{JSON: r}
	}
	return out
}

// notItemSpecific drops the item index from errors raised while reading
// parameters: a trigger has no input items.
func notItemSpecific(err error) error {
	var ne *landflow.NodeError
	if errors.As(err, &ne) && ne.ItemIndex != nil {
		c := *ne
		c.ItemIndex = nil
		return &c
	}
	return err
}

var postgresTrigger = pollTrigger{
	d: postgresDialect, name: "postgresTrigger", displayName: "Postgres Trigger", product: "PostgreSQL",
	icon: "file:icons/postgres-trigger.svg", color: "#336791",
	docURL: "https://www.postgresql.org/docs/current/sql-select.html",
	notice: "This trigger polls the table for new rows. Unlike a LISTEN/NOTIFY trigger it needs no trigger " +
		"functions in the database and works with any user that can read the table.",
}

var sqliteTrigger = pollTrigger{
	d: sqliteDialect, name: "sqliteTrigger", displayName: "SQLite Trigger", product: "SQLite",
	icon: "file:icons/sqlite-trigger.svg", color: "#0F80CC",
	docURL: "https://www.sqlite.org/lang_select.html",
}
