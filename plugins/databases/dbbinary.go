package main

import (
	"encoding/base64"
	"net/http"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Binary data in the SQL nodes: bytea / BLOB / BINARY columns read from and
// written to the items' binary files (docs/protocol.md §11).
//
//   - "Columns From Binary Files" (insert, upsert, update): column=property
//     pairs; the column gets the bytes of that binary property of the item.
//   - "Columns to Return as Files" (select, execute query, rows returned by
//     writes): column=property pairs; the column's bytes leave the JSON and
//     become a binary file on the output item.

// binaryOptionsOf returns the "Binary Data" collection of item i.
func binaryOptionsOf(ctx *landflow.ExecuteContext, i int) landflow.CredentialData {
	if m, ok := ctx.Param("binaryOptions", i).(map[string]any); ok {
		return m
	}
	return landflow.CredentialData{}
}

type binaryColumn struct{ column, property string }

// parseBinaryColumns reads "avatar=photo, doc" (a bare name uses the column
// name as the binary property).
func parseBinaryColumns(v any) []binaryColumn {
	var out []binaryColumn
	for _, entry := range nameList(v) {
		col, prop, found := strings.Cut(entry, "=")
		col, prop = strings.TrimSpace(col), strings.TrimSpace(prop)
		if !found || prop == "" {
			prop = col
		}
		if col != "" {
			out = append(out, binaryColumn{col, prop})
		}
	}
	return out
}

// applyBinaryInputs puts the bytes of the item's binary files into values.
func applyBinaryInputs(ctx *landflow.ExecuteContext, i int, t table, values map[string]any) error {
	for _, bc := range parseBinaryColumns(binaryOptionsOf(ctx, i)["inputColumns"]) {
		col, err := t.column(i, bc.column, "Binary column")
		if err != nil {
			return err
		}
		data, err := ctx.BinaryBytes(i, bc.property)
		if err != nil {
			return landflow.ItemError(i, "Column %q: %v", col, err).
				WithDescription("“Columns From Binary Files” maps columns to binary properties of the input item; check the previous node's Binary output.")
		}
		values[col] = data
	}
	return nil
}

// withoutBytes copies m without the binary values (they must not reach the item's JSON).
func withoutBytes(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if _, isBytes := v.([]byte); !isBytes {
			out[k] = v
		}
	}
	return out
}

// files turns rows into items paired with input item i, moving the columns
// named by "Columns to Return as Files" into binary files.
func (s *session) files(ctx *landflow.ExecuteContext, rows []map[string]any, i int) ([]landflow.Item, error) {
	items := paired(rows, i)
	specs := parseBinaryColumns(binaryOptionsOf(ctx, i)["outputColumns"])
	if len(specs) == 0 {
		return items, nil
	}
	fileNameColumn := strings.TrimSpace(binaryOptionsOf(ctx, i).StringOr("fileNameColumn", ""))
	for k, row := range rows {
		for _, bc := range specs {
			key, ok := lookupKey(row, bc.column)
			if !ok {
				return nil, landflow.ItemError(i, "The query returned no column %q", bc.column).
					WithDescription("“Columns to Return as Files” names columns of the result: " + strings.Join(mapKeys(row), ", "))
			}
			v := row[key]
			if v == nil {
				continue
			}
			data := bytesOf(v)
			fileName := bc.property
			if fileNameColumn != "" {
				if nk, ok := lookupKey(row, fileNameColumn); ok && row[nk] != nil {
					fileName = landflow.Stringify(row[nk])
				}
			}
			mimeType := ""
			if landflow.MimeTypeFromFileName(fileName) == landflow.DefaultMimeType {
				mimeType = http.DetectContentType(data)
			}
			ref, err := ctx.PrepareBinary(data, fileName, mimeType)
			if err != nil {
				return nil, landflow.ItemError(i, "Column %q: %v", key, err)
			}
			if items[k].Binary == nil {
				items[k].Binary = map[string]landflow.BinaryRef{}
			}
			items[k].Binary[bc.property] = ref
			delete(row, key)
		}
	}
	return items, nil
}

// bytesOf returns a column's bytes: the driver's binary values arrive as
// base64 strings (convertValue); anything else is used as text.
func bytesOf(v any) []byte {
	if b, ok := v.([]byte); ok {
		return b
	}
	s := landflow.Stringify(v)
	if raw, err := base64.StdEncoding.DecodeString(s); err == nil {
		return raw
	}
	return []byte(s)
}

// lookupKey finds a row key by name, ignoring case.
func lookupKey(row map[string]any, name string) (string, bool) {
	if _, ok := row[name]; ok {
		return name, true
	}
	for k := range row {
		if strings.EqualFold(k, name) {
			return k, true
		}
	}
	return "", false
}

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
