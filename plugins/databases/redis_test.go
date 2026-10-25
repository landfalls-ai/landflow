package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// Every Redis operation against miniredis.

func newRedis(t *testing.T) (*miniredis.Miniredis, map[string]any) {
	t.Helper()
	resetPools(t)
	mr := miniredis.RunT(t)
	return mr, map[string]any{"redis": map[string]any{"host": mr.Host(), "port": float64(mr.Server().Addr().Port), "database": 0.0}}
}

func redisCall(creds map[string]any, params map[string]any, items ...map[string]any) call {
	if len(items) == 0 {
		items = []map[string]any{{"in": "x"}}
	}
	return call{node: "redis", creds: creds, params: params, items: items}
}

func TestRedisSetGet(t *testing.T) {
	mr, creds := newRedis(t)

	// String with expiry; the item passes through.
	out := ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "greeting", "value": "hello", "expire": true, "ttl": 30.0}))
	if out[0].JSON["in"] != "x" || out[0].PairedItem.Item != 0 {
		t.Errorf("set output = %+v", out)
	}
	if v, _ := mr.Get("greeting"); v != "hello" || mr.TTL("greeting") != 30*time.Second {
		t.Errorf("stored %q ttl %v", v, mr.TTL("greeting"))
	}
	// Automatic: an object becomes a hash, an array a list.
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "user:1", "value": map[string]any{"name": "Ada", "age": 36.0}}))
	if mr.HGet("user:1", "name") != "Ada" || mr.HGet("user:1", "age") != "36" {
		t.Errorf("hash = %v", mr.HGet("user:1", "name"))
	}
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "queue", "value": []any{"a", "b", 3.0}}))
	if l, _ := mr.List("queue"); strings.Join(l, ",") != "a,b,3" {
		t.Errorf("list = %v", l)
	}
	// Explicit types: hash from JSON text and from "field value" pairs, list
	// replaced, sets added to, string from an object (JSON).
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "h", "keyType": "hash", "value": `{"a":"1"}`}))
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "h2", "keyType": "hash", "valueIsJSON": false, "value": "x 1 y 2"}))
	if mr.HGet("h", "a") != "1" || mr.HGet("h2", "y") != "2" {
		t.Error("hash from text")
	}
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "queue", "keyType": "list", "value": `["z"]`, "expire": true, "ttl": 5.0}))
	if l, _ := mr.List("queue"); strings.Join(l, ",") != "z" || mr.TTL("queue") != 5*time.Second {
		t.Errorf("replaced list = %v ttl %v", l, mr.TTL("queue"))
	}
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "tags", "keyType": "sets", "value": `["go","sql","go"]`}))
	if m, _ := mr.Members("tags"); strings.Join(m, ",") != "go,sql" {
		t.Errorf("set = %v", m)
	}
	ok(t, redisCall(creds, map[string]any{"operation": "set", "key": "doc", "keyType": "string", "value": map[string]any{"k": true}}))
	if v, _ := mr.Get("doc"); v != `{"k":true}` {
		t.Errorf("doc = %q", v)
	}
	if e := fails(t, redisCall(creds, map[string]any{"operation": "set", "key": "bad", "keyType": "hash", "value": "not json"})); !strings.Contains(e.Message, "JSON object") {
		t.Errorf("bad hash = %+v", e)
	}

	// Get, automatic type, with dot notation.
	get := func(key, keyType string) any {
		out := ok(t, redisCall(creds, map[string]any{"operation": "get", "key": key, "keyType": keyType, "propertyName": "result.value"}))
		return out[0].JSON["result"].(map[string]any)["value"]
	}
	if v := get("greeting", "automatic"); v != "hello" {
		t.Errorf("get string = %#v", v)
	}
	if v := get("user:1", "automatic").(map[string]any); v["name"] != "Ada" {
		t.Errorf("get hash = %#v", v)
	}
	if v := get("queue", "list").([]any); len(v) != 1 || v[0] != "z" {
		t.Errorf("get list = %#v", v)
	}
	if v := get("tags", "automatic").([]any); fmt.Sprint(v) != "[go sql]" {
		t.Errorf("get set = %#v", v)
	}
	if v := get("missing", "automatic"); v != nil {
		t.Errorf("get missing = %#v", v)
	}
	if v := get("missing", "string"); v != nil {
		t.Errorf("get missing string = %#v", v)
	}
	// Dot notation off: the property name is used literally.
	out = ok(t, redisCall(creds, map[string]any{"operation": "get", "key": "greeting", "propertyName": "a.b", "options": map[string]any{"dotNotation": false}}))
	if out[0].JSON["a.b"] != "hello" || out[0].JSON["in"] != "x" {
		t.Errorf("literal property = %+v", out[0].JSON)
	}
	// A sorted set is not readable by Get.
	mr.ZAdd("scores", 1, "a")
	if e := fails(t, redisCall(creds, map[string]any{"operation": "get", "key": "scores"})); !strings.Contains(e.Message, "zset") {
		t.Errorf("zset = %+v", e)
	}
}

func TestRedisContinueOnFail(t *testing.T) {
	mr, creds := newRedis(t)
	_ = mr.Set("greeting", "hello")
	get := map[string]any{"operation": "get", "key": "greeting", "propertyName": "value"}
	c := redisCall(creds, get, map[string]any{}, map[string]any{})
	c.itemParams = []map[string]any{{"operation": "get", "key": "greeting", "keyType": "bogus"}, get}
	if e := fails(t, c); e.ItemIndex == nil || *e.ItemIndex != 0 {
		t.Errorf("without continueOnFail: %+v", e)
	}
	c.continueOnFail = true
	out := ok(t, c)
	if len(out) != 2 || out[0].JSON["error"] == nil || out[0].PairedItem.Item != 0 || out[1].JSON["value"] != "hello" || out[1].PairedItem.Item != 1 {
		t.Errorf("continueOnFail outputs = %+v", out)
	}
}

func TestRedisDeleteIncrLists(t *testing.T) {
	mr, creds := newRedis(t)
	mr.Set("gone", "1")
	ok(t, redisCall(creds, map[string]any{"operation": "delete", "key": "gone"}))
	if mr.Exists("gone") {
		t.Error("key not deleted")
	}

	out := ok(t, redisCall(creds, map[string]any{"operation": "incr", "key": "hits", "expire": true, "ttl": 60.0}))
	out = ok(t, redisCall(creds, map[string]any{"operation": "incr", "key": "hits"}))
	if out[0].JSON["hits"] != int64(2) || mr.TTL("hits") != time.Minute {
		t.Errorf("incr = %+v ttl %v", out[0].JSON, mr.TTL("hits"))
	}

	// Push left and right, length, pop with JSON parsing.
	ok(t, redisCall(creds, map[string]any{"operation": "push", "list": "jobs", "messageData": `{"id":1}`}))
	ok(t, redisCall(creds, map[string]any{"operation": "push", "list": "jobs", "messageData": "second", "tail": true}))
	ok(t, redisCall(creds, map[string]any{"operation": "push", "list": "jobs", "messageData": "first"}))
	if l, _ := mr.List("jobs"); strings.Join(l, "|") != `first|{"id":1}|second` {
		t.Errorf("list = %v", l)
	}
	out = ok(t, redisCall(creds, map[string]any{"operation": "llen", "list": "jobs"}))
	if out[0].JSON["length"] != int64(3) {
		t.Errorf("llen = %+v", out[0].JSON)
	}
	out = ok(t, redisCall(creds, map[string]any{"operation": "pop", "list": "jobs", "tail": true, "propertyName": "job"}))
	if out[0].JSON["job"] != "second" {
		t.Errorf("rpop = %+v", out[0].JSON)
	}
	ok(t, redisCall(creds, map[string]any{"operation": "pop", "list": "jobs"}))
	out = ok(t, redisCall(creds, map[string]any{"operation": "pop", "list": "jobs", "propertyName": "job"}))
	if m, _ := out[0].JSON["job"].(map[string]any); m["id"] != 1.0 {
		t.Errorf("lpop JSON = %+v", out[0].JSON)
	}
	out = ok(t, redisCall(creds, map[string]any{"operation": "pop", "list": "jobs", "propertyName": "job"}))
	if v, present := out[0].JSON["job"]; !present || v != nil {
		t.Errorf("pop from empty list = %+v", out[0].JSON)
	}
}

func TestRedisKeysInfoPublish(t *testing.T) {
	mr, creds := newRedis(t)
	for i := range 30 {
		mr.Set(fmt.Sprintf("user:%02d", i), fmt.Sprint(i))
	}
	mr.HSet("user:hash", "f", "v")
	mr.Set("other", "x")

	// Keys with values (SCAN, all of them).
	out := ok(t, redisCall(creds, map[string]any{"operation": "keys", "keyPattern": "user:*", "returnAll": true}))
	if len(out[0].JSON) != 32 || out[0].JSON["user:07"] != "7" || out[0].JSON["in"] != "x" {
		t.Errorf("keys with values: %d fields", len(out[0].JSON))
	}
	if h, _ := out[0].JSON["user:hash"].(map[string]any); h["f"] != "v" {
		t.Errorf("hash value = %#v", out[0].JSON["user:hash"])
	}
	// Names only, limited.
	out = ok(t, redisCall(creds, map[string]any{"operation": "keys", "keyPattern": "user:*", "getValues": false, "limit": 5.0}))
	keys, _ := out[0].JSON["keys"].([]any)
	if len(keys) != 5 || !sort.SliceIsSorted(keys, func(i, j int) bool { return keys[i].(string) < keys[j].(string) }) {
		t.Errorf("limited keys = %v", keys)
	}
	if e := fails(t, redisCall(creds, map[string]any{"operation": "keys", "keyPattern": ""})); !strings.Contains(e.Message, "pattern") {
		t.Errorf("empty pattern = %+v", e)
	}

	// Info parsed into an object.
	out = ok(t, redisCall(creds, map[string]any{"operation": "info"}))
	if len(out[0].JSON) == 0 {
		t.Errorf("info = %+v", out[0].JSON)
	}

	// Publish reaches a subscriber.
	// (miniredis delivers synchronously, so read before publishing.)
	sub := mr.NewSubscriber()
	sub.Subscribe("events")
	got := make(chan miniredis.PubsubMessage, 1)
	go func() { got <- <-sub.Messages() }()
	ok(t, redisCall(creds, map[string]any{"operation": "publish", "channel": "events", "messageData": "ping"}))
	select {
	case m := <-got:
		if m.Channel != "events" || m.Message != "ping" {
			t.Errorf("message = %+v", m)
		}
	case <-time.After(2 * time.Second):
		t.Error("no message published")
	}
	sub.Close()
}

func TestParseInfo(t *testing.T) {
	info := parseInfo("# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:42\r\nmem_fragmentation_ratio:1.5\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\n")
	if info["redis_version"] != "7.2.4" || info["uptime_in_seconds"] != 42.0 || info["mem_fragmentation_ratio"] != 1.5 {
		t.Errorf("info = %#v", info)
	}
	if db0, _ := info["db0"].(map[string]any); db0["keys"] != 3.0 || db0["expires"] != 1.0 {
		t.Errorf("db0 = %#v", info["db0"])
	}
}

func TestRedisCredentialTest(t *testing.T) {
	mr, creds := newRedis(t)
	data := creds["redis"].(map[string]any)
	if ok, msg := testRedis(context.Background(), data); !ok {
		t.Errorf("test = %v %q", ok, msg)
	}
	mr.RequireUserAuth("bot", "right-password")
	data["user"], data["password"] = "bot", "wrong-password"
	ok, msg := testRedis(context.Background(), data)
	if ok || msg == "" || strings.Contains(msg, "wrong-password") {
		t.Errorf("bad password: %v %q", ok, msg)
	}
	data["password"] = "right-password"
	if ok, msg := testRedis(context.Background(), data); !ok {
		t.Errorf("ACL user: %v %q", ok, msg)
	}
	// Nothing listening.
	if ok, _ := testRedis(context.Background(), map[string]any{"host": "127.0.0.1", "port": 1.0}); ok {
		t.Error("closed port must fail")
	}
}

func TestKeyPrefix(t *testing.T) {
	for in, want := range map[string]string{"user:42": "user", "a:b:c": "a", "plain": "", ":x": ""} {
		if got := keyPrefix(in); got != want {
			t.Errorf("keyPrefix(%q) = %q", in, got)
		}
	}
}
