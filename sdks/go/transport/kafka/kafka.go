// Package kafka is the Kafka driver of sdks/go/transport (docs/transports.md
// "Brokers", docs/protocol.md §14.9), built on github.com/twmb/franz-go.
//
//   - A topic per channel; records carry the CloudEvents attributes as `ce_`
//     headers (binary mode) and the ordering key as the record key.
//   - Work sharing: a classic **consumer group** when Config.Mode is ModeGroup,
//     the default and what the TS and Python drivers do (works on every Kafka
//     and Redpanda, parallelism up to the partition count, commits instead of
//     acks, group lag for KEDA). A requeue, a graceful close and a rebalance
//     that moves a partition under a held call re-publish or commit like the TS
//     driver, so a record is handed to a survivor and not run twice; a record
//     re-read after a hard crash counts as attempt 1. ModeShare uses a Kafka
//     **share group** (KIP-932, Kafka 4.2+; the local broker is 4.3 with
//     share.version=1): records are acquired and acknowledged one by one, a
//     released record goes to another consumer and DeliveryCount counts the
//     attempts. Replicas of one plugin must all use the same mode.
//   - Replies: a reply topic per host (RepliesChannel); the core correlates.
//   - Broadcast channels (reply, registry, control): every consumer reads the
//     topic from its end without a group.
//   - Admin: topics are created on Declare (kadm); Stats reports the group's
//     lag and member count.
//
// This package is its own Go module so sdks/go stays free of franz-go: a
// plugin adds `require github.com/landflow/landflow/sdks/go/transport/kafka`
// (with a replace to this directory while the repo is unpublished) and either
// calls kafka.New(kafka.Config{…}) or blank-imports the package and sets
// LANDFLOW_KAFKA_URL (`kafka://b1:9092,b2:9092`, optional
// LANDFLOW_KAFKA_USERNAME / _PASSWORD for SASL SCRAM-SHA-256, _TLS=true, _PREFIX,
// _MODE=group|share, _PARTITIONS=n).
package kafka

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
	"github.com/twmb/franz-go/pkg/sasl/scram"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "kafka"

// HeaderPrefix is the Kafka protocol binding's prefix for CloudEvents attributes.
const HeaderPrefix = "ce_"

// attemptHeader is the driver-private record header carrying the delivery
// attempt of a requeued (republished) record, as the TS driver writes it. It is
// never shown to the core (UnprefixHeaders keeps only ce_ headers).
const attemptHeader = "lf-attempt"

// Mode selects how replicas share a request topic.
type Mode string

const (
	// ModeShare: a Kafka share group (KIP-932, Kafka 4.2+ with the share.version
	// feature; opt-in): per-record acquisition and acknowledgement, release
	// = requeue, truthful delivery counts, a crashed member's records redelivered
	// at once. Caveat: franz-go auto-accepts the records of a poll on the next
	// poll, so a consumer holding an at-least-once delivery fetches nothing more
	// until it settles it (the default at-most-once path is unaffected).
	ModeShare Mode = "share"
	// ModeGroup: a classic consumer group (the default, what the TS and Python
	// drivers use: works on every Kafka and Redpanda; the low-water mark of
	// acknowledged offsets is committed; a requeue or a graceful close
	// republishes the record with lf-attempt + 1; a partition revoked under a
	// held call commits it, so the new owner does not run it twice). A record a
	// crashed member held is re-read by the survivor after the rebalance, as
	// attempt 1.
	ModeGroup Mode = "group"
)

// Config configures a Kafka driver.
type Config struct {
	transport.Config
	// Brokers are the bootstrap addresses ("127.0.0.1:59092").
	Brokers []string
	// Mode: ModeGroup (default) or ModeShare (needs Kafka 4.2+).
	Mode Mode
	// ClientID is sent to the broker (default "landflow").
	ClientID string
	// TLS, when set, is used for every connection.
	TLS *tls.Config
	// Username / Password enable SASL SCRAM-SHA-256.
	Username, Password string
	// Partitions of the shared topics this driver creates (default 6, as the TS driver; broadcast topics have one).
	Partitions int32
	// Retention of request topics declared without a TTL (default 24 h; other topics keep 1 h).
	Retention time.Duration
	// ReplicationFactor for topics this driver creates (default: the broker's default, -1).
	ReplicationFactor int16
	// MaxMessageBytes the broker accepts (default 1 MiB, Kafka's message.max.bytes).
	MaxMessageBytes int
	// AcquisitionRenew: in ModeShare, how often a held record's lock is renewed
	// (default 10 s, under the broker's 30 s group.share.record.lock.duration.ms).
	AcquisitionRenew time.Duration
}

// Driver is a Kafka connection: one producer client (also the admin client) and
// one consumer client per subscription.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu     sync.Mutex
	client *kgo.Client // producer + admin; nil until Connect, nil again after Close
	admin  *kadm.Client
	subs   map[*subscription]struct{}
	closed bool
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.Mode == "" {
		cfg.Mode = ModeGroup
	}
	if cfg.ClientID == "" {
		cfg.ClientID = "landflow"
	}
	if cfg.Partitions == 0 {
		cfg.Partitions = 6
	}
	if cfg.Retention <= 0 {
		cfg.Retention = 24 * time.Hour
	}
	if cfg.ReplicationFactor == 0 {
		cfg.ReplicationFactor = -1
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = 1 << 20
	}
	if cfg.AcquisitionRenew <= 0 {
		cfg.AcquisitionRenew = 10 * time.Second
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
			TTL:             false, // retention is approximate; the core checks lfdeadline
			Undeliverable:   transport.UndeliverableInferred,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyHigh,
			Headers:         true,
			OrderingKeys:    true,
			Nack:            true,
			Attempts:        true, // a requeue or a graceful close re-publishes with the next attempt; a record re-read after a hard crash counts as attempt 1
		},
		subs: map[*subscription]struct{}{},
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

// ConfigFromURL builds a Config from `kafka://host1:9092,host2:9092` (or a bare
// host list) and the connection options; fields: mode (share|group), partitions.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	hosts := strings.TrimSpace(rawURL)
	if i := strings.Index(hosts, "://"); i >= 0 {
		scheme := strings.ToLower(hosts[:i])
		if scheme != "kafka" && scheme != "kafkas" && scheme != "redpanda" {
			return Config{}, fmt.Errorf("kafka: unsupported URL scheme %q (want kafka://host:port[,host:port])", scheme)
		}
		hosts = hosts[i+3:]
	}
	hosts = strings.TrimSuffix(hosts, "/")
	var brokers []string
	for _, h := range strings.Split(hosts, ",") {
		if h = strings.TrimSpace(h); h != "" {
			if _, _, err := splitHostPort(h); err != nil {
				return Config{}, fmt.Errorf("kafka: broker %q: %w", h, err)
			}
			brokers = append(brokers, h)
		}
	}
	if len(brokers) == 0 {
		return Config{}, errors.New("kafka: the URL names no broker (want kafka://host:port[,host:port])")
	}
	cfg := Config{
		Config:   transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix},
		Brokers:  brokers,
		Username: opts.Username, Password: opts.Password,
	}
	if opts.TLS || strings.HasPrefix(strings.ToLower(rawURL), "kafkas://") {
		cfg.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	switch mode := strings.ToLower(opts.Fields["mode"]); mode {
	case "", "group":
		cfg.Mode = ModeGroup
	case "share":
		cfg.Mode = ModeShare
	default:
		return Config{}, fmt.Errorf("kafka: mode %q must be share or group", mode)
	}
	if raw := opts.Fields["partitions"]; raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("kafka: partitions %q must be a positive integer", raw)
		}
		cfg.Partitions = int32(n)
	}
	return cfg, nil
}

func splitHostPort(h string) (string, string, error) {
	u, err := url.Parse("tcp://" + h)
	if err != nil || u.Hostname() == "" || u.Port() == "" {
		return "", "", errors.New("want host:port")
	}
	return u.Hostname(), u.Port(), nil
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// KafkaConfig returns the full driver configuration.
func (d *Driver) KafkaConfig() Config { return d.cfg }

func (d *Driver) baseOpts() []kgo.Opt {
	opts := []kgo.Opt{
		kgo.SeedBrokers(d.cfg.Brokers...),
		kgo.ClientID(d.cfg.ClientID),
		kgo.ProducerBatchMaxBytes(int32(d.cfg.MaxMessageBytes)),
		kgo.FetchMaxBytes(int32(d.cfg.MaxMessageBytes) * 4),
		kgo.BrokerMaxReadBytes(int32(d.cfg.MaxMessageBytes)*8 + 1<<20),
	}
	if d.cfg.TLS != nil {
		opts = append(opts, kgo.DialTLSConfig(d.cfg.TLS))
	}
	if d.cfg.Username != "" {
		opts = append(opts, kgo.SASL(scram.Auth{User: d.cfg.Username, Pass: d.cfg.Password}.AsSha256Mechanism()))
	}
	return opts
}

// Connect implements transport.Driver: it opens the producer client and pings
// the cluster, so a failure means nothing was sent anywhere.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("kafka: driver closed: %w", transport.ErrNotConnected)
	}
	if d.client != nil {
		return nil
	}
	// Keyed records hash to a partition (one run's calls stay in order); keyless ones spread over the partitions so
	// every member of the group gets work.
	opts := append(d.baseOpts(), kgo.RequiredAcks(kgo.AllISRAcks()), kgo.ProducerLinger(0), kgo.AllowAutoTopicCreation(),
		kgo.RecordPartitioner(kgo.UniformBytesPartitioner(1, false, true, nil)))
	client, err := kgo.NewClient(opts...)
	if err != nil {
		return fmt.Errorf("kafka: %w", err)
	}
	if err := client.Ping(ctx); err != nil {
		client.Close()
		return fmt.Errorf("kafka: cannot reach %s: %w", strings.Join(d.cfg.Brokers, ","), err)
	}
	d.client = client
	d.admin = kadm.NewClient(client)
	return nil
}

func (d *Driver) connected() (*kgo.Client, *kadm.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client == nil {
		return nil, nil, fmt.Errorf("kafka: %w", transport.ErrNotConnected)
	}
	return d.client, d.admin, nil
}

// Declare implements transport.Driver: it creates the topics (idempotent). A
// channel's TTL becomes the topic's retention.ms; broadcast channels get a
// short retention and one partition (ordering across every consumer).
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	_, admin, err := d.connected()
	if err != nil {
		return err
	}
	for _, ch := range channels {
		partitions := d.cfg.Partitions
		configs := map[string]*string{}
		if ch.Delivery == transport.DeliveryBroadcast {
			partitions = 1
		}
		retention := ch.TTL
		switch {
		case retention > 0:
		case ch.Durable:
			retention = d.cfg.Retention
		default:
			retention = time.Hour
		}
		ms := strconv.FormatInt(retention.Milliseconds(), 10)
		configs["retention.ms"] = &ms
		if !ch.Durable {
			// Ephemeral topics roll segments often enough for the retention to bite.
			seg := strconv.FormatInt(max(time.Minute, min(retention, time.Hour)).Milliseconds(), 10)
			configs["segment.ms"] = &seg
		}
		if d.cfg.MaxMessageBytes > 0 {
			mb := strconv.Itoa(d.cfg.MaxMessageBytes + 64<<10)
			configs["max.message.bytes"] = &mb
		}
		resps, err := admin.CreateTopics(ctx, partitions, d.cfg.ReplicationFactor, configs, ch.Name)
		if err != nil {
			return fmt.Errorf("kafka: create topic %s: %w", ch.Name, err)
		}
		for _, r := range resps {
			if r.Err != nil && !errors.Is(r.Err, kerr.TopicAlreadyExists) {
				return fmt.Errorf("kafka: create topic %s: %w", ch.Name, r.Err)
			}
		}
	}
	return nil
}

// Publish implements transport.Driver: one record, synchronously produced with
// acks=all. The ordering key is the record key.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	client, _, err := d.connected()
	if err != nil {
		return "", err
	}
	rec := &kgo.Record{Topic: channel, Value: event.Body}
	if opts.OrderingKey != "" {
		rec.Key = []byte(opts.OrderingKey)
	}
	for name, value := range transport.PrefixHeaders(event.Headers, HeaderPrefix) {
		rec.Headers = append(rec.Headers, kgo.RecordHeader{Key: name, Value: []byte(value)})
	}
	if err := client.ProduceSync(ctx, rec).FirstErr(); err != nil {
		if errors.Is(err, kgo.ErrClientClosed) {
			return "", fmt.Errorf("kafka: %w", transport.ErrNotConnected)
		}
		return "", fmt.Errorf("kafka: produce to %s: %w", channel, err)
	}
	return transport.Accepted, nil
}

// Consume implements transport.Driver. With a group it joins a share group (or
// consumer group); without one it reads the topic from its end.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	if _, _, err := d.connected(); err != nil {
		return nil, err
	}
	prefetch := max(opts.Prefetch, 1)
	kopts := d.baseOpts()
	share := false
	assigned := make(chan struct{})
	var assignedOnce sync.Once
	onAssigned := func(context.Context, *kgo.Client, map[string][]int32) { assignedOnce.Do(func() { close(assigned) }) }
	var sub atomic.Pointer[subscription] // set once the subscription exists; the callbacks only fire after the first poll
	onRevoked := func(ctx context.Context, _ *kgo.Client, revoked map[string][]int32) {
		if s := sub.Load(); s != nil {
			s.commitHeldOnRevoke(ctx, revoked)
		}
	}
	switch {
	case opts.Group == "":
		// Broadcast: read from the exact end offsets of now, so nothing published after Consume returns is missed.
		_, admin, err := d.connected()
		if err != nil {
			return nil, err
		}
		ends, err := admin.ListEndOffsets(ctx, channel)
		if err != nil {
			return nil, fmt.Errorf("kafka: end offsets of %s: %w", channel, err)
		}
		partitions := map[int32]kgo.Offset{}
		ends.Each(func(o kadm.ListedOffset) {
			if o.Err == nil {
				partitions[o.Partition] = kgo.NewOffset().At(o.Offset)
			}
		})
		if len(partitions) == 0 {
			return nil, fmt.Errorf("kafka: topic %s has no partitions (declare it first)", channel)
		}
		kopts = append(kopts, kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{channel: partitions}))
		close(assigned)
	case d.cfg.Mode == ModeShare:
		share = true
		if err := d.prepareShareGroup(ctx, opts.Group); err != nil {
			return nil, err
		}
		// Share groups have no assignment callback; the first share fetch follows the join within a few heartbeats.
		kopts = append(kopts, kgo.ConsumeTopics(channel), kgo.ShareGroup(opts.Group), kgo.ShareMaxRecords(int32(prefetch)), kgo.ShareMaxRecordsStrict())
		time.AfterFunc(3*time.Second, func() { assignedOnce.Do(func() { close(assigned) }) })
	default:
		kopts = append(kopts, kgo.ConsumeTopics(channel), kgo.ConsumerGroup(opts.Group), kgo.DisableAutoCommit(), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()), kgo.OnPartitionsAssigned(onAssigned), kgo.OnPartitionsRevoked(onRevoked))
	}
	client, err := kgo.NewClient(kopts...)
	if err != nil {
		return nil, fmt.Errorf("kafka: %w", err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{
		d: d, channel: channel, client: client, cancel: cancel, done: make(chan struct{}),
		handler: handler, prefetch: prefetch, share: share, manual: opts.AckMode != transport.AckAuto && opts.Group != "",
		slots: make(chan struct{}, prefetch), outstanding: map[tp]map[int64]bool{}, next: map[tp]int64{}, committed: map[tp]int64{},
		held: map[*delivery]struct{}{},
	}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	sub.Store(s)
	go s.run(runCtx)
	// A grouped consumer is ready once the group assigned it partitions (bounded, so a slow rebalance is not fatal).
	wait := 15 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		wait = min(wait, time.Until(deadline))
	}
	select {
	case <-assigned:
	case <-time.After(wait):
	case <-ctx.Done():
	}
	return s, nil
}

// prepareShareGroup sets the group's share.auto.offset.reset to "earliest" so a
// request topic buffers: records published before the first consumer attaches
// (or while every replica is down) are delivered, not skipped as the broker
// default "latest" would. Group configs may be set before the group exists.
func (d *Driver) prepareShareGroup(ctx context.Context, group string) error {
	client, _, err := d.connected()
	if err != nil {
		return err
	}
	req := kmsg.NewPtrIncrementalAlterConfigsRequest()
	res := kmsg.NewIncrementalAlterConfigsRequestResource()
	res.ResourceType = kmsg.ConfigResourceTypeGroupConfig
	res.ResourceName = group
	cfg := kmsg.NewIncrementalAlterConfigsRequestResourceConfig()
	cfg.Name = "share.auto.offset.reset"
	cfg.Op = kmsg.IncrementalAlterConfigOpSet
	cfg.Value = kmsg.StringPtr("earliest")
	res.Configs = append(res.Configs, cfg)
	req.Resources = append(req.Resources, res)
	resp, err := req.RequestWith(ctx, client)
	if err != nil {
		return fmt.Errorf("kafka: configure share group %s: %w", group, err)
	}
	for _, r := range resp.Resources {
		if err := kerr.ErrorForCode(r.ErrorCode); err != nil {
			return fmt.Errorf("kafka: configure share group %s: %w (%s)", group, err, strOf(r.ErrorMessage))
		}
	}
	return nil
}

func strOf(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Stats implements transport.StatsReporter: lag and members of the channel's
// group (the group is named after the channel, as the core does).
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	_, admin, err := d.connected()
	if err != nil {
		return transport.ChannelStats{}, err
	}
	var stats transport.ChannelStats
	if d.cfg.Mode == ModeShare {
		groups, err := admin.DescribeShareGroups(ctx, channel)
		if err == nil {
			if g, ok := groups[channel]; ok && g.Err == nil {
				stats.Consumers = transport.Int(len(g.Members))
			}
		}
		// Share-group lag is not exposed by kadm yet; depth from end offsets minus
		// nothing is meaningless, so leave Depth/Lag nil (the host infers from heartbeats).
		return stats, nil
	}
	lags, err := admin.Lag(ctx, channel)
	if err != nil {
		return stats, fmt.Errorf("kafka: lag of %s: %w", channel, err)
	}
	if l, ok := lags[channel]; ok && l.DescribeErr == nil {
		stats.Consumers = transport.Int(len(l.Members))
		if l.FetchErr == nil {
			total := int(l.Lag.Total())
			stats.Lag = &total
			stats.Depth = transport.Int(total)
		}
	}
	return stats, nil
}

// DeleteTopics removes topics (tests and operators; the core never calls it).
func (d *Driver) DeleteTopics(ctx context.Context, topics ...string) error {
	_, admin, err := d.connected()
	if err != nil {
		return err
	}
	resps, err := admin.DeleteTopics(ctx, topics...)
	if err != nil {
		return err
	}
	for _, r := range resps {
		if r.Err != nil && !errors.Is(r.Err, kerr.UnknownTopicOrPartition) {
			return fmt.Errorf("kafka: delete topic %s: %w", r.Topic, r.Err)
		}
	}
	return nil
}

// DeleteGroups removes consumer or share groups (tests and operators).
func (d *Driver) DeleteGroups(ctx context.Context, groups ...string) error {
	_, admin, err := d.connected()
	if err != nil {
		return err
	}
	// Kafka 4.x deletes share groups through the same DeleteGroups API once they are empty.
	_, err = admin.DeleteGroups(ctx, groups...)
	return err
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.mu.Unlock()
	// Subscriptions close first, while the producer is still up: a group consumer re-publishes the records it holds.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range subs {
		_ = s.Close(ctx)
	}
	d.mu.Lock()
	d.closed = true
	client := d.client
	d.client, d.admin = nil, nil
	d.subs = map[*subscription]struct{}{}
	d.mu.Unlock()
	if client != nil {
		client.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

type subscription struct {
	d        *Driver
	channel  string
	client   *kgo.Client
	cancel   context.CancelFunc
	done     chan struct{}
	handler  transport.Handler
	prefetch int
	share    bool
	manual   bool
	slots    chan struct{} // one token per in-flight delivery
	closed   atomic.Bool

	// Consumer groups commit the low-water mark: the lowest offset still outstanding per partition (or one past the
	// last delivered record), so an acknowledged record never commits an earlier one that is still held.
	heldMu sync.Mutex
	held   map[*delivery]struct{} // manual deliveries not yet settled

	offMu       sync.Mutex
	outstanding map[tp]map[int64]bool
	next        map[tp]int64 // one past the highest delivered offset
	committed   map[tp]int64
}

type tp struct {
	topic     string
	partition int32
}

// track registers a delivered record as outstanding (group mode, manual acks).
func (s *subscription) track(rec *kgo.Record) {
	key := tp{rec.Topic, rec.Partition}
	s.offMu.Lock()
	if s.outstanding[key] == nil {
		s.outstanding[key] = map[int64]bool{}
	}
	s.outstanding[key][rec.Offset] = true
	if rec.Offset+1 > s.next[key] {
		s.next[key] = rec.Offset + 1
	}
	s.offMu.Unlock()
}

// settleOffset marks a record done and commits the partition's low-water mark when it moved.
func (s *subscription) settleOffset(ctx context.Context, rec *kgo.Record) error {
	key := tp{rec.Topic, rec.Partition}
	s.offMu.Lock()
	delete(s.outstanding[key], rec.Offset)
	mark := s.next[key]
	for off := range s.outstanding[key] {
		if off < mark {
			mark = off
		}
	}
	if mark <= s.committed[key] {
		s.offMu.Unlock()
		return nil
	}
	s.committed[key] = mark
	s.offMu.Unlock()
	var commitErr error
	s.client.CommitOffsetsSync(ctx, map[string]map[int32]kgo.EpochOffset{rec.Topic: {rec.Partition: {Epoch: -1, Offset: mark}}},
		func(_ *kgo.Client, _ *kmsg.OffsetCommitRequest, _ *kmsg.OffsetCommitResponse, err error) {
			commitErr = err
		})
	if commitErr != nil && !errors.Is(commitErr, kgo.ErrClientClosed) {
		return fmt.Errorf("kafka: commit %s/%d@%d: %w", rec.Topic, rec.Partition, mark, commitErr)
	}
	return nil
}

// commitHeldOnRevoke runs when a rebalance takes partitions away from a group consumer: the records it still holds on
// them keep running here, so they are committed (as the TS driver does) and the new owner does not re-read, and re-run,
// them. A graceful Close re-publishes what the consumer holds; a hard crash after a revoke loses those calls, the same
// trade-off the TS driver makes.
func (s *subscription) commitHeldOnRevoke(ctx context.Context, revoked map[string][]int32) {
	if s.share || !s.manual {
		return
	}
	lost := map[tp]bool{}
	for topic, parts := range revoked {
		for _, p := range parts {
			lost[tp{topic, p}] = true
		}
	}
	s.heldMu.Lock()
	upTo := map[tp]int64{}
	for del := range s.held {
		key := tp{del.rec.Topic, del.rec.Partition}
		if lost[key] && del.rec.Offset+1 > upTo[key] {
			upTo[key] = del.rec.Offset + 1
		}
	}
	s.heldMu.Unlock()
	offsets := map[string]map[int32]kgo.EpochOffset{}
	s.offMu.Lock()
	for key, off := range upTo {
		if off <= s.committed[key] {
			continue
		}
		s.committed[key] = off
		if offsets[key.topic] == nil {
			offsets[key.topic] = map[int32]kgo.EpochOffset{}
		}
		offsets[key.topic][key.partition] = kgo.EpochOffset{Epoch: -1, Offset: off}
	}
	s.offMu.Unlock()
	if len(offsets) > 0 {
		s.client.CommitOffsetsSync(ctx, offsets, func(*kgo.Client, *kmsg.OffsetCommitRequest, *kmsg.OffsetCommitResponse, error) {})
	}
}

func (s *subscription) Channel() string { return s.channel }

// Close stops fetching. A share consumer releases the records it still holds
// (the broker redelivers them at once with the next delivery count); a group
// consumer re-publishes them with the next attempt, commits the originals and
// leaves. A crash (no Close) leaves them uncommitted for the rebalance.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	s.cancel()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	// Hand back what is still held: a share consumer releases its records; a group consumer re-publishes them with the
	// next attempt and commits the originals (as the TS driver does), so a survivor takes them at once and a member
	// that is still alive on the same topic never sees the same record twice.
	s.heldMu.Lock()
	held := make([]*delivery, 0, len(s.held))
	for del := range s.held {
		held = append(held, del)
	}
	s.held = nil
	s.heldMu.Unlock()
	for _, del := range held {
		_ = del.Nack(ctx, true)
	}
	if s.share && len(held) > 0 {
		_ = s.client.FlushAcks(ctx)
	}
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	s.client.Close() // releases acquired share records / leaves the group
	return nil
}

func (s *subscription) run(ctx context.Context) {
	defer close(s.done)
	for ctx.Err() == nil {
		// Only poll for as many records as we have free slots: in a share group a
		// record is auto-accepted on the next poll, so a batch must be fully acked
		// before the next one is fetched; with a consumer group it just bounds the
		// handler concurrency.
		free := s.prefetch
		if s.share || s.manual {
			free = s.prefetch - len(s.slots)
			if free <= 0 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(20 * time.Millisecond):
				}
				continue
			}
		}
		fetches := s.client.PollRecords(ctx, free)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				_ = err // the client retries; the core sees the effect as a late or missing delivery
			}
		})
		var batch sync.WaitGroup
		fetches.EachRecord(func(rec *kgo.Record) {
			s.slots <- struct{}{}
			if !s.manual {
				// Auto-ack (broadcast, control): one handler at a time, in log order, as the TS driver does.
				s.deliver(ctx, rec)
				return
			}
			batch.Add(1)
			go func() {
				defer batch.Done()
				s.deliver(ctx, rec)
			}()
		})
		if s.share {
			// A share batch must be fully acknowledged before the next poll (an
			// unacked record would be auto-accepted). Renew the acquisition lock
			// of records held for long.
			waitDone := make(chan struct{})
			go func() { batch.Wait(); close(waitDone) }()
			ticker := time.NewTicker(s.d.cfg.AcquisitionRenew)
		wait:
			for {
				select {
				case <-waitDone:
					break wait
				case <-ctx.Done():
					break wait
				case <-ticker.C:
					fetches.EachRecord(func(rec *kgo.Record) { rec.Ack(kgo.AckRenew) })
					_ = s.client.FlushAcks(ctx)
				}
			}
			ticker.Stop()
			if ctx.Err() == nil {
				_ = s.client.FlushAcks(ctx)
			}
		}
	}
}

// deliver runs the handler for one record; the delivery's Ack/Nack free the slot.
func (s *subscription) deliver(ctx context.Context, rec *kgo.Record) {
	headers := make(map[string]string, len(rec.Headers))
	for _, h := range rec.Headers {
		headers[h.Key] = string(h.Value)
	}
	del := &delivery{s: s, rec: rec}
	if s.manual {
		if !s.share {
			s.track(rec)
		}
		s.heldMu.Lock()
		if s.held != nil {
			s.held[del] = struct{}{}
		}
		s.heldMu.Unlock()
	}
	if !s.manual {
		// Auto-ack: broadcast channels have no group (nothing to commit), and
		// AckAuto in a group commits or accepts at once.
		del.settle(ctx, true, false)
	}
	s.handler(ctx, transport.WireEvent{Headers: transport.UnprefixHeaders(headers, HeaderPrefix), Body: rec.Value}, del)
	if !del.settled.Load() && s.manual {
		// The handler held the delivery: it will Ack/Nack later and free the slot then.
		return
	}
}

type delivery struct {
	s       *subscription
	rec     *kgo.Record
	settled atomic.Bool
}

// Attempt: the share group's delivery count, or the lf-attempt header of a
// republished record (whichever says more), else 1.
func (d *delivery) Attempt() int {
	attempt := 1
	for _, h := range d.rec.Headers {
		if h.Key == attemptHeader {
			if n, err := strconv.Atoi(string(h.Value)); err == nil && n > attempt {
				attempt = n
			}
		}
	}
	if d.s.share {
		if n := int(d.rec.DeliveryCount()); n > 0 {
			// A republished record starts a new delivery count: add the earlier attempts.
			attempt = n + attempt - 1
		}
	}
	return attempt
}

func (d *delivery) Ack(ctx context.Context) error { return d.settle(ctx, true, false) }

func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	return d.settle(ctx, false, requeue)
}

// settle acknowledges once: share groups accept / release / reject the record;
// consumer groups commit its offset, after republishing it with the next
// attempt when it is requeued.
func (d *delivery) settle(ctx context.Context, ack, requeue bool) error {
	if !d.settled.CompareAndSwap(false, true) {
		return nil
	}
	defer func() { <-d.s.slots }()
	if !d.s.manual {
		return nil
	}
	d.s.heldMu.Lock()
	delete(d.s.held, d)
	d.s.heldMu.Unlock()
	if d.s.share {
		switch {
		case ack:
			d.rec.Ack(kgo.AckAccept)
		case requeue:
			d.rec.Ack(kgo.AckRelease)
		default:
			d.rec.Ack(kgo.AckReject)
		}
		return nil
	}
	if !ack && requeue {
		if err := d.republish(ctx); err != nil {
			return err
		}
	}
	return d.s.settleOffset(ctx, d.rec)
}

// republish puts the record back on its topic with lf-attempt = attempt + 1.
func (d *delivery) republish(ctx context.Context) error {
	producer, _, err := d.s.d.connected()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	again := &kgo.Record{Topic: d.rec.Topic, Key: d.rec.Key, Value: d.rec.Value}
	for _, h := range d.rec.Headers {
		if h.Key != attemptHeader {
			again.Headers = append(again.Headers, h)
		}
	}
	again.Headers = append(again.Headers, kgo.RecordHeader{Key: attemptHeader, Value: []byte(strconv.Itoa(d.Attempt() + 1))})
	if err := producer.ProduceSync(ctx, again).FirstErr(); err != nil {
		return fmt.Errorf("kafka: requeue %s: %w", d.rec.Topic, err)
	}
	return nil
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
)
