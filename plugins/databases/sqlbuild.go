package main

import "strings"

// Statement builders. Identifiers reaching these functions have already been
// checked against the table's real columns (session.resolveColumn) and are
// quoted again here; values only ever travel as bind arguments.

// stmt is one parameterised statement plus what its span reports.
type stmt struct {
	sql   string
	args  []any
	op    string // db.operation.name
	table string // db.collection.name
}

// condition is one entry of a "Select Rows" collection.
type condition struct {
	column string
	op     string // a key of conditionOperators
	value  any
}

// conditionOperators maps the where operators (n8n's values) to SQL.
var conditionOperators = map[string]string{
	"equal": "=", "!=": "!=", ">": ">", "<": "<", ">=": ">=", "<=": "<=",
	"LIKE": "LIKE", "IS NULL": "IS NULL", "IS NOT NULL": "IS NOT NULL",
}

// sortSpec is one entry of the "Sort" collection.
type sortSpec struct {
	column    string
	direction string // ASC | DESC
}

// args collects bind arguments and hands out placeholders.
type argList struct {
	d    *dialect
	args []any
}

func (a *argList) add(v any) string {
	a.args = append(a.args, a.d.bind(v))
	return a.d.placeholder(len(a.args))
}

// where renders conditions joined by AND or OR ("" when there are none).
func (d *dialect) where(a *argList, conds []condition, combine string) string {
	if len(conds) == 0 {
		return ""
	}
	joiner := " AND "
	if combine == "OR" {
		joiner = " OR "
	}
	parts := make([]string, len(conds))
	for i, c := range conds {
		sqlOp := conditionOperators[c.op]
		switch c.op {
		case "IS NULL", "IS NOT NULL":
			parts[i] = d.quote(c.column) + " " + sqlOp
		default:
			parts[i] = d.quote(c.column) + " " + sqlOp + " " + a.add(c.value)
		}
	}
	return " WHERE " + strings.Join(parts, joiner)
}

func (d *dialect) columnList(cols []string) string {
	quoted := make([]string, len(cols))
	for i, c := range cols {
		quoted[i] = d.quote(c)
	}
	return strings.Join(quoted, ", ")
}

// buildSelect: SELECT cols FROM t WHERE … ORDER BY … LIMIT n (limit 0 = all).
func (d *dialect) buildSelect(schema, table string, cols []string, conds []condition, combine string, sorts []sortSpec, limit int) stmt {
	a := &argList{d: d}
	var b strings.Builder
	b.WriteString("SELECT ")
	if len(cols) == 0 {
		b.WriteString("*")
	} else {
		b.WriteString(d.columnList(cols))
	}
	b.WriteString(" FROM " + d.table(schema, table))
	b.WriteString(d.where(a, conds, combine))
	if len(sorts) > 0 {
		parts := make([]string, len(sorts))
		for i, s := range sorts {
			parts[i] = d.quote(s.column) + " " + s.direction
		}
		b.WriteString(" ORDER BY " + strings.Join(parts, ", "))
	}
	if limit > 0 {
		b.WriteString(" LIMIT " + a.add(float64(limit)))
	}
	return stmt{sql: b.String(), args: a.args, op: "SELECT", table: table}
}

// buildInsert: one multi-row INSERT, optionally an upsert (match = the
// conflict columns) and with RETURNING *.
func (d *dialect) buildInsert(schema, table string, cols []string, rows [][]any, match []string, returning bool) stmt {
	a := &argList{d: d}
	var b strings.Builder
	b.WriteString("INSERT INTO " + d.table(schema, table) + " (" + d.columnList(cols) + ") VALUES ")
	for r, row := range rows {
		if r > 0 {
			b.WriteString(", ")
		}
		b.WriteString("(")
		for c, v := range row {
			if c > 0 {
				b.WriteString(", ")
			}
			b.WriteString(a.add(v))
		}
		b.WriteString(")")
	}
	if len(match) > 0 {
		var update []string
		for _, c := range cols {
			if !contains(match, c) {
				update = append(update, c)
			}
		}
		b.WriteString(d.upsertClause(match, update))
	}
	if returning {
		b.WriteString(" RETURNING *")
	}
	return stmt{sql: b.String(), args: a.args, op: "INSERT", table: table}
}

// buildUpdate: UPDATE t SET c = $1, … WHERE match = $n [RETURNING *].
func (d *dialect) buildUpdate(schema, table string, cols []string, values []any, matchCol string, matchVal any, returning bool) stmt {
	a := &argList{d: d}
	sets := make([]string, len(cols))
	for i, c := range cols {
		sets[i] = d.quote(c) + " = " + a.add(values[i])
	}
	q := "UPDATE " + d.table(schema, table) + " SET " + strings.Join(sets, ", ")
	if matchVal == nil {
		q += " WHERE " + d.quote(matchCol) + " IS NULL"
	} else {
		q += " WHERE " + d.quote(matchCol) + " = " + a.add(matchVal)
	}
	if returning {
		q += " RETURNING *"
	}
	return stmt{sql: q, args: a.args, op: "UPDATE", table: table}
}

// buildDelete: DELETE FROM t WHERE … (conds may only be empty when the user
// turned on "Delete All Rows"; the caller enforces that).
func (d *dialect) buildDelete(schema, table string, conds []condition, combine string) stmt {
	a := &argList{d: d}
	q := "DELETE FROM " + d.table(schema, table) + d.where(a, conds, combine)
	return stmt{sql: q, args: a.args, op: "DELETE", table: table}
}

// Trigger statements. cursor is the tracking column cast to text, so the
// value saved in the poll state round-trips exactly (a timestamp keeps its
// precision, a SQLite DATETIME string keeps its format) and compares in the
// database with the column's own type.

const cursorAlias = "__landflow_cursor"

func (d *dialect) cursorExpr(col string) string {
	return "CAST(" + d.quote(col) + " AS " + d.textType() + ")"
}

// textType is the type name CAST(… AS …) accepts for text.
func (d *dialect) textType() string {
	if d.system == systemMySQL {
		return "CHAR"
	}
	return "TEXT"
}

// buildMax: the current maximum of the tracking column (the baseline).
func (d *dialect) buildMax(schema, table, col string) stmt {
	q := "SELECT CAST(MAX(" + d.quote(col) + ") AS " + d.textType() + ") AS " + d.quote(cursorAlias) + " FROM " + d.table(schema, table)
	return stmt{sql: q, op: "SELECT", table: table}
}

// buildNewRows: rows after last (all rows when last is nil), oldest first.
func (d *dialect) buildNewRows(schema, table, col string, last any, limit int) stmt {
	a := &argList{d: d}
	q := "SELECT *, " + d.cursorExpr(col) + " AS " + d.quote(cursorAlias) + " FROM " + d.table(schema, table)
	if last == nil {
		q += " WHERE " + d.quote(col) + " IS NOT NULL"
	} else {
		q += " WHERE " + d.quote(col) + " > " + a.add(last)
	}
	q += " ORDER BY " + d.quote(col) + " ASC LIMIT " + a.add(float64(limit))
	return stmt{sql: q, args: a.args, op: "SELECT", table: table}
}

// buildLatest: the newest n rows (manual runs), newest first.
func (d *dialect) buildLatest(schema, table, col string, n int) stmt {
	a := &argList{d: d}
	q := "SELECT *, " + d.cursorExpr(col) + " AS " + d.quote(cursorAlias) + " FROM " + d.table(schema, table) +
		" WHERE " + d.quote(col) + " IS NOT NULL ORDER BY " + d.quote(col) + " DESC LIMIT " + a.add(float64(n))
	return stmt{sql: q, args: a.args, op: "SELECT", table: table}
}

// chunkSize bounds a multi-row INSERT by rows and by bind parameters.
func chunkSize(columns int) int {
	const maxRows, maxParams = 500, 30000
	if columns <= 0 {
		return maxRows
	}
	return max(1, min(maxRows, maxParams/columns))
}
