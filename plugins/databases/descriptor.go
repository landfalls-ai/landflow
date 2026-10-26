package main

import (
	landflow "github.com/landflow/landflow/sdks/go"
)

// Descriptor of the SQL nodes, shaped like n8n's Postgres and MySQL v2
// nodes: an operation picker, schema/table pickers loaded live with the
// credential, "Select Rows" conditions, sort, Return All / Limit, and
// automatic or manual column mapping.
//
// Column fields inside the collections are text fields rather than live
// pickers: the editor sends a collection entry's own values (not the node's
// table) with nested loadOptions requests, and does not load multiOptions.
// Every column name is checked against the table's real columns at run time.

var categories = []string{"Data & Storage", "Development"}

func show(key string, values ...any) map[string][]any { return map[string][]any{key: values} }

func (n sqlNode) Description() landflow.NodeDescriptor {
	d := n.d
	example := "SELECT id, name FROM orders WHERE status = ? AND total > ?"
	paramHelp := "?"
	if d.dollarParams {
		example = "SELECT id, name FROM orders WHERE status = $1 AND total > $2"
		paramHelp = "$1, $2, …"
	}
	tableOps := []any{"select", "insert", "upsert", "update", "deleteTable"}
	writeOps := []any{"insert", "upsert", "update"}
	columnHint := "A column of the table; checked against the table's columns when the node runs"

	props := []landflow.PropertyDescriptor{
		{
			Name: "operation", DisplayName: "Operation", Type: landflow.PropOptions, Default: "insert", NoDataExpression: true,
			Options: []landflow.PropertyOption{
				{Name: "Delete", Value: "deleteTable", Description: "Delete rows matching conditions", Action: "Delete rows in a table"},
				{Name: "Execute Query", Value: "executeQuery", Description: "Run an SQL query with bound parameters", Action: "Execute a SQL query"},
				{Name: "Insert", Value: "insert", Description: "Insert rows in a table", Action: "Insert rows in a table"},
				{Name: "Insert or Update", Value: "upsert", Description: "Insert rows, or update them when the key already exists", Action: "Insert or update rows in a table"},
				{Name: "Select", Value: "select", Description: "Select rows from a table", Action: "Select rows from a table", Idempotent: true},
				{Name: "Update", Value: "update", Description: "Update rows in a table", Action: "Update rows in a table"},
			},
		},
		{
			Name: "query", DisplayName: "Query", Type: landflow.PropString, Default: "", Required: true,
			Placeholder: example,
			Description: "The SQL to run. Put values in " + paramHelp + " placeholders and list them in Options → Query Parameters " +
				"instead of writing them into the SQL.",
			TypeOptions:    &landflow.TypeOptions{Rows: landflow.Ptr(6), Language: "sql"},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "executeQuery")},
		},
	}
	if d.hasSchemas {
		props = append(props, landflow.PropertyDescriptor{
			Name: "schema", DisplayName: "Schema", Type: landflow.PropOptions, Default: "public",
			Options:        []landflow.PropertyOption{{Name: "public", Value: "public"}},
			TypeOptions:    &landflow.TypeOptions{LoadOptionsMethod: "getSchemas"},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", tableOps...)},
		})
	}
	tableDeps := []string{}
	if d.hasSchemas {
		tableDeps = []string{"schema"}
	}
	props = append(props,
		landflow.PropertyDescriptor{
			Name: "table", DisplayName: "Table", Type: landflow.PropOptions, Default: "", Required: true,
			Description:    "The table to work on (loaded live with the credential)",
			TypeOptions:    &landflow.TypeOptions{LoadOptionsMethod: "getTables", LoadOptionsDependsOn: tableDeps},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", tableOps...)},
		},
		landflow.PropertyDescriptor{
			Name: "deleteAll", DisplayName: "Delete All Rows", Type: landflow.PropBoolean, Default: false,
			Description:    "Allow deleting without conditions. Off by default: a delete without conditions is refused.",
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "deleteTable")},
		},
		landflow.PropertyDescriptor{
			Name: "where", DisplayName: "Select Rows", Type: landflow.PropFixedCollection, Default: map[string]any{},
			Placeholder: "Add Condition",
			Description: "Conditions rows must meet. Values are always sent as bound parameters.",
			TypeOptions: &landflow.TypeOptions{MultipleValues: true},
			Groups: []landflow.FixedCollectionGroup{{Name: "values", DisplayName: "Values", Values: []landflow.PropertyDescriptor{
				{Name: "column", DisplayName: "Column", Type: landflow.PropString, Default: "", Placeholder: "id", Description: columnHint},
				{Name: "condition", DisplayName: "Operator", Type: landflow.PropOptions, Default: "equal", Options: []landflow.PropertyOption{
					{Name: "Equal", Value: "equal"},
					{Name: "Not Equal", Value: "!="},
					{Name: "Like", Value: "LIKE"},
					{Name: "Greater Than", Value: ">"},
					{Name: "Less Than", Value: "<"},
					{Name: "Greater Than Or Equal", Value: ">="},
					{Name: "Less Than Or Equal", Value: "<="},
					{Name: "Is Null", Value: "IS NULL"},
					{Name: "Is Not Null", Value: "IS NOT NULL"},
				}},
				{Name: "value", DisplayName: "Value", Type: landflow.PropString, Default: ""},
			}}},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "select", "deleteTable")},
		},
		landflow.PropertyDescriptor{
			Name: "combineConditions", DisplayName: "Combine Conditions", Type: landflow.PropOptions, Default: "AND",
			Options: []landflow.PropertyOption{
				{Name: "AND", Value: "AND", Description: "Only rows that meet all the conditions"},
				{Name: "OR", Value: "OR", Description: "Rows that meet at least one condition"},
			},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "select", "deleteTable")},
		},
		landflow.PropertyDescriptor{
			Name: "returnAll", DisplayName: "Return All", Type: landflow.PropBoolean, Default: false,
			Description:    "Whether to return all results or only up to a given limit",
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "select")},
		},
		landflow.PropertyDescriptor{
			Name: "limit", DisplayName: "Limit", Type: landflow.PropNumber, Default: 50,
			Description:    "Max number of rows to return",
			TypeOptions:    &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), NumberPrecision: landflow.Ptr(0)},
			DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": {"select"}, "returnAll": {false}}},
		},
		landflow.PropertyDescriptor{
			Name: "sort", DisplayName: "Sort", Type: landflow.PropFixedCollection, Default: map[string]any{},
			Placeholder: "Add Sort Rule",
			TypeOptions: &landflow.TypeOptions{MultipleValues: true},
			Groups: []landflow.FixedCollectionGroup{{Name: "values", DisplayName: "Values", Values: []landflow.PropertyDescriptor{
				{Name: "column", DisplayName: "Column", Type: landflow.PropString, Default: "", Placeholder: "created_at", Description: columnHint},
				{Name: "direction", DisplayName: "Direction", Type: landflow.PropOptions, Default: "ASC", Options: []landflow.PropertyOption{
					{Name: "ASC", Value: "ASC"}, {Name: "DESC", Value: "DESC"},
				}},
			}}},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "select")},
		},
		landflow.PropertyDescriptor{
			Name: "dataMode", DisplayName: "Mapping Column Mode", Type: landflow.PropOptions, Default: "autoMapInputData",
			Options: []landflow.PropertyOption{
				{Name: "Map Automatically", Value: "autoMapInputData", Description: "Use the item fields whose names match columns of the table; other fields are ignored"},
				{Name: "Map Each Column Manually", Value: "defineBelow", Description: "Set the value of each column below"},
			},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", writeOps...)},
		},
		landflow.PropertyDescriptor{
			Name: "valuesToSend", DisplayName: "Values to Send", Type: landflow.PropFixedCollection, Default: map[string]any{},
			Placeholder: "Add Value",
			TypeOptions: &landflow.TypeOptions{MultipleValues: true},
			Groups: []landflow.FixedCollectionGroup{{Name: "values", DisplayName: "Values", Values: []landflow.PropertyDescriptor{
				{Name: "column", DisplayName: "Column", Type: landflow.PropString, Default: "", Placeholder: "name", Description: columnHint},
				{Name: "value", DisplayName: "Value", Type: landflow.PropString, Default: ""},
			}}},
			DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": writeOps, "dataMode": {"defineBelow"}}},
		},
		landflow.PropertyDescriptor{
			Name: "columnsToMatchOn", DisplayName: "Columns to Match On", Type: landflow.PropString, Default: "", Required: true,
			Placeholder: "id",
			Description: "Comma-separated column(s) of a unique key. A row with the same values is updated instead of inserted." +
				mysqlUpsertNote(d),
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "upsert")},
		},
		landflow.PropertyDescriptor{
			Name: "columnToMatchOn", DisplayName: "Column to Match On", Type: landflow.PropOptions, Default: "", Required: true,
			Description:    "The column that identifies the rows to update (usually the primary key)",
			TypeOptions:    &landflow.TypeOptions{LoadOptionsMethod: "getColumns", LoadOptionsDependsOn: append(tableDeps, "table")},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "update")},
		},
		landflow.PropertyDescriptor{
			Name: "valueToMatchOn", DisplayName: "Value of Column to Match On", Type: landflow.PropString, Default: "",
			Description:    "Rows whose match column equals this value are updated",
			DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": {"update"}, "dataMode": {"defineBelow"}}},
		},
		landflow.PropertyDescriptor{
			Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{}, Placeholder: "Add option",
			Values: []landflow.PropertyDescriptor{
				{
					Name: "queryReplacement", DisplayName: "Query Parameters", Type: landflow.PropString, Default: "",
					Placeholder: "e.g. paid, 100",
					Description: "Values for the " + paramHelp + " placeholders: a comma-separated list, or an expression " +
						"returning an array such as {{ [$json.status, $json.total] }}",
				},
				{
					Name: "queryBatching", DisplayName: "Query Batching", Type: landflow.PropOptions, Default: "single",
					Description: "How to run the query for several input items",
					Options: []landflow.PropertyOption{
						{Name: "Single Query", Value: "single", Description: "Run the query once, with the first item's parameters"},
						{Name: "Independently", Value: "independently", Description: "Run the query once per item"},
						{Name: "Transaction", Value: "transaction", Description: "Run the query once per item, all in one transaction; any failure rolls back every item"},
					},
				},
			},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "executeQuery")},
		},
		landflow.PropertyDescriptor{
			Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{}, Placeholder: "Add option",
			Values: []landflow.PropertyDescriptor{
				{
					Name: "outputColumns", DisplayName: "Output Columns", Type: landflow.PropString, Default: "",
					Placeholder: "id, name, created_at",
					Description: "Comma-separated columns to return (all columns when empty)",
				},
			},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "select")},
		},
	)
	if d.returning {
		props = append(props, landflow.PropertyDescriptor{
			Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{}, Placeholder: "Add option",
			Values: []landflow.PropertyDescriptor{
				{
					Name: "returnRows", DisplayName: "Return Rows", Type: landflow.PropBoolean, Default: true,
					Description: "Output the rows as stored (RETURNING *), with generated ids and defaults. " +
						"Off: insert outputs the values written, update outputs {success, affectedRows}.",
				},
			},
			DisplayOptions: &landflow.DisplayOptions{Show: show("operation", writeOps...)},
		})
	}

	return landflow.NodeDescriptor{
		Name:             n.name,
		DisplayName:      n.displayName,
		Description:      "Query, insert, update, upsert and delete rows in " + n.product,
		Version:          landflow.V(1),
		Kind:             landflow.KindAction,
		Categories:       categories,
		Icon:             n.icon,
		Color:            n.color,
		Subtitle:         "{{operation}}",
		DocumentationURL: n.docURL,
		Keywords:         n.keywords,
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		Credentials:      []landflow.NodeCredentialRequirement{{Name: d.credential, Required: true}},

		UsableAsTool: true,
		ToolDescription: "Read or change data in a " + n.product + " database. Set `operation`: `select` reads rows of `table` " +
			"(up to `limit`), `executeQuery` runs the SQL in `query` (use " + paramHelp + " placeholders for values), " +
			"`insert` / `upsert` / `update` write the other arguments as columns of `table` (fields that are not columns are " +
			"ignored), and `deleteTable` deletes rows matching the node's configured conditions.",
		ToolInputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operation": map[string]any{"type": "string", "enum": []string{"select", "executeQuery", "insert", "upsert", "update", "deleteTable"}},
				"table":     map[string]any{"type": "string", "description": "Table name"},
				"query":     map[string]any{"type": "string", "description": "SQL for executeQuery"},
				"limit":     map[string]any{"type": "number", "description": "Max rows for select", "default": 50},
			},
			"required": []string{"operation"},
		},
		Properties: props,
	}
}

func mysqlUpsertNote(d *dialect) string {
	if d.system == systemMySQL {
		return " MySQL matches on any unique key of the table (ON DUPLICATE KEY UPDATE); these columns are left unchanged on update."
	}
	return ""
}
