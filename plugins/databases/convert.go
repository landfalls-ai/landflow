package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Result conversion: driver values → JSON-friendly values. The rules are the
// same for every database:
//
//   - times → RFC 3339 strings (with fractional seconds when present);
//   - DECIMAL / NUMERIC → strings, so no precision is lost;
//   - integers and floats → numbers, except integers outside ±2^53 (which a
//     JavaScript host cannot represent) and NaN/Inf → strings;
//   - JSON / JSONB → the parsed value;
//   - binary (bytea, BLOB, BINARY…) → base64 strings;
//   - other text → strings.

const maxSafeInteger = 1<<53 - 1

// scanRows reads every row into a JSON-friendly map. skip names columns to
// leave out (the trigger's cursor column).
func scanRows(rows *sql.Rows, system string, skip ...string) ([]map[string]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	types := make([]string, len(cols))
	if cts, err := rows.ColumnTypes(); err == nil {
		for i, ct := range cts {
			types[i] = strings.ToUpper(ct.DatabaseTypeName())
		}
	}
	var out []map[string]any
	values := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range values {
		ptrs[i] = &values[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			if contains(skip, c) {
				continue
			}
			row[c] = convertValue(values[i], types[i], system)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// convertValue applies the rules above to one value of a column whose
// database type name is dbType (upper case, may be empty).
func convertValue(v any, dbType, system string) any {
	kind := typeKind(dbType)
	switch t := v.(type) {
	case nil:
		return nil
	case time.Time:
		return t.Format(time.RFC3339Nano)
	case []byte:
		switch {
		case kind == kindJSON:
			return parseJSONText(string(t))
		case kind == kindBinary || (system == systemSQLite && kind != kindDecimal):
			// SQLite only hands out []byte for BLOB values.
			return base64.StdEncoding.EncodeToString(t)
		case kind == kindInt:
			if i, err := strconv.ParseInt(string(t), 10, 64); err == nil {
				return safeInt(i)
			}
			if u, err := strconv.ParseUint(string(t), 10, 64); err == nil {
				return safeUint(u)
			}
		case kind == kindFloat:
			if f, err := strconv.ParseFloat(string(t), 64); err == nil {
				return safeFloat(f)
			}
		}
		return string(t)
	case string:
		if kind == kindJSON {
			return parseJSONText(t)
		}
		return t
	case int64:
		if kind == kindDecimal {
			return strconv.FormatInt(t, 10)
		}
		return safeInt(t)
	case int32:
		return int64(t)
	case int:
		return safeInt(int64(t))
	case uint64:
		return safeUint(t)
	case float64:
		if kind == kindDecimal {
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
		return safeFloat(t)
	case float32:
		return safeFloat(float64(t))
	case bool:
		return t
	case fmt.Stringer:
		return t.String()
	}
	return fmt.Sprint(v)
}

type valueKind int

const (
	kindOther valueKind = iota
	kindJSON
	kindBinary
	kindDecimal
	kindInt
	kindFloat
)

// typeKind classifies a database type name (pgx: INT4, NUMERIC, BYTEA…;
// MySQL: INT, UNSIGNED BIGINT, DECIMAL, BLOB…; SQLite: the declared type).
func typeKind(dbType string) valueKind {
	t := strings.TrimPrefix(dbType, "UNSIGNED ")
	if i := strings.IndexByte(t, '('); i >= 0 {
		t = strings.TrimSpace(t[:i])
	}
	switch t {
	case "JSON", "JSONB":
		return kindJSON
	case "BYTEA", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "BINARY", "VARBINARY", "BIT", "GEOMETRY":
		return kindBinary
	case "NUMERIC", "DECIMAL":
		return kindDecimal
	case "INT", "INT2", "INT4", "INT8", "INTEGER", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT", "YEAR":
		return kindInt
	case "FLOAT", "FLOAT4", "FLOAT8", "DOUBLE", "REAL", "DOUBLE PRECISION":
		return kindFloat
	}
	return kindOther
}

func safeInt(i int64) any {
	if i > maxSafeInteger || i < -maxSafeInteger {
		return strconv.FormatInt(i, 10)
	}
	return i
}

func safeUint(u uint64) any {
	if u > maxSafeInteger {
		return strconv.FormatUint(u, 10)
	}
	return int64(u)
}

func safeFloat(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return f
}

func parseJSONText(s string) any {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return s
	}
	return v
}

// ---------------------------------------------------------------------------
// Execute Query helpers
// ---------------------------------------------------------------------------

// rowKeywords start statements that return a result set.
var rowKeywords = map[string]bool{
	"SELECT": true, "WITH": true, "SHOW": true, "VALUES": true, "EXPLAIN": true,
	"PRAGMA": true, "DESCRIBE": true, "DESC": true, "TABLE": true,
}

// knownVerbs bounds the `operation` metric attribute for Execute Query.
var knownVerbs = map[string]bool{
	"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true, "WITH": true, "MERGE": true,
	"CREATE": true, "ALTER": true, "DROP": true, "TRUNCATE": true, "SHOW": true, "EXPLAIN": true,
	"PRAGMA": true, "VALUES": true, "CALL": true, "REPLACE": true, "GRANT": true, "REVOKE": true,
	"BEGIN": true, "COMMIT": true, "ROLLBACK": true, "SET": true, "DESCRIBE": true, "VACUUM": true,
}

// statementVerb returns the first keyword of a statement, upper-cased,
// skipping whitespace, comments and opening parentheses ("" when none).
func statementVerb(query string) string {
	s := query
	for {
		s = strings.TrimLeftFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == '(' })
		switch {
		case strings.HasPrefix(s, "--"):
			if i := strings.IndexByte(s, '\n'); i >= 0 {
				s = s[i+1:]
				continue
			}
			return ""
		case strings.HasPrefix(s, "/*"):
			if i := strings.Index(s, "*/"); i >= 0 {
				s = s[i+2:]
				continue
			}
			return ""
		}
		break
	}
	end := strings.IndexFunc(s, func(r rune) bool { return !unicode.IsLetter(r) })
	if end < 0 {
		end = len(s)
	}
	return strings.ToUpper(s[:end])
}

// operationName is the verb as a low-cardinality db.operation.name.
func operationName(query string) string {
	if v := statementVerb(query); knownVerbs[v] {
		return v
	}
	return "OTHER"
}

// returnsRows guesses whether a statement yields a result set: it starts
// with SELECT, WITH, SHOW… or has a RETURNING clause.
func returnsRows(query string) bool {
	if rowKeywords[statementVerb(query)] {
		return true
	}
	return containsWord(strings.ToUpper(sanitizeStatement(query, false)), "RETURNING")
}

func containsWord(s, word string) bool {
	for i := 0; ; {
		j := strings.Index(s[i:], word)
		if j < 0 {
			return false
		}
		start, end := i+j, i+j+len(word)
		before := start == 0 || !isIdentChar(rune(s[start-1]))
		after := end == len(s) || !isIdentChar(rune(s[end]))
		if before && after {
			return true
		}
		i = end
	}
}

func isIdentChar(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) }

// sanitizeStatement replaces literal values in a user-written statement with
// ? so it can go into db.query.text: string literals ('…', $tag$…$tag$, and
// "…" when doubleQuotedStrings, as in MySQL) and numbers. Comments are
// dropped; identifiers, keywords and $1/? placeholders are kept.
func sanitizeStatement(query string, doubleQuotedStrings bool) string {
	var b strings.Builder
	rs := []rune(query)
	n := len(rs)
	for i := 0; i < n; i++ {
		r := rs[i]
		switch {
		case r == '-' && i+1 < n && rs[i+1] == '-':
			for i < n && rs[i] != '\n' {
				i++
			}
			b.WriteRune(' ')
		case r == '/' && i+1 < n && rs[i+1] == '*':
			i += 2
			for i+1 < n && !(rs[i] == '*' && rs[i+1] == '/') {
				i++
			}
			i++
			b.WriteRune(' ')
		case r == '\'' || (r == '"' && doubleQuotedStrings):
			i = skipQuoted(rs, i, r)
			b.WriteRune('?')
		case r == '"' || r == '`':
			end := skipQuoted(rs, i, r)
			b.WriteString(string(rs[i : end+1]))
			i = end
		case r == '$' && i+1 < n && unicode.IsDigit(rs[i+1]):
			b.WriteRune('$')
			for i+1 < n && unicode.IsDigit(rs[i+1]) {
				i++
				b.WriteRune(rs[i])
			}
		case r == '$':
			if end, ok := skipDollarQuoted(rs, i); ok {
				b.WriteRune('?')
				i = end
			} else {
				b.WriteRune(r)
			}
		case unicode.IsDigit(r) && (i == 0 || !isIdentChar(rs[i-1])):
			for i+1 < n && (unicode.IsDigit(rs[i+1]) || rs[i+1] == '.' || rs[i+1] == 'e' || rs[i+1] == 'E') {
				i++
			}
			b.WriteRune('?')
		case r == '.' && i+1 < n && unicode.IsDigit(rs[i+1]) && (i == 0 || !isIdentChar(rs[i-1])):
			for i+1 < n && unicode.IsDigit(rs[i+1]) {
				i++
			}
			b.WriteRune('?')
		default:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// skipQuoted returns the index of the closing quote of the literal that
// opens at i (a doubled quote or a backslash escapes it).
func skipQuoted(rs []rune, i int, q rune) int {
	for j := i + 1; j < len(rs); j++ {
		switch rs[j] {
		case '\\':
			if q != '"' && q != '`' {
				j++
			}
		case q:
			if j+1 < len(rs) && rs[j+1] == q {
				j++
				continue
			}
			return j
		}
	}
	return len(rs) - 1
}

// skipDollarQuoted handles Postgres $tag$…$tag$ strings.
func skipDollarQuoted(rs []rune, i int) (int, bool) {
	j := i + 1
	for j < len(rs) && (rs[j] == '_' || unicode.IsLetter(rs[j]) || (j > i+1 && unicode.IsDigit(rs[j]))) {
		j++
	}
	if j >= len(rs) || rs[j] != '$' {
		return i, false
	}
	tag := string(rs[i : j+1])
	rest := string(rs[j+1:])
	k := strings.Index(rest, tag)
	if k < 0 {
		return len(rs) - 1, true
	}
	return j + len([]rune(rest[:k])) + len([]rune(tag)), true
}

// parseQueryParameters turns the "Query Parameters" value into bind values:
// an array (from an expression) is used as is; a string is a JSON array or a
// comma-separated list ("a, b" or "\"a, with comma\", b").
func parseQueryParameters(v any) []any {
	switch t := v.(type) {
	case nil:
		return nil
	case []any:
		return t
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return nil
		}
		if strings.HasPrefix(s, "[") {
			var arr []any
			if err := json.Unmarshal([]byte(s), &arr); err == nil {
				return arr
			}
		}
		return splitCSV(s)
	}
	return []any{v}
}

func splitCSV(s string) []any {
	var out []any
	var cur strings.Builder
	quoted, inQuotes := false, false
	flush := func() {
		val := cur.String()
		if !quoted {
			val = strings.TrimSpace(val)
		}
		out = append(out, val)
		cur.Reset()
		quoted = false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' && inQuotes && i+1 < len(s) && s[i+1] == '"':
			cur.WriteByte('"')
			i++
		case c == '"' && (inQuotes || strings.TrimSpace(cur.String()) == ""):
			if !inQuotes {
				cur.Reset()
			}
			inQuotes = !inQuotes
			quoted = true
		case c == ',' && !inQuotes:
			flush()
		default:
			if quoted && !inQuotes && c == ' ' {
				continue // spaces after a closing quote
			}
			cur.WriteByte(c)
		}
	}
	flush()
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
