// Package valkey is the Valkey / Redis Streams driver of sdks/go/transport
// (docs/transports.md "Brokers", docs/protocol.md §14.9), built on
// github.com/valkey-io/valkey-go. It is wire-compatible with the TypeScript
// driver (@landflow/transports/valkey):
//
//   - A channel is a stream (`<keyPrefix><channel>`); an entry's fields carry
//     the CloudEvents headers (`h:<name>`) and the body (`b`), so the core runs
//     in binary mode and stream tooling can read the attributes.
//   - Shared channels use a consumer group per ConsumeOptions.Group, created at
//     `0` (events published before the first consumer wait for it): XREADGROUP
//     with COUNT = free prefetch slots, XACK on ack. Pending entries of a
//     consumer that died are reclaimed with XAUTOCLAIM after Config.ClaimIdle;
//     in-flight entries send a keep-alive (XCLAIM JUSTID by their owner) so a
//     slow call is not stolen. A nack with requeue and a closing consumer hand
//     their entries to the parking consumer `_orphans` with their idle time
//     already past ClaimIdle, so a survivor reclaims them on its next loop; the
//     delivery count from XPENDING is the attempt.
//   - Broadcast channels (reply, registry, control) are read with XREAD from
//     the id current at subscribe time.
//   - Streams are trimmed on every XADD: `MINID ~ now - ttl` for channels
//     declared with a TTL, else `MAXLEN ~ Config.MaxLen`.
//   - Stats: XINFO GROUPS lag as depth, live consumers (idle below a threshold,
//     the parking consumer excluded) as consumers.
//
// This package is its own Go module so sdks/go stays free of valkey-go. Code
// use: valkey.New(valkey.Config{URL: "redis://127.0.0.1:56379"}); env use:
// blank-import the package and set LANDFLOW_VALKEY_URL (plus
// LANDFLOW_VALKEY_USERNAME / _PASSWORD, _TLS=true, _PREFIX, _KEYPREFIX).
package valkey

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	valkeygo "github.com/valkey-io/valkey-go"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "valkey"

// Entry field layout shared with the TS driver.
const (
	headerField = "h:"
	bodyField   = "b"
	// OrphansConsumer owns requeued entries until a live consumer reclaims them.
	OrphansConsumer = "_orphans"
)

// Config configures a Valkey driver.
type Config struct {
	transport.Config
	// URL is a redis:// or rediss:// URL ("redis://127.0.0.1:56379/0").
	URL string
	// TLS, when set, is used for rediss:// URLs.
	TLS *tls.Config
	// Username / Password fill a URL without credentials.
	Username, Password string
	// KeyPrefix is prepended to every stream key (default none; channel names already carry the channel prefix).
	KeyPrefix string
	// MaxLen is the approximate maximum length of streams declared without a TTL (default 10000).
	MaxLen int64
	// ClaimIdle is how long a delivery may stay unacknowledged (keep-alives
	// aside) before another consumer reclaims it (XAUTOCLAIM min-idle; default 30 s).
	ClaimIdle time.Duration
	// Block is the XREADGROUP / XREAD block time (default 1 s; also the claim pass interval).
	Block time.Duration
	// MaxMessageBytes the driver accepts (default 1 MiB).
	MaxMessageBytes int
}

// Driver is one Valkey connection (valkey-go multiplexes it).
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu     sync.Mutex
	client valkeygo.Client
	closed bool
	ttls   map[string]time.Duration // channels declared with a TTL (MINID trimming)
	subs   map[*subscription]struct{}
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.URL == "" {
		cfg.URL = "redis://127.0.0.1:6379"
	}
	if cfg.MaxLen <= 0 {
		cfg.MaxLen = 10_000
	}
	if cfg.ClaimIdle <= 0 {
		cfg.ClaimIdle = 30 * time.Second
	}
	if cfg.Block <= 0 {
		cfg.Block = time.Second
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = 1 << 20
	}
	if cfg.Prefix == "" {
		cfg.Prefix = transport.DefaultPrefix
	}
	return &Driver{
		cfg: cfg,
		caps: transport.Capabilities{
			Replies:         transport.RepliesChannel,
			WorkSharing:     true,
			Buffering:       true,
			TTL:             false,
			Undeliverable:   transport.UndeliverableInferred,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyLow,
			Headers:         true,
			OrderingKeys:    false,
			Nack:            true,
			Attempts:        true,
		},
		ttls: map[string]time.Duration{}, subs: map[*subscription]struct{}{},
	}
}

func init() {
	transport.RegisterDriver(Kind, func(connectionID, rawURL string, opts transport.ConnectionOptions) (transport.Driver, error) {
		cfg, err := ConfigFromURL(connectionID, rawURL, opts)
		if err != nil {
			return nil, err
		}
		return New(cfg), nil
	})
}

// ConfigFromURL builds a Config from a redis:// / rediss:// / valkey:// URL
// and the connection options (field keyprefix).
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	raw := strings.TrimSpace(rawURL)
	lower := strings.ToLower(raw)
	switch {
	case strings.HasPrefix(lower, "valkey://"):
		raw = "redis://" + raw[len("valkey://"):]
	case strings.HasPrefix(lower, "valkeys://"):
		raw = "rediss://" + raw[len("valkeys://"):]
	case strings.HasPrefix(lower, "redis://"), strings.HasPrefix(lower, "rediss://"), strings.HasPrefix(lower, "unix://"):
	default:
		return Config{}, fmt.Errorf("valkey: malformed URL %q (want redis://host:port[/db])", rawURL)
	}
	if _, err := valkeygo.ParseURL(raw); err != nil {
		return Config{}, fmt.Errorf("valkey: malformed URL %q: %w", rawURL, err)
	}
	cfg := Config{
		Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}, URL: raw,
		Username: opts.Username, Password: opts.Password, KeyPrefix: opts.Fields["keyprefix"],
	}
	if opts.TLS {
		cfg.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return cfg, nil
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// ValkeyConfig returns the full driver configuration.
func (d *Driver) ValkeyConfig() Config { return d.cfg }

// Key is the stream key of a channel.
func (d *Driver) Key(channel string) string { return d.cfg.KeyPrefix + channel }

// Connect implements transport.Driver (it pings the server).
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("valkey: driver closed: %w", transport.ErrNotConnected)
	}
	if d.client != nil {
		return nil
	}
	opt, err := valkeygo.ParseURL(d.cfg.URL)
	if err != nil {
		return fmt.Errorf("valkey: %w", err)
	}
	if d.cfg.Username != "" && opt.Username == "" {
		opt.Username = d.cfg.Username
	}
	if d.cfg.Password != "" && opt.Password == "" {
		opt.Password = d.cfg.Password
	}
	if d.cfg.TLS != nil {
		opt.TLSConfig = d.cfg.TLS
	}
	opt.DisableCache = true
	opt.ClientName = "landflow"
	if deadline, ok := ctx.Deadline(); ok {
		opt.Dialer.Timeout = time.Until(deadline)
	}
	client, err := valkeygo.NewClient(opt)
	if err != nil {
		return fmt.Errorf("valkey: connect %s: %w", d.cfg.URL, err)
	}
	if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
		client.Close()
		return fmt.Errorf("valkey: ping %s: %w", d.cfg.URL, err)
	}
	d.client = client
	return nil
}

func (d *Driver) conn() (valkeygo.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client == nil {
		return nil, fmt.Errorf("valkey: %w", transport.ErrNotConnected)
	}
	return d.client, nil
}

// Declare implements transport.Driver: a shared channel gets its consumer group
// (named after the channel, as the core does) created at 0 with MKSTREAM, so
// events published before any consumer attaches wait for it; a TTL is remembered
// for MINID trimming.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	for _, spec := range channels {
		d.mu.Lock()
		if spec.TTL > 0 {
			d.ttls[spec.Name] = spec.TTL
		} else {
			delete(d.ttls, spec.Name)
		}
		d.mu.Unlock()
		if spec.Delivery != transport.DeliveryShared {
			continue
		}
		if err := d.ensureGroup(ctx, client, d.Key(spec.Name), spec.Name); err != nil {
			return err
		}
	}
	return nil
}

func (d *Driver) ensureGroup(ctx context.Context, client valkeygo.Client, key, group string) error {
	err := client.Do(ctx, client.B().XgroupCreate().Key(key).Group(group).Id("0").Mkstream().Build()).Error()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return fmt.Errorf("valkey: create group %s on %s: %w", group, key, err)
	}
	return nil
}

// Publish implements transport.Driver: XADD with trimming.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	client, err := d.conn()
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	ttl := d.ttls[channel]
	d.mu.Unlock()
	// Field order: headers (h:<name>) then the body (b), as the TS driver writes them.
	kv := make([]string, 0, 2*len(event.Headers)+2)
	for name, value := range event.Headers {
		kv = append(kv, headerField+strings.ToLower(name), value)
	}
	kv = append(kv, bodyField, valkeygo.BinaryString(event.Body))
	xadd := client.B().Xadd().Key(d.Key(channel))
	var fields = func() interface{ Build() valkeygo.Completed } {
		if ttl > 0 {
			f := xadd.Minid().Almost().Threshold(strconv.FormatInt(time.Now().Add(-ttl).UnixMilli(), 10)).Id("*").FieldValue()
			for i := 0; i < len(kv); i += 2 {
				f = f.FieldValue(kv[i], kv[i+1])
			}
			return f
		}
		f := xadd.Maxlen().Almost().Threshold(strconv.FormatInt(d.cfg.MaxLen, 10)).Id("*").FieldValue()
		for i := 0; i < len(kv); i += 2 {
			f = f.FieldValue(kv[i], kv[i+1])
		}
		return f
	}()
	if err := client.Do(ctx, fields.Build()).Error(); err != nil {
		if errors.Is(err, valkeygo.ErrClosing) {
			return "", fmt.Errorf("valkey: %w", transport.ErrNotConnected)
		}
		return "", fmt.Errorf("valkey: xadd %s: %w", channel, err)
	}
	return transport.Accepted, nil
}

func newConsumerName() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "landflow-" + hex.EncodeToString(b)
}

func wireEvent(entry valkeygo.XRangeEntry) transport.WireEvent {
	headers := map[string]string{}
	var body []byte
	for name, value := range entry.FieldValues {
		switch {
		case name == bodyField:
			body = []byte(value)
		case strings.HasPrefix(name, headerField):
			headers[strings.ToLower(name[len(headerField):])] = value
		}
	}
	return transport.WireEvent{Headers: headers, Body: body}
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	client, err := d.conn()
	if err != nil {
		return nil, err
	}
	prefetch := max(opts.Prefetch, 1)
	key := d.Key(channel)
	if opts.Group != "" {
		if err := d.ensureGroup(ctx, client, key, opts.Group); err != nil {
			return nil, err
		}
	}
	// A broadcast reader starts from the id current now, so an event published right after Consume returns is seen.
	last := "0-0"
	if opts.Group == "" {
		if entries, err := client.Do(ctx, client.B().Xrevrange().Key(key).End("+").Start("-").Count(1).Build()).AsXRange(); err == nil && len(entries) == 1 {
			last = entries[0].ID
		}
	}
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{
		d: d, client: client, channel: channel, key: key, group: opts.Group, consumer: newConsumerName(), cancel: cancel, done: make(chan struct{}),
		handler: handler, prefetch: prefetch, manual: opts.Group != "" && opts.AckMode != transport.AckAuto, slots: make(chan struct{}, prefetch),
		inFlight: map[string]bool{}, last: last,
	}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	go s.run(runCtx)
	return s, nil
}

// liveWindow is how recently a consumer must have acted to count as live in Stats.
func (d *Driver) liveWindow() time.Duration { return max(3*d.cfg.Block, d.cfg.ClaimIdle/2) }

// Stats implements transport.StatsReporter: the largest group lag as depth and
// the live consumers (idle below a threshold, the parking consumer excluded).
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	client, err := d.conn()
	if err != nil {
		return transport.ChannelStats{}, err
	}
	key := d.Key(channel)
	groups, err := client.Do(ctx, client.B().XinfoGroups().Key(key).Build()).ToArray()
	if err != nil {
		return transport.ChannelStats{Depth: transport.Int(0), Consumers: transport.Int(0)}, nil // no stream yet
	}
	depth, consumers := 0, 0
	live := d.liveWindow().Milliseconds()
	for _, g := range groups {
		m, err := g.AsMap()
		if err != nil {
			continue
		}
		if lagMsg, ok := m["lag"]; ok {
			if lag, err := lagMsg.AsInt64(); err == nil && int(lag) > depth {
				depth = int(lag)
			}
		}
		nameMsg := m["name"]
		name, _ := nameMsg.ToString()
		members, err := client.Do(ctx, client.B().XinfoConsumers().Key(key).Group(name).Build()).ToArray()
		if err != nil {
			continue
		}
		for _, member := range members {
			mm, err := member.AsMap()
			if err != nil {
				continue
			}
			cname := mm["name"]
			if n, _ := cname.ToString(); n == OrphansConsumer {
				continue
			}
			idleMsg := mm["idle"]
			if idle, err := idleMsg.AsInt64(); err != nil || idle <= live {
				consumers++
			}
		}
	}
	return transport.ChannelStats{Depth: transport.Int(depth), Consumers: transport.Int(consumers), Lag: transport.Int(depth)}, nil
}

// DeleteStreams removes the streams (and their groups) of channels (tests and operators).
func (d *Driver) DeleteStreams(ctx context.Context, channels ...string) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	if len(channels) == 0 {
		return nil
	}
	keys := make([]string, len(channels))
	for i, c := range channels {
		keys[i] = d.Key(c)
	}
	return client.Do(ctx, client.B().Del().Key(keys...).Build()).Error()
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	d.closed = true
	client := d.client
	d.client = nil
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.subs = map[*subscription]struct{}{}
	d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range subs {
		_ = s.Close(ctx)
	}
	if client != nil {
		client.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions and deliveries
// ---------------------------------------------------------------------------

type subscription struct {
	d        *Driver
	client   valkeygo.Client
	channel  string
	key      string
	group    string
	consumer string
	cancel   context.CancelFunc
	done     chan struct{}
	handler  transport.Handler
	prefetch int
	manual   bool
	slots    chan struct{}
	closed   atomic.Bool

	last string // broadcast: the last id read

	mu       sync.Mutex
	inFlight map[string]bool // entry ids this consumer holds unacknowledged
}

func (s *subscription) Channel() string { return s.channel }

// Close stops reading, parks the entries it holds for another consumer to
// reclaim at once, and leaves the group.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	s.cancel()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	if s.group != "" {
		dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer dcancel()
		s.mu.Lock()
		held := make([]string, 0, len(s.inFlight))
		for id := range s.inFlight {
			held = append(held, id)
		}
		s.inFlight = map[string]bool{}
		s.mu.Unlock()
		_ = s.park(dctx, held...)
		_ = s.client.Do(dctx, s.client.B().XgroupDelconsumer().Key(s.key).Group(s.group).Consumername(s.consumer).Build()).Error()
	}
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	return nil
}

// park hands entries to the parking consumer with their idle time already past ClaimIdle.
func (s *subscription) park(ctx context.Context, ids ...string) error {
	if len(ids) == 0 {
		return nil
	}
	cmd := s.client.B().Xclaim().Key(s.key).Group(s.group).Consumer(OrphansConsumer).MinIdleTime("0").Id(ids...).Idle(s.d.cfg.ClaimIdle.Milliseconds()).Justid().Build()
	return s.client.Do(ctx, cmd).Error()
}

func (s *subscription) run(ctx context.Context) {
	defer close(s.done)
	if s.group == "" {
		s.runBroadcast(ctx)
		return
	}
	go s.keepAlive(ctx)
	block := s.d.cfg.Block.Milliseconds()
	lastClaim := time.Time{}
	for ctx.Err() == nil {
		free := s.prefetch - len(s.slots)
		if free <= 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(20 * time.Millisecond):
			}
			continue
		}
		// A claim pass first (every Block): entries a dead consumer left pending, or parked by a requeue.
		if time.Since(lastClaim) >= s.d.cfg.Block {
			lastClaim = time.Now()
			if claimed := s.claim(ctx, free); claimed > 0 {
				free -= claimed
				if free <= 0 {
					continue
				}
			}
		}
		cmd := s.client.B().Xreadgroup().Group(s.group, s.consumer).Count(int64(free)).Block(block).Streams().Key(s.key).Id(">").Build()
		res, err := s.client.Do(ctx, cmd).AsXRead()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, valkeygo.ErrClosing) {
				return
			}
			if !valkeygo.IsValkeyNil(err) {
				time.Sleep(s.d.cfg.Block) // the group or stream vanished, or the server is away; retry
			}
			continue
		}
		for _, entry := range res[s.key] {
			s.dispatch(ctx, entry, 1)
		}
	}
}

// keepAlive renews the idle time of the entries this consumer holds, so a slow
// call is not reclaimed by another consumer.
func (s *subscription) keepAlive(ctx context.Context) {
	every := max(time.Second, s.d.cfg.ClaimIdle/3)
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			ids := make([]string, 0, len(s.inFlight))
			for id := range s.inFlight {
				ids = append(ids, id)
			}
			s.mu.Unlock()
			if len(ids) == 0 {
				continue
			}
			cmd := s.client.B().Xclaim().Key(s.key).Group(s.group).Consumer(s.consumer).MinIdleTime("0").Id(ids...).Justid().Build()
			_ = s.client.Do(ctx, cmd).Error()
		}
	}
}

// claim takes up to n entries that stayed pending longer than ClaimIdle and
// delivers them with their true delivery count.
func (s *subscription) claim(ctx context.Context, n int) int {
	cmd := s.client.B().Xautoclaim().Key(s.key).Group(s.group).Consumer(s.consumer).MinIdleTime(strconv.FormatInt(s.d.cfg.ClaimIdle.Milliseconds(), 10)).Start("0-0").Count(int64(n)).Build()
	arr, err := s.client.Do(ctx, cmd).ToArray()
	if err != nil || len(arr) < 2 {
		return 0
	}
	entries, err := arr[1].AsXRange()
	if err != nil {
		return 0
	}
	claimed := 0
	for _, entry := range entries {
		if entry.FieldValues == nil {
			// The entry was deleted from the stream (XAUTOCLAIM reports it as nil): forget it.
			_ = s.client.Do(ctx, s.client.B().Xack().Key(s.key).Group(s.group).Id(entry.ID).Build()).Error()
			continue
		}
		s.dispatch(ctx, entry, s.deliveryCount(ctx, entry.ID))
		claimed++
	}
	return claimed
}

// deliveryCount reads the pending entry's delivery counter (1 on a fresh delivery).
func (s *subscription) deliveryCount(ctx context.Context, id string) int {
	cmd := s.client.B().Xpending().Key(s.key).Group(s.group).Start(id).End(id).Count(1).Build()
	rows, err := s.client.Do(ctx, cmd).ToArray()
	if err != nil || len(rows) == 0 {
		return 1
	}
	fields, err := rows[0].ToArray()
	if err != nil || len(fields) < 4 {
		return 1
	}
	if n, err := fields[3].AsInt64(); err == nil && n > 0 {
		return int(n)
	}
	return 1
}

func (s *subscription) dispatch(ctx context.Context, entry valkeygo.XRangeEntry, attempt int) {
	s.slots <- struct{}{}
	del := &delivery{s: s, id: entry.ID, attempt: attempt}
	if s.manual {
		s.mu.Lock()
		s.inFlight[entry.ID] = true
		s.mu.Unlock()
	} else {
		_ = del.Ack(ctx)
	}
	go s.handler(ctx, wireEvent(entry), del)
}

// runBroadcast reads the stream from the id current at subscribe time: every subscriber sees every new entry.
func (s *subscription) runBroadcast(ctx context.Context) {
	last := s.last
	block := s.d.cfg.Block.Milliseconds()
	for ctx.Err() == nil {
		cmd := s.client.B().Xread().Count(int64(s.prefetch)).Block(block).Streams().Key(s.key).Id(last).Build()
		res, err := s.client.Do(ctx, cmd).AsXRead()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, valkeygo.ErrClosing) {
				return
			}
			if !valkeygo.IsValkeyNil(err) {
				time.Sleep(s.d.cfg.Block)
			}
			continue
		}
		for _, entry := range res[s.key] {
			last = entry.ID
			s.slots <- struct{}{}
			go func(entry valkeygo.XRangeEntry) {
				defer func() { <-s.slots }()
				del := &delivery{s: s, id: entry.ID, attempt: 1}
				del.settled.Store(true) // nothing to acknowledge on a broadcast stream
				s.handler(ctx, wireEvent(entry), del)
			}(entry)
		}
	}
}

type delivery struct {
	s       *subscription
	id      string
	attempt int
	settled atomic.Bool
}

func (d *delivery) Attempt() int { return d.attempt }

func (d *delivery) settle(ctx context.Context, fn func(ctx context.Context) error) error {
	if !d.settled.CompareAndSwap(false, true) {
		return nil
	}
	defer func() { <-d.s.slots }()
	if !d.s.manual {
		return fn(ctx)
	}
	d.s.mu.Lock()
	delete(d.s.inFlight, d.id)
	d.s.mu.Unlock()
	return fn(context.WithoutCancel(ctx))
}

// Ack: XACK, then delete the entry (one group per request stream; trimming is the backstop).
func (d *delivery) Ack(ctx context.Context) error {
	return d.settle(ctx, func(ctx context.Context) error {
		if d.s.group == "" {
			return nil
		}
		c := d.s.client
		if err := c.Do(ctx, c.B().Xack().Key(d.s.key).Group(d.s.group).Id(d.id).Build()).Error(); err != nil && !errors.Is(err, valkeygo.ErrClosing) {
			return fmt.Errorf("valkey: xack: %w", err)
		}
		_ = c.Do(ctx, c.B().Xdel().Key(d.s.key).Id(d.id).Build()).Error()
		return nil
	})
}

// Nack: with requeue the entry is parked with the orphans consumer, idle past
// ClaimIdle, so any consumer's next claim pass redelivers it (delivery count +1);
// without, it is acked and deleted.
func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	if !requeue {
		return d.Ack(ctx)
	}
	return d.settle(ctx, func(ctx context.Context) error {
		if d.s.group == "" {
			return nil
		}
		if err := d.s.park(ctx, d.id); err != nil && !errors.Is(err, valkeygo.ErrClosing) {
			return fmt.Errorf("valkey: requeue: %w", err)
		}
		return nil
	})
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
)
