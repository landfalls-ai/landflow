package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/landflow/landflow/sdks/go/mcpface"
	"github.com/landflow/landflow/sdks/go/transport"
)

// mcpTools lists the plugin's tools the way its MCP face does (tools/list), with each tool's idempotentHint.
func mcpTools(t *testing.T) map[string]bool {
	t.Helper()
	dispatch := func(context.Context, transport.Method, json.RawMessage, transport.DispatchContext) (any, error) {
		return nil, nil
	}
	face, err := mcpface.New(newPlugin().Manifest(), dispatch, mcpface.FaceOptions{Credentials: mcpface.Credentials{}})
	if err != nil {
		t.Fatal(err)
	}
	tools := map[string]bool{}
	for _, tool := range face.Tools() {
		hint := false
		if tool.Annotations != nil {
			hint = tool.Annotations.IdempotentHint
		}
		tools[tool.Name] = hint
	}
	return tools
}

func names(m map[string]bool, want bool) string {
	var out []string
	for name, v := range m {
		if v == want {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

const googleReads = "gmail_message_get,gmail_message_getAll,googleCalendar_event_changedSince,googleCalendar_event_get,googleCalendar_event_getAll,googleDirectory_user_get,googleDirectory_user_getAll,googleDocs_document_export,googleDocs_document_get," +
	"googleDrive_fileFolder_search,googleDrive_file_changesSince,googleDrive_file_download,googleDrive_file_export,googleDrive_file_getItem,googleSheets_sheet_read,googleSheets_spreadsheet_export"

// Reads and lookups are idempotent; every write, send and delete stays at most once.
func TestOnlyReadOperationsAreIdempotent(t *testing.T) {
	var got []string
	for _, n := range newPlugin().Manifest().Nodes {
		if n.Idempotent {
			t.Errorf("node %s must not be idempotent as a whole", n.Name)
		}
		for _, p := range n.Properties {
			if p.Name != "operation" {
				continue
			}
			for _, o := range p.Options {
				if o.Idempotent {
					got = append(got, n.Name+"."+o.Value.(string))
				}
			}
		}
	}
	sort.Strings(got)
	want := "googleCalendar.changedSince,googleDirectory.get,googleDirectory.getAll,googleDrive.changesSince,googleDrive.getItem,googleCalendar.get,googleCalendar.getAll,googleDocs.export,googleDocs.get,googleDrive.download,googleDrive.export,googleDrive.search,gmail.get,gmail.getAll,googleSheets.export,googleSheets.read"
	wantSorted := strings.Split(want, ",")
	sort.Strings(wantSorted)
	if strings.Join(got, ",") != strings.Join(wantSorted, ",") {
		t.Fatalf("idempotent operations: %v, want %v", got, wantSorted)
	}
}

func TestMCPToolsAreIdempotent(t *testing.T) {
	tools := mcpTools(t)
	if got := names(tools, true); got != googleReads {
		t.Fatalf("idempotent tools: %s", got)
	}
	for _, send := range []string{"gmail_message_send", "gmail_message_reply", "googleCalendar_event_delete", "googleDrive_file_deleteFile", "googleSheets_sheet_append"} {
		if hint, ok := tools[send]; !ok || hint {
			t.Errorf("%s: listed=%v idempotentHint=%v", send, ok, hint)
		}
	}
}
