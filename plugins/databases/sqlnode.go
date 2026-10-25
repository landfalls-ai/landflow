package main

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// ---------------------------------------------------------------------------
// Session: one call's view of one database
// ---------------------------------------------------------------------------

// querier is a *sql.DB or a *sql.Tx.
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// column is one column of a table, as the catalogue reports it.
type column struct {
	name   string
	dbType string
}

// session binds a pooled connection, the dialect and the observer to one
// Execute or LoadOptions call. It caches table columns for the call.
type session struct {
	d       *dialect
	db      *sql.DB
	call    callContext
	obs     *observer
	columns map[string][]column
}

// openSession takes the credential's pool from the cache. The caller must
// call release when done.
func openSession(call callContext, d *dialect, creds landflow.CredentialData) (*session, func(), error) {
	db, release, err := pools.sqlDB(d, d.settings(creds), func() (*sql.DB, error) { return d.open(creds) })
	if err != nil {
		return nil, nil, landflow.NewNodeError("Cannot connect: %s", landflow.RedactString(call, err.Error()))
	}
	s := &session{
		d: d, db: db, call: call, columns: map[string][]column{},
		obs: &observer{system: d.system, server: d.server(creds), metrics: call.Metrics()},
	}
	return s, func() {
		s.obs.recordPool(pools)
		release()
	}, nil
}

// query runs a statement that returns rows inside a DB span.
func (s *session) query(parent dbSpanner, q querier, st stmt, skip ...string) ([]map[string]any, error) {
	var out []map[string]any
	err := s.obs.do(parent, st.op, st.table, st.sql, func(span landflow.Span) (int64, int64, error) {
		rows, err := q.QueryContext(span, st.sql, st.args...)
		if err != nil {
			return 0, 0, err
		}
		defer rows.Close()
		out, err = scanRows(rows, s.d.system, skip...)
		if st.op == "SELECT" {
			return int64(len(out)), 0, err
		}
		return 0, int64(len(out)), err
	})
	return out, err
}

// exec runs a statement without a result set inside a DB span and returns
// the affected row count.
func (s *session) exec(parent dbSpanner, q querier, st stmt) (int64, error) {
	var n int64
	err := s.obs.do(parent, st.op, st.table, st.sql, func(span landflow.Span) (int64, int64, error) {
		res, err := q.ExecContext(span, st.sql, st.args...)
		if err != nil {
			return 0, 0, err
		}
		n, _ = res.RowsAffected()
		return 0, n, nil
	})
	return n, err
}

// transaction runs fn in one transaction inside a "db.transaction" span; fn
// returns how many statements it ran. Any error rolls everything back.
func (s *session) transaction(fn func(tx *sql.Tx, span landflow.Span) (int, error)) error {
	attrs := landflow.Attrs{"db.system": s.d.system, "db.namespace": s.obs.server.namespace}
	return s.callSpan("db.transaction", attrs, func(span landflow.Span) error {
		tx, err := s.db.BeginTx(span, nil)
		if err != nil {
			return err
		}
		n, err := fn(tx, span)
		span.SetAttribute("landflow.statements", n)
		if err != nil {
			_ = tx.Rollback()
			span.SetAttribute("landflow.db.rolled_back", true)
			return err
		}
		return tx.Commit()
	})
}

func (s *session) callSpan(name string, attrs landflow.Attrs, fn func(span landflow.Span) error) error {
	type spanner interface {
		Span(name string, attrs landflow.Attrs, fn func(span landflow.Span) error) error
	}
	if sp, ok := s.call.(spanner); ok {
		return sp.Span(name, attrs, fn)
	}
	return fn(landflow.Span{})
}

// ---------------------------------------------------------------------------
// Catalogue: schemas, tables, columns
// ---------------------------------------------------------------------------

func (s *session) catalogue(collection, query string, args ...any) ([][2]string, error) {
	var out [][2]string
	err := s.obs.do(s.call, "SELECT", collection, query, func(span landflow.Span) (int64, int64, error) {
		rows, err := s.db.QueryContext(span, query, args...)
		if err != nil {
			return 0, 0, err
		}
		defer rows.Close()
		cols, _ := rows.Columns()
		for rows.Next() {
			var a, b sql.NullString
			dest := []any{&a, &b}[:min(2, len(cols))]
			if err := rows.Scan(dest...); err != nil {
				return 0, 0, err
			}
			out = append(out, [2]string{a.String, b.String})
		}
		return int64(len(out)), 0, rows.Err()
	})
	return out, err
}

func (s *session) schemas() ([]string, error) {
	rows, err := s.catalogue("information_schema.schemata", s.d.schemasQuery)
	names := make([]string, len(rows))
	for i, r := range rows {
		names[i] = r[0]
	}
	return names, err
}

// tables returns [name, kind] pairs ("table" or "view").
func (s *session) tables(schema string) ([][2]string, error) {
	if s.d.hasSchemas {
		return s.catalogue(catalogueTables(s.d), s.d.tablesQuery, schema)
	}
	return s.catalogue(catalogueTables(s.d), s.d.tablesQuery)
}

// loadColumns returns a table's columns in ordinal order (none when the
// table does not exist), cached for the call.
func (s *session) loadColumns(schema, table string) ([]column, error) {
	key := schema + "\x00" + table
	if cols, ok := s.columns[key]; ok {
		return cols, nil
	}
	var rows [][2]string
	var err error
	if s.d.hasSchemas {
		rows, err = s.catalogue(catalogueColumns(s.d), s.d.columnsQuery, schema, table)
	} else {
		rows, err = s.catalogue(catalogueColumns(s.d), s.d.columnsQuery, table)
	}
	if err != nil {
		return nil, err
	}
	cols := make([]column, len(rows))
	for i, r := range rows {
		cols[i] = column{name: r[0], dbType: r[1]}
	}
	s.columns[key] = cols
	return cols, nil
}

func catalogueTables(d *dialect) string {
	if d.system == systemSQLite {
		return "sqlite_master"
	}
	return "information_schema.tables"
}

func catalogueColumns(d *dialect) string {
	if d.system == systemSQLite {
		return "pragma_table_info"
	}
	return "information_schema.columns"
}

// resolveColumn maps a user-supplied column name onto a real column: an
// exact match first, then a unique case-insensitive one. Anything else is
// rejected, which is what keeps identifiers out of reach of injection.
func resolveColumn(cols []column, name string) (string, bool) {
	name = strings.TrimSpace(name)
	for _, c := range cols {
		if c.name == name {
			return c.name, true
		}
	}
	found := ""
	for _, c := range cols {
		if strings.EqualFold(c.name, name) {
			if found != "" {
				return "", false
			}
			found = c.name
		}
	}
	return found, found != ""
}

func columnNames(cols []column) string {
	names := make([]string, len(cols))
	for i, c := range cols {
		names[i] = c.name
	}
	if len(names) > 30 {
		names = append(names[:30], "…")
	}
	return strings.Join(names, ", ")
}

// table is the target of a table operation for one item.
type table struct {
	schema, name string
	cols         []column
}

func (t table) label() string {
	if t.schema != "" {
		return t.schema + "." + t.name
	}
	return t.name
}

// column resolves name against the table or fails with an item error that
// lists the real columns.
func (t table) column(i int, name, field string) (string, error) {
	c, ok := resolveColumn(t.cols, name)
	if !ok {
		return "", landflow.ItemError(i, "%s %q is not a column of table %s", field, strings.TrimSpace(name), t.label()).
			WithDescription("Columns: " + columnNames(t.cols))
	}
	return c, nil
}

// target reads the schema and table parameters of item i and loads the
// table's columns, which every identifier is then checked against.
func (s *session) target(ctx *landflow.ExecuteContext, i int) (table, error) {
	t := table{name: strings.TrimSpace(ctx.ParamString("table", i, ""))}
	if s.d.hasSchemas {
		t.schema = strings.TrimSpace(ctx.ParamString("schema", i, "public"))
	}
	if t.name == "" {
		return t, landflow.ItemError(i, "No table selected").WithDescription("Choose a table in “Table”.")
	}
	cols, err := s.loadColumns(t.schema, t.name)
	if err != nil {
		return t, dbError(ctx, i, err)
	}
	if len(cols) == 0 {
		return t, landflow.ItemError(i, "Table %s does not exist", t.label()).
			WithDescription("Pick a table from the list, and check that the credential's user can see it.")
	}
	t.cols = cols
	return t, nil
}

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

// entries returns the entries of a fixedCollection group:
// {"values": [{…}, …]} (multipleValues) or {"values": {…}}.
func entries(v any, group string) []map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	switch t := m[group].(type) {
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, e := range t {
			if em, ok := e.(map[string]any); ok {
				out = append(out, em)
			}
		}
		return out
	case map[string]any:
		return []map[string]any{t}
	}
	return nil
}

// optionsOf returns the "options" collection of item i.
func optionsOf(ctx *landflow.ExecuteContext, i int) landflow.CredentialData {
	if m, ok := ctx.Param("options", i).(map[string]any); ok {
		return m
	}
	return landflow.CredentialData{}
}

// nameList reads a comma-separated list (or an array) of column names.
func nameList(v any) []string {
	var raw []string
	switch t := v.(type) {
	case []any:
		for _, e := range t {
			raw = append(raw, landflow.Stringify(e))
		}
	case nil:
	default:
		raw = strings.Split(landflow.Stringify(t), ",")
	}
	var out []string
	for _, s := range raw {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// conditions reads and validates the "Select Rows" collection of item i.
func (s *session) conditions(ctx *landflow.ExecuteContext, i int, t table) ([]condition, string, error) {
	var conds []condition
	for n, e := range entries(ctx.Param("where", i), "values") {
		name := strings.TrimSpace(landflow.Stringify(e["column"]))
		if name == "" {
			return nil, "", landflow.ItemError(i, "Condition %d has no column", n+1).
				WithDescription("Fill in the column or remove the condition.")
		}
		col, err := t.column(i, name, "Column")
		if err != nil {
			return nil, "", err
		}
		op := landflow.Stringify(e["condition"])
		if op == "" {
			op = "equal"
		}
		if _, ok := conditionOperators[op]; !ok {
			return nil, "", landflow.ItemError(i, "Unknown operator %q in condition %d", op, n+1)
		}
		conds = append(conds, condition{column: col, op: op, value: e["value"]})
	}
	combine := ctx.ParamString("combineConditions", i, "AND")
	if combine != "OR" {
		combine = "AND"
	}
	return conds, combine, nil
}

// mappedValues returns the column → value pairs to write for item i, in the
// table's column order, plus the item key each column came from.
func (s *session) mappedValues(ctx *landflow.ExecuteContext, i int, item landflow.Item, t table) ([]string, map[string]any, error) {
	values := map[string]any{}
	switch mode := ctx.ParamString("dataMode", i, "autoMapInputData"); mode {
	case "autoMapInputData":
		for key, v := range item.JSON {
			col, ok := resolveColumn(t.cols, key)
			if !ok {
				continue // fields that are not columns are ignored
			}
			if _, dup := values[col]; dup {
				return nil, nil, landflow.ItemError(i, "Fields of item %d map to column %q more than once", i, col)
			}
			values[col] = v
		}
		if len(values) == 0 {
			return nil, nil, landflow.ItemError(i, "None of the fields of item %d match a column of table %s", i, t.label()).
				WithDescription("Columns: " + columnNames(t.cols) + ". Rename the fields (Edit Fields) or map the columns manually.")
		}
	case "defineBelow":
		for _, e := range entries(ctx.Param("valuesToSend", i), "values") {
			name := landflow.Stringify(e["column"])
			if strings.TrimSpace(name) == "" {
				continue
			}
			col, err := t.column(i, name, "Column")
			if err != nil {
				return nil, nil, err
			}
			values[col] = e["value"]
		}
		if len(values) == 0 {
			return nil, nil, landflow.ItemError(i, "No columns to write").WithDescription("Add at least one column under “Values to Send”.")
		}
	default:
		return nil, nil, landflow.ItemError(i, "Unknown data mode %q", mode)
	}
	var cols []string
	for _, c := range t.cols {
		if _, ok := values[c.name]; ok {
			cols = append(cols, c.name)
		}
	}
	return cols, values, nil
}

// paired turns rows into items paired with input item i.
func paired(rows []map[string]any, i int) []landflow.Item {
	out := make([]landflow.Item, len(rows))
	for k, r := range rows {
		out[k] = landflow.Item{JSON: r, PairedItem: &landflow.PairedItem{Item: i}}
	}
	return out
}

func itemCount(ctx *landflow.ExecuteContext) int { return max(1, len(ctx.InputData(0))) }

func itemAt(ctx *landflow.ExecuteContext, i int) landflow.Item {
	if items := ctx.InputData(0); i < len(items) {
		return items[i]
	}
	return landflow.Item{JSON: map[string]any{}}
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// executeQuery runs the user's SQL with bound parameters: once (single),
// once per item (independently), or once per item in one transaction.
func (s *session) executeQuery(ctx *landflow.ExecuteContext) ([]landflow.Item, error) {
	switch batching := optionsOf(ctx, 0).StringOr("queryBatching", "single"); batching {
	case "single":
		rows, err := s.runQuery(ctx, s.db, ctx, 0)
		return paired(rows, 0), err
	case "independently":
		var out []landflow.Item
		for i := range itemCount(ctx) {
			rows, err := s.runQuery(ctx, s.db, ctx, i)
			if err != nil {
				if ctx.ContinueOnFail() {
					out = append(out, ctx.ErrorItem(i, err))
					continue
				}
				return nil, err
			}
			out = append(out, paired(rows, i)...)
		}
		return out, nil
	case "transaction":
		var out []landflow.Item
		err := s.transaction(func(tx *sql.Tx, span landflow.Span) (int, error) {
			n := itemCount(ctx)
			for i := range n {
				rows, err := s.runQuery(ctx, tx, span, i)
				if err != nil {
					return i + 1, err
				}
				out = append(out, paired(rows, i)...)
			}
			return n, nil
		})
		if err != nil {
			return nil, dbError(ctx, -1, err)
		}
		return out, nil
	default:
		return nil, landflow.NewNodeError("Unknown query batching %q", batching).
			WithDescription("Choose Single Query, Independently or Transaction.")
	}
}

// runQuery executes the query of item i. Statements that return rows give
// the rows; the others give one {success, affectedRows} item.
func (s *session) runQuery(ctx *landflow.ExecuteContext, q querier, parent dbSpanner, i int) ([]map[string]any, error) {
	query := strings.TrimSpace(ctx.ParamString("query", i, ""))
	if query == "" {
		return nil, landflow.ItemError(i, "The query is empty").WithDescription("Write the SQL to run in “Query”.")
	}
	params := parseQueryParameters(optionsOf(ctx, i)["queryReplacement"])
	args := make([]any, len(params))
	for k, p := range params {
		args[k] = s.d.bind(p)
	}
	op := operationName(query)
	statement := sanitizeStatement(query, s.d.doubleQuotedStrings)
	var out []map[string]any
	err := s.obs.do(parent, op, "", statement, func(span landflow.Span) (int64, int64, error) {
		if !returnsRows(query) {
			res, err := q.ExecContext(span, query, args...)
			if err != nil {
				return 0, 0, err
			}
			n, _ := res.RowsAffected()
			out = []map[string]any{{"success": true, "affectedRows": n}}
			return 0, n, nil
		}
		rows, err := q.QueryContext(span, query, args...)
		if err != nil {
			return 0, 0, err
		}
		defer rows.Close()
		if cols, _ := rows.Columns(); len(cols) == 0 {
			for rows.Next() {
			}
			out = []map[string]any{{"success": true}}
			return 0, 0, rows.Err()
		}
		out, err = scanRows(rows, s.d.system)
		return int64(len(out)), 0, err
	})
	if err != nil {
		return nil, dbError(ctx, i, err)
	}
	return out, nil
}

// selectRows reads rows per item with the where, sort, limit and output
// column settings.
func (s *session) selectRows(ctx *landflow.ExecuteContext) ([]landflow.Item, error) {
	var out []landflow.Item
	for i := range itemCount(ctx) {
		t, err := s.target(ctx, i)
		if err != nil {
			return nil, err
		}
		conds, combine, err := s.conditions(ctx, i, t)
		if err != nil {
			return nil, err
		}
		var sorts []sortSpec
		for _, e := range entries(ctx.Param("sort", i), "values") {
			name := landflow.Stringify(e["column"])
			if strings.TrimSpace(name) == "" {
				continue
			}
			col, err := t.column(i, name, "Sort column")
			if err != nil {
				return nil, err
			}
			dir := strings.ToUpper(landflow.Stringify(e["direction"]))
			if dir != "DESC" {
				dir = "ASC"
			}
			sorts = append(sorts, sortSpec{column: col, direction: dir})
		}
		var outCols []string
		for _, name := range nameList(optionsOf(ctx, i)["outputColumns"]) {
			col, err := t.column(i, name, "Output column")
			if err != nil {
				return nil, err
			}
			outCols = append(outCols, col)
		}
		limit := 0
		if !ctx.ParamBool("returnAll", i, false) {
			limit = max(1, ctx.ParamInt("limit", i, 50))
		}
		rows, err := s.query(ctx, s.db, s.d.buildSelect(t.schema, t.name, outCols, conds, combine, sorts, limit))
		if err != nil {
			return nil, dbError(ctx, i, err)
		}
		out = append(out, paired(rows, i)...)
	}
	return out, nil
}

// pendingRow is one item's row waiting to be written by insert/upsert.
type pendingRow struct {
	item   int
	t      table
	cols   []string
	values map[string]any
	match  []string
}

func (r pendingRow) sameShape(o pendingRow) bool {
	return r.t.schema == o.t.schema && r.t.name == o.t.name && slices.Equal(r.cols, o.cols) && slices.Equal(r.match, o.match)
}

// insert writes the items as multi-row INSERTs (upsert: with the conflict
// clause on "Columns to Match On"). Consecutive items with the same table
// and columns share a statement; several statements run in one transaction.
func (s *session) insert(ctx *landflow.ExecuteContext, upsert bool) ([]landflow.Item, error) {
	var pending []pendingRow
	for i := range itemCount(ctx) {
		t, err := s.target(ctx, i)
		if err != nil {
			return nil, err
		}
		cols, values, err := s.mappedValues(ctx, i, itemAt(ctx, i), t)
		if err != nil {
			return nil, err
		}
		row := pendingRow{item: i, t: t, cols: cols, values: values}
		if upsert {
			names := nameList(ctx.Param("columnsToMatchOn", i))
			if len(names) == 0 {
				return nil, landflow.ItemError(i, "No columns to match on").
					WithDescription("Set “Columns to Match On” to the column(s) of a unique key, e.g. id.")
			}
			for _, name := range names {
				col, err := t.column(i, name, "Column to match on")
				if err != nil {
					return nil, err
				}
				if _, ok := values[col]; !ok {
					return nil, landflow.ItemError(i, "Item %d has no value for match column %q", i, col)
				}
				row.match = append(row.match, col)
			}
		}
		pending = append(pending, row)
	}

	// Group consecutive rows of the same shape into chunks.
	var groups [][]pendingRow
	for _, r := range pending {
		if n := len(groups); n > 0 && groups[n-1][0].sameShape(r) && len(groups[n-1]) < chunkSize(len(r.cols)) {
			groups[n-1] = append(groups[n-1], r)
		} else {
			groups = append(groups, []pendingRow{r})
		}
	}
	returning := s.d.returning && optionsOf(ctx, 0).Bool("returnRows", true)
	out := make([]landflow.Item, 0, len(pending))
	write := func(q querier, parent dbSpanner, g []pendingRow) error {
		first := g[0]
		rows := make([][]any, len(g))
		for k, r := range g {
			rows[k] = make([]any, len(first.cols))
			for c, col := range first.cols {
				rows[k][c] = r.values[col]
			}
		}
		st := s.d.buildInsert(first.t.schema, first.t.name, first.cols, rows, first.match, returning)
		if !returning {
			if _, err := s.exec(parent, q, st); err != nil {
				return err
			}
			for _, r := range g {
				out = append(out, landflow.Item{JSON: r.values, PairedItem: &landflow.PairedItem{Item: r.item}})
			}
			return nil
		}
		result, err := s.query(parent, q, st)
		if err != nil {
			return err
		}
		// RETURNING yields the rows in VALUES order.
		for k, row := range result {
			out = append(out, landflow.Item{JSON: row, PairedItem: &landflow.PairedItem{Item: g[min(k, len(g)-1)].item}})
		}
		return nil
	}

	var err error
	if len(groups) == 1 {
		err = write(s.db, ctx, groups[0])
	} else {
		err = s.transaction(func(tx *sql.Tx, span landflow.Span) (int, error) {
			for n, g := range groups {
				if err := write(tx, span, g); err != nil {
					return n + 1, err
				}
			}
			return len(groups), nil
		})
	}
	if err != nil {
		if len(pending) == 1 {
			return nil, dbError(ctx, pending[0].item, err)
		}
		return nil, dbError(ctx, -1, err)
	}
	return out, nil
}

// update sets the mapped columns of the rows whose "Column to Match On"
// equals the item's value (or "Value of Column to Match On").
func (s *session) update(ctx *landflow.ExecuteContext) ([]landflow.Item, error) {
	returning := s.d.returning && optionsOf(ctx, 0).Bool("returnRows", true)
	var out []landflow.Item
	for i := range itemCount(ctx) {
		t, err := s.target(ctx, i)
		if err != nil {
			return nil, err
		}
		matchName := ctx.ParamString("columnToMatchOn", i, "")
		if strings.TrimSpace(matchName) == "" {
			return nil, landflow.ItemError(i, "No column to match on").WithDescription("Choose “Column to Match On”, e.g. id.")
		}
		matchCol, err := t.column(i, matchName, "Column to match on")
		if err != nil {
			return nil, err
		}
		cols, values, err := s.mappedValues(ctx, i, itemAt(ctx, i), t)
		if err != nil {
			return nil, err
		}
		var matchVal any
		if ctx.ParamString("dataMode", i, "autoMapInputData") == "defineBelow" {
			matchVal = ctx.Param("valueToMatchOn", i)
		} else {
			v, ok := values[matchCol]
			if !ok {
				return nil, landflow.ItemError(i, "Item %d has no field for match column %q", i, matchCol)
			}
			matchVal = v
		}
		var setCols []string
		var setVals []any
		for _, c := range cols {
			if c != matchCol {
				setCols = append(setCols, c)
				setVals = append(setVals, values[c])
			}
		}
		if len(setCols) == 0 {
			return nil, landflow.ItemError(i, "Nothing to update in item %d", i).
				WithDescription("Map at least one column besides the match column " + matchCol + ".")
		}
		st := s.d.buildUpdate(t.schema, t.name, setCols, setVals, matchCol, matchVal, returning)
		if returning {
			rows, err := s.query(ctx, s.db, st)
			if err != nil {
				return nil, dbError(ctx, i, err)
			}
			out = append(out, paired(rows, i)...)
			continue
		}
		n, err := s.exec(ctx, s.db, st)
		if err != nil {
			return nil, dbError(ctx, i, err)
		}
		out = append(out, landflow.Item{JSON: map[string]any{"success": true, "affectedRows": n}, PairedItem: &landflow.PairedItem{Item: i}})
	}
	return out, nil
}

// deleteRows deletes the rows matching "Select Rows". Without conditions it
// refuses, unless "Delete All Rows" is on.
func (s *session) deleteRows(ctx *landflow.ExecuteContext) ([]landflow.Item, error) {
	var out []landflow.Item
	for i := range itemCount(ctx) {
		t, err := s.target(ctx, i)
		if err != nil {
			return nil, err
		}
		conds, combine, err := s.conditions(ctx, i, t)
		if err != nil {
			return nil, err
		}
		if len(conds) == 0 && !ctx.ParamBool("deleteAll", i, false) {
			return nil, landflow.ItemError(i, "Refusing to delete every row of %s", t.label()).
				WithDescription("Add a condition under “Select Rows”, or turn on “Delete All Rows” to empty the table.")
		}
		n, err := s.exec(ctx, s.db, s.d.buildDelete(t.schema, t.name, conds, combine))
		if err != nil {
			return nil, dbError(ctx, i, err)
		}
		out = append(out, landflow.Item{JSON: map[string]any{"success": true, "affectedRows": n}, PairedItem: &landflow.PairedItem{Item: i}})
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

// sqlNode is the Postgres, MySQL and SQLite node: the same operations over
// a different dialect.
type sqlNode struct {
	d           *dialect
	name        string
	displayName string
	product     string
	icon        string
	color       string
	docURL      string
	keywords    []string
}

func (n sqlNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials(n.d.credential)
	if err != nil {
		return nil, err
	}
	s, release, err := openSession(ctx, n.d, creds)
	if err != nil {
		return nil, err
	}
	defer release()

	var out []landflow.Item
	switch op := ctx.ParamString("operation", 0, "insert"); op {
	case "executeQuery":
		out, err = s.executeQuery(ctx)
	case "select":
		out, err = s.selectRows(ctx)
	case "insert":
		out, err = s.insert(ctx, false)
	case "upsert":
		out, err = s.insert(ctx, true)
	case "update":
		out, err = s.update(ctx)
	case "deleteTable":
		out, err = s.deleteRows(ctx)
	default:
		return nil, landflow.NewNodeError("Unsupported operation %q", op)
	}
	if err != nil {
		return nil, err
	}
	ctx.Logger.With("db.system", n.d.system, "items.out", len(out)).Info("%s: %d item(s)", ctx.ParamString("operation", 0, "insert"), len(out))
	return [][]landflow.Item{out}, nil
}

// LoadOptionsWithContext serves the schema, table and column pickers with
// the node's credential.
func (n sqlNode) LoadOptionsWithContext(ctx *landflow.LoadOptionsContext) ([]landflow.PropertyOption, error) {
	return loadCatalogueOptions(ctx, n.d)
}

func loadCatalogueOptions(ctx *landflow.LoadOptionsContext, d *dialect) ([]landflow.PropertyOption, error) {
	creds, err := ctx.RequireCredentials(d.credential)
	if err != nil {
		return nil, err
	}
	s, release, err := openSession(ctx, d, creds)
	if err != nil {
		return nil, err
	}
	defer release()
	schema := ""
	if d.hasSchemas {
		schema = ctx.ParamString("schema", "public")
	}
	var opts []landflow.PropertyOption
	switch ctx.Method() {
	case "getSchemas":
		names, err := s.schemas()
		if err != nil {
			return nil, dbError(ctx, -1, err)
		}
		for _, name := range names {
			opts = append(opts, landflow.PropertyOption{Name: name, Value: name})
		}
	case "getTables":
		tables, err := s.tables(schema)
		if err != nil {
			return nil, dbError(ctx, -1, err)
		}
		for _, t := range tables {
			opt := landflow.PropertyOption{Name: t[0], Value: t[0]}
			if t[1] == "view" {
				opt.Description = "view"
			}
			opts = append(opts, opt)
		}
	case "getColumns":
		name := strings.TrimSpace(ctx.ParamString("table", ""))
		if name == "" {
			return []landflow.PropertyOption{}, nil
		}
		cols, err := s.loadColumns(schema, name)
		if err != nil {
			return nil, dbError(ctx, -1, err)
		}
		for _, c := range cols {
			opts = append(opts, landflow.PropertyOption{Name: c.name, Value: c.name, Description: strings.ToLower(c.dbType)})
		}
	default:
		return nil, fmt.Errorf("unknown loadOptions method %q (supported: getSchemas, getTables, getColumns)", ctx.Method())
	}
	return opts, nil
}

// testSQL is the credential test of the SQL databases: connect and run
// SELECT 1 within the connect timeout. It uses a throwaway connection, so a
// failing credential never lands in the pool cache.
func testSQL(ctx context.Context, d *dialect, data landflow.CredentialData) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, connectTimeout(data))
	defer cancel()
	db, err := d.open(data)
	if err != nil {
		return false, landflow.RedactString(ctx, err.Error())
	}
	defer db.Close()
	srv := d.server(data)
	err = testSpan(ctx, landflow.DBSpanInfo{System: d.system, Operation: "SELECT", Statement: "SELECT 1",
		Namespace: srv.namespace, ServerAddress: srv.address, ServerPort: srv.port}, func(ctx context.Context) error {
		var one int
		return db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
	})
	if err != nil {
		return false, landflow.RedactString(ctx, err.Error())
	}
	return true, "Connection tested successfully"
}
