package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Redis: go-redis with one pooled client per credential. Operations follow
// n8n's Redis node; Keys uses SCAN, never KEYS.

var redisCredential = landflow.CredentialType{
	Name:             "redis",
	DisplayName:      "Redis",
	Description:      "A Redis (or Valkey, KeyDB, Dragonfly) server",
	DocumentationURL: "https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/",
	Properties: []landflow.PropertyDescriptor{
		{Name: "host", DisplayName: "Host", Type: landflow.PropString, Default: "localhost", Required: true},
		{Name: "port", DisplayName: "Port", Type: landflow.PropNumber, Default: 6379},
		{Name: "user", DisplayName: "User", Type: landflow.PropString, Default: "",
			Description: "ACL user name (Redis 6+); leave empty for the default user"},
		{Name: "password", DisplayName: "Password", Type: landflow.PropString, Default: "",
			TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "database", DisplayName: "Database Number", Type: landflow.PropNumber, Default: 0,
			TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(0.0), NumberPrecision: landflow.Ptr(0)}},
		{Name: "tls", DisplayName: "TLS", Type: landflow.PropBoolean, Default: false, Description: "Connect over TLS"},
	},
	Test: testRedis,
}

func redisSettings(c landflow.CredentialData) []string {
	return settingsOf(c.String, "host", "port", "user", "password", "database", "tls")
}

func redisServer(c landflow.CredentialData) serverInfo {
	return serverInfo{address: c.StringOr("host", "localhost"), port: c.Int("port", 6379), namespace: strconv.Itoa(c.Int("database", 0))}
}

func redisOptions(c landflow.CredentialData) *redis.Options {
	host := c.StringOr("host", "localhost")
	opts := &redis.Options{
		Addr:            net.JoinHostPort(host, strconv.Itoa(c.Int("port", 6379))),
		Username:        c.String("user"),
		Password:        c.String("password"),
		DB:              c.Int("database", 0),
		Protocol:        2,
		DialTimeout:     10 * time.Second,
		ReadTimeout:     10 * time.Second,
		WriteTimeout:    10 * time.Second,
		PoolSize:        10,
		ConnMaxIdleTime: 5 * time.Minute,
		DisableIdentity: true,
		// No CLIENT MAINT_NOTIFICATIONS handshake: plain servers reject it.
		MaintNotificationsConfig: &maintnotifications.Config{Mode: maintnotifications.ModeDisabled},
	}
	if c.Bool("tls", false) {
		opts.TLSConfig = &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
	}
	return opts
}

func testRedis(ctx context.Context, data landflow.CredentialData) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	opts := redisOptions(data)
	opts.MaxRetries = -1 // report the first failure instead of retrying
	client := redis.NewClient(opts)
	defer client.Close()
	srv := redisServer(data)
	err := testSpan(ctx, landflow.DBSpanInfo{System: systemRedis, Operation: "PING", Statement: "PING",
		Namespace: srv.namespace, ServerAddress: srv.address, ServerPort: srv.port}, func(ctx context.Context) error {
		return client.Ping(ctx).Err()
	})
	if err != nil {
		return false, landflow.RedactString(ctx, err.Error())
	}
	return true, "Connection tested successfully"
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

type redisNode struct{}

func (redisNode) Description() landflow.NodeDescriptor {
	keyOps := []any{"delete", "get", "incr", "set"}
	keyTypes := []landflow.PropertyOption{
		{Name: "Automatic", Value: "automatic", Description: "Detect the type (Get) or infer it from the value (Set)"},
		{Name: "Hash", Value: "hash"},
		{Name: "List", Value: "list"},
		{Name: "Sets", Value: "sets"},
		{Name: "String", Value: "string"},
	}
	dotNotation := landflow.PropertyDescriptor{
		Name: "dotNotation", DisplayName: "Dot Notation", Type: landflow.PropBoolean, Default: true,
		Description: "Whether a property name like a.b sets the nested field b of a, instead of a field called “a.b”",
	}
	return landflow.NodeDescriptor{
		Name: "redis", DisplayName: "Redis", Description: "Get, set, increment, list, pop, push and publish data in Redis",
		Version: landflow.V(1), Kind: landflow.KindAction,
		Categories: categories, Icon: "file:icons/redis.svg", Color: "#DC382D",
		Subtitle:         "{{operation}}",
		DocumentationURL: "https://redis.io/docs/latest/commands/",
		Keywords:         []string{"redis", "valkey", "cache", "key-value", "queue", "pub/sub"},
		Inputs:           []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:          []landflow.PortDescriptor{landflow.MainPort()},
		Credentials:      []landflow.NodeCredentialRequirement{{Name: "redis", Required: true}},

		UsableAsTool: true,
		ToolDescription: "Read and write a Redis server. Set `operation`: `get` (value of `key`), `set` (`key` to `value`, " +
			"optional `expire` with `ttl` seconds), `incr`, `delete`, `keys` (keys matching `keyPattern`, with values), " +
			"`push`/`pop` on the list `list` (`messageData` to push), `llen`, `publish` (`messageData` on `channel`) or `info`.",
		ToolInputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operation":   map[string]any{"type": "string", "enum": []string{"get", "set", "incr", "delete", "keys", "push", "pop", "llen", "publish", "info"}},
				"key":         map[string]any{"type": "string"},
				"value":       map[string]any{"type": "string"},
				"keyPattern":  map[string]any{"type": "string", "description": "Glob pattern for keys, e.g. user:*"},
				"list":        map[string]any{"type": "string"},
				"channel":     map[string]any{"type": "string"},
				"messageData": map[string]any{"type": "string"},
				"expire":      map[string]any{"type": "boolean"},
				"ttl":         map[string]any{"type": "number", "description": "Seconds"},
			},
			"required": []string{"operation"},
		},

		Properties: []landflow.PropertyDescriptor{
			{
				Name: "operation", DisplayName: "Operation", Type: landflow.PropOptions, Default: "info", NoDataExpression: true,
				Options: []landflow.PropertyOption{
					{Name: "Delete", Value: "delete", Description: "Delete a key", Action: "Delete a key"},
					{Name: "Get", Value: "get", Description: "Get the value of a key", Action: "Get the value of a key", Idempotent: true},
					{Name: "Increment", Value: "incr", Description: "Atomically increment a key by 1", Action: "Atomically increment a key by 1"},
					{Name: "Info", Value: "info", Description: "Return information about the server", Action: "Return information about the server", Idempotent: true},
					{Name: "Keys", Value: "keys", Description: "Return keys matching a pattern", Action: "Return keys matching a pattern", Idempotent: true},
					{Name: "List Length", Value: "llen", Description: "Return the length of a list", Action: "Return the length of a list", Idempotent: true},
					{Name: "Pop", Value: "pop", Description: "Pop data from a list", Action: "Pop data from a list"},
					{Name: "Publish", Value: "publish", Description: "Publish a message to a channel", Action: "Publish a message to a channel"},
					{Name: "Push", Value: "push", Description: "Push data to a list", Action: "Push data to a list"},
					{Name: "Set", Value: "set", Description: "Set the value of a key", Action: "Set the value of a key"},
				},
			},
			{Name: "propertyName", DisplayName: "Name", Type: landflow.PropString, Default: "propertyName", Required: true,
				Description:    "Field of the output item that receives the value",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "get", "pop")}},
			{Name: "key", DisplayName: "Key", Type: landflow.PropString, Default: "", Required: true,
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", keyOps...)}},
			{Name: "keyType", DisplayName: "Key Type", Type: landflow.PropOptions, Default: "automatic", Options: keyTypes,
				Description:    "The type of the key's value",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "get", "set")}},
			{Name: "value", DisplayName: "Value", Type: landflow.PropString, Default: "",
				Description:    "The value to write. Hash: a JSON object; List and Sets: a JSON array (or one value).",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "set")}},
			{Name: "valueIsJSON", DisplayName: "Value Is JSON", Type: landflow.PropBoolean, Default: true,
				Description:    "Whether the hash value is a JSON object; otherwise “field value field value …”",
				DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": {"set"}, "keyType": {"hash"}}}},
			{Name: "expire", DisplayName: "Expire", Type: landflow.PropBoolean, Default: false,
				Description:    "Whether to set a timeout on the key",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "set", "incr")}},
			{Name: "ttl", DisplayName: "TTL", Type: landflow.PropNumber, Default: 60,
				Description:    "Seconds until the key expires",
				TypeOptions:    &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), NumberPrecision: landflow.Ptr(0)},
				DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": {"set", "incr"}, "expire": {true}}}},
			{Name: "keyPattern", DisplayName: "Key Pattern", Type: landflow.PropString, Default: "", Required: true,
				Placeholder: "user:*", Description: "Glob-style pattern (*, ?, [abc]) matched with SCAN",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "keys")}},
			{Name: "getValues", DisplayName: "Get Values", Type: landflow.PropBoolean, Default: true,
				Description:    "Whether to return the value of each key, or only the key names",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "keys")}},
			{Name: "returnAll", DisplayName: "Return All", Type: landflow.PropBoolean, Default: false,
				Description:    "Whether to return every matching key or only up to a given limit",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "keys")}},
			{Name: "limit", DisplayName: "Limit", Type: landflow.PropNumber, Default: 50,
				Description:    "Max number of keys to return",
				TypeOptions:    &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), NumberPrecision: landflow.Ptr(0)},
				DisplayOptions: &landflow.DisplayOptions{Show: map[string][]any{"operation": {"keys"}, "returnAll": {false}}}},
			{Name: "list", DisplayName: "List", Type: landflow.PropString, Default: "", Required: true,
				Description:    "Name of the list",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "llen", "pop", "push")}},
			{Name: "propertyName", DisplayName: "Name", Type: landflow.PropString, Default: "length", Required: true,
				Description:    "Field of the output item that receives the length",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "llen")}},
			{Name: "tail", DisplayName: "Tail", Type: landflow.PropBoolean, Default: false,
				Description:    "Whether to push or pop at the end (right) of the list instead of the start (left)",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "pop", "push")}},
			{Name: "channel", DisplayName: "Channel", Type: landflow.PropString, Default: "", Required: true,
				Description:    "Channel to publish the message to",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "publish")}},
			{Name: "messageData", DisplayName: "Data", Type: landflow.PropString, Default: "", Required: true,
				Description:    "Data to push or publish",
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "push", "publish")}},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{}, Placeholder: "Add option",
				Values:         []landflow.PropertyDescriptor{dotNotation},
				DisplayOptions: &landflow.DisplayOptions{Show: show("operation", "get", "pop")}},
		},
	}
}

// redisSession is one call's view of one Redis server.
type redisSession struct {
	rdb *redis.Client
	obs *observer
}

// do runs one command inside a DB span ("GET user", statement "GET ?").
func (r *redisSession) do(parent dbSpanner, op, key, statement string, fn func(span landflow.Span) (read, written int64, err error)) error {
	return r.obs.do(parent, op, keyPrefix(key), statement, fn)
}

// keyPrefix is the part of a key before the first ":" ("user:42" → "user"),
// which names the span without exposing ids. Keys without ":" give "".
func keyPrefix(key string) string {
	if i := strings.IndexByte(key, ':'); i > 0 {
		return key[:i]
	}
	return ""
}

func (redisNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials("redis")
	if err != nil {
		return nil, err
	}
	rdb, release, err := pools.redisClient(redisSettings(creds), func() *redis.Client { return redis.NewClient(redisOptions(creds)) })
	if err != nil {
		return nil, landflow.NewNodeError("Cannot connect: %s", landflow.RedactString(ctx, err.Error()))
	}
	r := &redisSession{rdb: rdb, obs: &observer{system: systemRedis, server: redisServer(creds), metrics: ctx.Metrics()}}
	defer func() {
		r.obs.recordPool(pools)
		release()
	}()

	op := ctx.ParamString("operation", 0, "info")
	var out []landflow.Item
	for i := range itemCount(ctx) {
		item, err := r.run(ctx, op, i, itemAt(ctx, i))
		if err != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, dbError(ctx, i, err)))
				continue
			}
			return nil, dbError(ctx, i, err)
		}
		item.PairedItem = &landflow.PairedItem{Item: i}
		out = append(out, item)
	}
	ctx.Logger.With("db.system", systemRedis, "items.out", len(out)).Info("%s: %d item(s)", op, len(out))
	return [][]landflow.Item{out}, nil
}

// run executes the operation for item i.
func (r *redisSession) run(ctx *landflow.ExecuteContext, op string, i int, item landflow.Item) (landflow.Item, error) {
	next := cloneJSON(item.JSON)
	dot := optionsOf(ctx, i).Bool("dotNotation", true)
	switch op {
	case "get":
		key := ctx.ParamString("key", i, "")
		value, err := r.getValue(ctx, key, ctx.ParamString("keyType", i, "automatic"))
		if err != nil {
			return item, err
		}
		setField(next, ctx.ParamString("propertyName", i, "propertyName"), value, dot)
	case "set":
		if err := r.set(ctx, i); err != nil {
			return item, err
		}
	case "delete":
		key := ctx.ParamString("key", i, "")
		err := r.do(ctx, "DEL", key, "DEL ?", func(span landflow.Span) (int64, int64, error) {
			n, err := r.rdb.Del(span, key).Result()
			return 0, n, err
		})
		if err != nil {
			return item, err
		}
	case "incr":
		key := ctx.ParamString("key", i, "")
		var value int64
		err := r.do(ctx, "INCR", key, "INCR ?", func(span landflow.Span) (int64, int64, error) {
			var err error
			value, err = r.rdb.Incr(span, key).Result()
			return 0, 1, err
		})
		if err != nil {
			return item, err
		}
		if ctx.ParamBool("expire", i, false) {
			if err := r.expire(ctx, key, ctx.ParamInt("ttl", i, 60)); err != nil {
				return item, err
			}
		}
		next[key] = value
	case "keys":
		return r.keys(ctx, i, next)
	case "info":
		var text string
		err := r.do(ctx, "INFO", "", "INFO", func(span landflow.Span) (int64, int64, error) {
			var err error
			text, err = r.rdb.Info(span).Result()
			return 1, 0, err
		})
		if err != nil {
			return item, err
		}
		return landflow.Item{JSON: parseInfo(text)}, nil
	case "llen":
		list := ctx.ParamString("list", i, "")
		var n int64
		err := r.do(ctx, "LLEN", list, "LLEN ?", func(span landflow.Span) (int64, int64, error) {
			var err error
			n, err = r.rdb.LLen(span, list).Result()
			return 1, 0, err
		})
		if err != nil {
			return item, err
		}
		setField(next, ctx.ParamString("propertyName", i, "length"), n, dot)
	case "pop":
		list := ctx.ParamString("list", i, "")
		cmd, pop := "LPOP", r.rdb.LPop
		if ctx.ParamBool("tail", i, false) {
			cmd, pop = "RPOP", r.rdb.RPop
		}
		var value any
		err := r.do(ctx, cmd, list, cmd+" ?", func(span landflow.Span) (int64, int64, error) {
			s, err := pop(span, list).Result()
			if errors.Is(err, redis.Nil) {
				return 0, 0, nil
			}
			if err != nil {
				return 0, 0, err
			}
			value = parseJSONText(s)
			return 1, 0, nil
		})
		if err != nil {
			return item, err
		}
		setField(next, ctx.ParamString("propertyName", i, "propertyName"), value, dot)
	case "push":
		list := ctx.ParamString("list", i, "")
		data := ctx.ParamString("messageData", i, "")
		cmd, push := "LPUSH", r.rdb.LPush
		if ctx.ParamBool("tail", i, false) {
			cmd, push = "RPUSH", r.rdb.RPush
		}
		err := r.do(ctx, cmd, list, cmd+" ? ?", func(span landflow.Span) (int64, int64, error) {
			return 0, 1, push(span, list, data).Err()
		})
		if err != nil {
			return item, err
		}
	case "publish":
		channel := ctx.ParamString("channel", i, "")
		data := ctx.ParamString("messageData", i, "")
		err := r.do(ctx, "PUBLISH", channel, "PUBLISH ? ?", func(span landflow.Span) (int64, int64, error) {
			return 0, 1, r.rdb.Publish(span, channel, data).Err()
		})
		if err != nil {
			return item, err
		}
	default:
		return item, landflow.NewNodeError("Unsupported operation %q", op)
	}
	return landflow.Item{JSON: next}, nil
}

// getValue reads a key according to its type (TYPE first when automatic).
func (r *redisSession) getValue(parent dbSpanner, key, keyType string) (any, error) {
	if keyType == "automatic" {
		var t string
		err := r.do(parent, "TYPE", key, "TYPE ?", func(span landflow.Span) (int64, int64, error) {
			var err error
			t, err = r.rdb.Type(span, key).Result()
			return 0, 0, err
		})
		if err != nil {
			return nil, err
		}
		switch t {
		case "none":
			return nil, nil
		case "set":
			keyType = "sets"
		case "string", "hash", "list":
			keyType = t
		default:
			return nil, fmt.Errorf("key %q holds a %s, which Get does not read (string, hash, list and set are supported)", key, t)
		}
	}
	var value any
	var err error
	switch keyType {
	case "string":
		err = r.do(parent, "GET", key, "GET ?", func(span landflow.Span) (int64, int64, error) {
			s, err := r.rdb.Get(span, key).Result()
			if errors.Is(err, redis.Nil) {
				return 0, 0, nil
			}
			value = s
			return 1, 0, err
		})
	case "hash":
		err = r.do(parent, "HGETALL", key, "HGETALL ?", func(span landflow.Span) (int64, int64, error) {
			m, err := r.rdb.HGetAll(span, key).Result()
			obj := make(map[string]any, len(m))
			for k, v := range m {
				obj[k] = v
			}
			value = obj
			return int64(len(m)), 0, err
		})
	case "list":
		err = r.do(parent, "LRANGE", key, "LRANGE ? 0 -1", func(span landflow.Span) (int64, int64, error) {
			l, err := r.rdb.LRange(span, key, 0, -1).Result()
			value = stringsToAny(l)
			return int64(len(l)), 0, err
		})
	case "sets":
		err = r.do(parent, "SMEMBERS", key, "SMEMBERS ?", func(span landflow.Span) (int64, int64, error) {
			l, err := r.rdb.SMembers(span, key).Result()
			sort.Strings(l)
			value = stringsToAny(l)
			return int64(len(l)), 0, err
		})
	default:
		return nil, fmt.Errorf("unsupported key type %q (use automatic, string, hash, list or sets)", keyType)
	}
	return value, err
}

// set writes item i's value with the chosen type, in one MULTI/EXEC when it
// takes several commands.
func (r *redisSession) set(ctx *landflow.ExecuteContext, i int) error {
	key := ctx.ParamString("key", i, "")
	value := ctx.Param("value", i)
	keyType := ctx.ParamString("keyType", i, "automatic")
	expire := ctx.ParamBool("expire", i, false)
	ttl := time.Duration(max(1, ctx.ParamInt("ttl", i, 60))) * time.Second
	if keyType == "automatic" {
		switch value.(type) {
		case map[string]any:
			keyType = "hash"
		case []any:
			keyType = "list"
		default:
			keyType = "string"
		}
	}
	switch keyType {
	case "string":
		var exp time.Duration
		statement := "SET ? ?"
		if expire {
			exp, statement = ttl, "SET ? ? EX ?"
		}
		return r.do(ctx, "SET", key, statement, func(span landflow.Span) (int64, int64, error) {
			return 0, 1, r.rdb.Set(span, key, redisString(value), exp).Err()
		})
	case "hash":
		fields, err := hashFields(value, ctx.ParamBool("valueIsJSON", i, true))
		if err != nil {
			return landflow.ItemError(i, "%s", err.Error())
		}
		return r.multi(ctx, "HSET", key, "HSET ? ?…", expire, ttl, func(p redis.Pipeliner) {
			p.HSet(ctx, key, fields...)
		})
	case "list":
		elems := listElements(value)
		return r.multi(ctx, "RPUSH", key, "DEL ?; RPUSH ? ?…", expire, ttl, func(p redis.Pipeliner) {
			p.Del(ctx, key)
			if len(elems) > 0 {
				p.RPush(ctx, key, elems...)
			}
		})
	case "sets":
		elems := listElements(value)
		return r.multi(ctx, "SADD", key, "SADD ? ?…", expire, ttl, func(p redis.Pipeliner) {
			if len(elems) > 0 {
				p.SAdd(ctx, key, elems...)
			}
		})
	}
	return landflow.ItemError(i, "Unsupported key type %q", keyType).WithDescription("Use automatic, string, hash, list or sets.")
}

// multi runs the queued commands (plus EXPIRE) in MULTI/EXEC in one span.
// It counts as one value written: the key, however many fields or elements.
func (r *redisSession) multi(ctx *landflow.ExecuteContext, op, key, statement string, expire bool, ttl time.Duration, queue func(p redis.Pipeliner)) error {
	if expire {
		statement += "; EXPIRE ? ?"
	}
	return r.do(ctx, op, key, "MULTI; "+statement+"; EXEC", func(span landflow.Span) (int64, int64, error) {
		_, err := r.rdb.TxPipelined(span, func(p redis.Pipeliner) error {
			queue(p)
			if expire {
				p.Expire(span, key, ttl)
			}
			return nil
		})
		return 0, 1, err
	})
}

func (r *redisSession) expire(parent dbSpanner, key string, ttl int) error {
	return r.do(parent, "EXPIRE", key, "EXPIRE ? ?", func(span landflow.Span) (int64, int64, error) {
		return 0, 0, r.rdb.Expire(span, key, time.Duration(max(1, ttl))*time.Second).Err()
	})
}

// keys lists keys matching the pattern with SCAN (never KEYS, which blocks
// the server), up to the limit unless Return All, optionally with values.
func (r *redisSession) keys(ctx *landflow.ExecuteContext, i int, next map[string]any) (landflow.Item, error) {
	pattern := ctx.ParamString("keyPattern", i, "")
	if pattern == "" {
		return landflow.Item{}, landflow.ItemError(i, "No key pattern").WithDescription("Set “Key Pattern”, e.g. user:* (or * for every key).")
	}
	returnAll := ctx.ParamBool("returnAll", i, false)
	limit := max(1, ctx.ParamInt("limit", i, 50))
	seen := map[string]bool{}
	var keys []string
	var cursor uint64
	for {
		var batch []string
		err := r.do(ctx, "SCAN", "", "SCAN ? MATCH ? COUNT ?", func(span landflow.Span) (int64, int64, error) {
			var err error
			batch, cursor, err = r.rdb.Scan(span, cursor, pattern, 100).Result()
			return int64(len(batch)), 0, err
		})
		if err != nil {
			return landflow.Item{}, err
		}
		for _, k := range batch {
			if !seen[k] { // SCAN may return a key twice
				seen[k] = true
				keys = append(keys, k)
			}
		}
		if cursor == 0 || (!returnAll && len(keys) >= limit) {
			break
		}
	}
	sort.Strings(keys)
	if !returnAll && len(keys) > limit {
		keys = keys[:limit]
	}
	if !ctx.ParamBool("getValues", i, true) {
		return landflow.Item{JSON: map[string]any{"keys": stringsToAny(keys)}}, nil
	}
	for _, k := range keys {
		v, err := r.getValue(ctx, k, "automatic")
		if err != nil {
			return landflow.Item{}, err
		}
		next[k] = v
	}
	return landflow.Item{JSON: next}, nil
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

// redisString renders a value for SET: strings as-is, the rest as JSON.
func redisString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		return ""
	}
	if _, ok := v.(map[string]any); !ok {
		if _, ok := v.([]any); !ok {
			return landflow.Stringify(v)
		}
	}
	data, _ := json.Marshal(v)
	return string(data)
}

// hashFields turns a JSON object (or "f v f v" text) into HSET arguments.
func hashFields(v any, valueIsJSON bool) ([]any, error) {
	obj, ok := v.(map[string]any)
	if s, isString := v.(string); isString {
		if valueIsJSON {
			if err := json.Unmarshal([]byte(s), &obj); err != nil || obj == nil {
				return nil, errors.New("the hash value must be a JSON object, e.g. {\"name\": \"Ada\"}")
			}
		} else {
			parts := strings.Fields(s)
			if len(parts) == 0 || len(parts)%2 != 0 {
				return nil, errors.New("the hash value must be “field value” pairs separated by spaces")
			}
			out := make([]any, len(parts))
			for i, p := range parts {
				out[i] = p
			}
			return out, nil
		}
	} else if !ok {
		return nil, errors.New("the hash value must be an object")
	}
	if len(obj) == 0 {
		return nil, errors.New("the hash value has no fields")
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]any, 0, 2*len(obj))
	for _, k := range keys {
		out = append(out, k, redisString(obj[k]))
	}
	return out, nil
}

// listElements turns an array (or a JSON array string, or one value) into
// list/set members.
func listElements(v any) []any {
	arr, ok := v.([]any)
	if s, isString := v.(string); isString && strings.HasPrefix(strings.TrimSpace(s), "[") {
		ok = json.Unmarshal([]byte(s), &arr) == nil
	}
	if !ok {
		if v == nil || v == "" {
			return nil
		}
		arr = []any{v}
	}
	out := make([]any, len(arr))
	for i, e := range arr {
		out[i] = redisString(e)
	}
	return out
}

func stringsToAny(l []string) []any {
	out := make([]any, len(l))
	for i, s := range l {
		out[i] = s
	}
	return out
}

var infoNumber = regexp.MustCompile(`^\d+(\.\d+)?$`)

// parseInfo turns INFO output into an object, as n8n does: "key:value"
// lines, "a=1,b=2" values as nested objects, numbers as numbers.
func parseInfo(text string) map[string]any {
	parsed := func(s string) any {
		if infoNumber.MatchString(s) {
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				return f
			}
		}
		return s
	}
	out := map[string]any{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.Contains(value, "=") {
			nested := map[string]any{}
			for _, pair := range strings.Split(value, ",") {
				k, v, _ := strings.Cut(pair, "=")
				nested[k] = parsed(v)
			}
			out[key] = nested
			continue
		}
		out[key] = parsed(value)
	}
	return out
}

// setField sets name on obj; with dot notation "a.b" sets obj.a.b.
func setField(obj map[string]any, name string, v any, dot bool) {
	if !dot || !strings.Contains(name, ".") {
		obj[name] = v
		return
	}
	parts := strings.Split(name, ".")
	cur := obj
	for _, p := range parts[:len(parts)-1] {
		child, ok := cur[p].(map[string]any)
		if !ok {
			child = map[string]any{}
		} else {
			child = cloneJSON(child)
		}
		cur[p] = child
		cur = child
	}
	cur[parts[len(parts)-1]] = v
}

// cloneJSON returns a shallow copy so nodes never mutate their input items.
func cloneJSON(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	return out
}
