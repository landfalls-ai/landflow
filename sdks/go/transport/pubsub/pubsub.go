// Package pubsub is the Google Cloud Pub/Sub driver of sdks/go/transport
// (docs/transports.md "Brokers", docs/protocol.md §14.9), built on
// cloud.google.com/go/pubsub/v2. It is wire-compatible with the TypeScript
// driver (@landflow/transports/pubsub):
//
//   - Emulator only by default: the config names the emulator
//     (EmulatorHost "127.0.0.1:58085", project "landflow-dev"); the real service
//     (Google credentials from the environment) is used only with AllowCloud.
//     In emulator mode the client gets an insecure channel and no
//     authentication, whatever PUBSUB_EMULATOR_HOST says.
//   - A channel is a topic (`<TopicPrefix><channel>`). A shared channel has one
//     subscription per work-sharing group (the channel name, as the core uses
//     it), created in Declare so events published before the first consumer
//     wait for it, with message ordering on and a dead-letter policy
//     (`<topic>.dlq`, MaxDeliveryAttempts 100): Pub/Sub populates
//     delivery_attempt only on subscriptions with one, and Attempt comes from
//     it. Consumers stream-pull with MaxOutstandingMessages = prefetch; the
//     client extends ack deadlines of in-flight messages. Ack acks, a nack with
//     requeue and a closing consumer nack (immediate redelivery), a nack
//     without requeue acks.
//   - Broadcast channels (reply, registry, control) get one subscription per
//     consumer (`<topic>.bc.<consumerId>`, retention 10 min, expires after a
//     day without consumers, deleted on Close).
//   - Mode: binary; attributes carry every header with the `ce_` prefix
//     (`content-type` bare). Ordering keys are honoured.
//   - Limits: 10 MB per message; no per-message TTL; Pub/Sub exposes neither
//     consumer counts nor backlog to clients, so there is no Stats and
//     Undeliverable is unknown. The emulator never expires messages or
//     subscriptions: tests delete what they create.
//
// This package is its own Go module so sdks/go stays free of the Google
// client. Code use: pubsub.New(pubsub.Config{ProjectID: "landflow-dev",
// EmulatorHost: "127.0.0.1:58085"}); env use: blank-import the package and set
// LANDFLOW_PUBSUB_URL=pubsub://127.0.0.1:58085/landflow-dev (plus
// LANDFLOW_PUBSUB_PROJECTID, _EMULATORHOST, _ALLOWCLOUD=true, _TOPICPREFIX,
// _PREFIX).
package pubsub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	gpubsub "cloud.google.com/go/pubsub/v2"
	"cloud.google.com/go/pubsub/v2/apiv1/pubsubpb"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "pubsub"

const (
	// MaxMessageBytes is Pub/Sub's maximum message size (10 MB, decimal).
	MaxMessageBytes = 10_000_000
	// HeaderPrefix is the attribute prefix of CloudEvents attributes.
	HeaderPrefix = "ce_"

	broadcastInfix = ".bc."
	dlqSuffix      = ".dlq"
)

// Config configures a Pub/Sub driver.
type Config struct {
	transport.Config
	// ProjectID is the Google Cloud project.
	ProjectID string
	// EmulatorHost is the emulator, "host:port" ("127.0.0.1:58085"). Empty: the real service, which needs AllowCloud.
	EmulatorHost string
	// AllowCloud opts in to the real service (Google credentials from the environment). Never set in tests.
	AllowCloud bool
	// TopicPrefix is prepended to every topic and subscription id (default none).
	TopicPrefix string
	// MaxMessageBytes the driver accepts (default and maximum 10 MB).
	MaxMessageBytes int
	// AckDeadline of request subscriptions (10 s–600 s, default 30 s); the
	// client extends it for messages in flight. Redelivery after a hard crash
	// waits this long.
	AckDeadline time.Duration
	// Retention of request subscriptions (10 min–7 days, default 1 h).
	Retention time.Duration
	// DeadLetter attaches a dead-letter topic to request subscriptions so
	// delivery_attempt is populated (default true; NoDeadLetter turns it off).
	NoDeadLetter bool
	// MaxDeliveryAttempts of the dead-letter policy (5–100, default 100).
	MaxDeliveryAttempts int
	// ConnectTimeout bounds the connect probe (default 10 s).
	ConnectTimeout time.Duration
}

// Driver is one Pub/Sub client.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu       sync.Mutex
	client   *gpubsub.Client
	closed   bool
	specs    map[string]transport.ChannelSpec
	topics   map[string]bool // topics known to exist, by channel
	subsDecl map[string]bool // shared subscriptions known to exist, by id
	pubs     map[string]*gpubsub.Publisher
	subs     map[*subscription]struct{}
	owned    map[string]bool // instance and reply channels this driver declared: their topic and subscriptions die with the process
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.MaxMessageBytes <= 0 || cfg.MaxMessageBytes > MaxMessageBytes {
		cfg.MaxMessageBytes = MaxMessageBytes
	}
	if cfg.AckDeadline <= 0 {
		cfg.AckDeadline = 30 * time.Second
	}
	cfg.AckDeadline = min(600*time.Second, max(10*time.Second, cfg.AckDeadline))
	if cfg.Retention <= 0 {
		cfg.Retention = time.Hour
	}
	cfg.Retention = min(7*24*time.Hour, max(10*time.Minute, cfg.Retention))
	if cfg.MaxDeliveryAttempts <= 0 {
		cfg.MaxDeliveryAttempts = 100
	}
	cfg.MaxDeliveryAttempts = min(100, max(5, cfg.MaxDeliveryAttempts))
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 10 * time.Second
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
			Undeliverable:   transport.UndeliverableUnknown,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyMedium,
			Headers:         true,
			OrderingKeys:    true,
			Nack:            true,
			Attempts:        true,
		},
		specs: map[string]transport.ChannelSpec{}, topics: map[string]bool{}, subsDecl: map[string]bool{}, pubs: map[string]*gpubsub.Publisher{}, subs: map[*subscription]struct{}{}, owned: map[string]bool{},
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

var (
	projectRE = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`)
	hostRE    = regexp.MustCompile(`^[A-Za-z0-9.\-_\[\]:]+:\d{1,5}$`)
	cloudRE   = regexp.MustCompile(`(?i)\.googleapis\.com(:\d+)?$`)
	unsafeRE  = regexp.MustCompile(`[^A-Za-z0-9._~%+-]`)
)

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

func falsy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "false", "no":
		return true
	}
	return false
}

// ConfigFromURL builds a Config from a connection URL and options. The URL is
// "pubsub://<emulatorHost:port>/<projectId>" (emulator) or
// "pubsub://<projectId>" / "pubsub://pubsub.googleapis.com/<projectId>" (the
// real service, needs the field allowcloud). Fields: projectid, emulatorhost
// (both win over the URL), allowcloud, topicprefix, the tunables and deadletter.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	raw := strings.TrimSpace(rawURL)
	cfg := Config{Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}}
	var parsed *url.URL
	if raw != "" {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme == "" {
			return Config{}, fmt.Errorf("pubsub: URL %q must look like pubsub://127.0.0.1:58085/<projectId> (emulator) or pubsub://<projectId>", rawURL)
		}
		if u.Scheme != "pubsub" {
			return Config{}, fmt.Errorf("pubsub: URL %q must use pubsub://", rawURL)
		}
		if u.Hostname() == "" {
			return Config{}, fmt.Errorf("pubsub: URL %q has no host or project", rawURL)
		}
		parsed = u
	}
	path := ""
	hostIsProject, hostIsCloud := false, false
	if parsed != nil {
		path = strings.Trim(parsed.Path, "/")
		hostIsProject = parsed.Port() == "" && path == "" && !strings.Contains(parsed.Hostname(), ".")
		hostIsCloud = cloudRE.MatchString(parsed.Hostname())
	}
	cfg.ProjectID = strings.TrimSpace(opts.Fields["projectid"])
	if cfg.ProjectID == "" && parsed != nil {
		if hostIsProject {
			cfg.ProjectID = parsed.Hostname()
		} else {
			cfg.ProjectID = path
		}
	}
	if cfg.ProjectID == "" {
		return Config{}, errors.New("pubsub: a project id is needed (the projectid field or pubsub://host:port/<projectId>)")
	}
	if !projectRE.MatchString(cfg.ProjectID) {
		return Config{}, fmt.Errorf("pubsub: project id %q must be 6–30 lower-case letters, digits or hyphens, starting with a letter", cfg.ProjectID)
	}
	cfg.AllowCloud = truthy(opts.Fields["allowcloud"])
	cfg.EmulatorHost = strings.TrimSpace(opts.Fields["emulatorhost"])
	if cfg.EmulatorHost == "" && parsed != nil && !hostIsProject && !hostIsCloud {
		cfg.EmulatorHost = parsed.Host
	}
	if cfg.EmulatorHost != "" {
		if !hostRE.MatchString(cfg.EmulatorHost) {
			return Config{}, fmt.Errorf("pubsub: emulator host %q must be host:port", cfg.EmulatorHost)
		}
	} else if !cfg.AllowCloud {
		return Config{}, errors.New("pubsub: the emulator is needed (pubsub://127.0.0.1:58085/<projectId>): the real service is used only with allowcloud")
	}
	cfg.TopicPrefix = strings.TrimSpace(opts.Fields["topicprefix"])
	if v := opts.Fields["maxmessagebytes"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > MaxMessageBytes {
			return Config{}, fmt.Errorf("pubsub: maxmessagebytes %q must be 1..%d", v, MaxMessageBytes)
		}
		cfg.MaxMessageBytes = n
	}
	for name, dst := range map[string]*time.Duration{"ackdeadlineseconds": &cfg.AckDeadline, "retentionseconds": &cfg.Retention} {
		if v := opts.Fields[name]; v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				*dst = time.Duration(n) * time.Second
			}
		}
	}
	if v := opts.Fields["maxdeliveryattempts"]; v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.MaxDeliveryAttempts = n
		}
	}
	if v := opts.Fields["connecttimeoutms"]; v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.ConnectTimeout = time.Duration(n) * time.Millisecond
		}
	}
	cfg.NoDeadLetter = falsy(opts.Fields["deadletter"])
	return cfg, nil
}

// TopicID is the topic id of a channel: a valid resource id ([A-Za-z0-9._~%+-]{3,255}, starting with a letter, never goog…).
func TopicID(channel, topicPrefix string) string {
	id := unsafeRE.ReplaceAllString(topicPrefix+channel, "_")
	if id == "" || !((id[0] >= 'A' && id[0] <= 'Z') || (id[0] >= 'a' && id[0] <= 'z')) || strings.HasPrefix(strings.ToLower(id), "goog") {
		id = "lf-" + id
	}
	for len(id) < 3 {
		id += "_"
	}
	if len(id) > 255 {
		id = id[:255]
	}
	return id
}

// SharedSubscriptionID is the subscription id a work-sharing group uses on a channel: the topic id when the group is the channel.
func SharedSubscriptionID(channel, group, topicPrefix string) string {
	topic := TopicID(channel, topicPrefix)
	if group == channel {
		return topic
	}
	id := topic + "." + unsafeRE.ReplaceAllString(group, "_")
	if len(id) > 255 {
		id = id[:255]
	}
	return id
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// PubSubConfig returns the full driver configuration.
func (d *Driver) PubSubConfig() Config { return d.cfg }

func (d *Driver) topicName(id string) string { return "projects/" + d.cfg.ProjectID + "/topics/" + id }
func (d *Driver) subName(id string) string {
	return "projects/" + d.cfg.ProjectID + "/subscriptions/" + id
}

// Connect implements transport.Driver: an insecure, unauthenticated channel to
// the emulator (or the real client with AllowCloud), proven by one list call.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("pubsub: driver closed: %w", transport.ErrNotConnected)
	}
	if d.client != nil {
		return nil
	}
	if d.cfg.ProjectID == "" {
		return errors.New("pubsub: a project id is needed")
	}
	if d.cfg.EmulatorHost == "" && !d.cfg.AllowCloud {
		return errors.New("pubsub: an emulator host is needed (127.0.0.1:58085) unless AllowCloud is set")
	}
	if d.cfg.EmulatorHost != "" && cloudRE.MatchString(d.cfg.EmulatorHost) {
		return fmt.Errorf("pubsub: emulator host %q is the real service; set AllowCloud and no emulator host for that", d.cfg.EmulatorHost)
	}
	var opts []option.ClientOption
	if d.cfg.EmulatorHost != "" {
		opts = []option.ClientOption{
			option.WithEndpoint(d.cfg.EmulatorHost), option.WithoutAuthentication(), option.WithTelemetryDisabled(),
			option.WithGRPCDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())),
		}
	}
	client, err := gpubsub.NewClient(ctx, d.cfg.ProjectID, opts...)
	if err != nil {
		return fmt.Errorf("pubsub: client: %w", err)
	}
	probe, cancel := context.WithTimeout(ctx, d.cfg.ConnectTimeout)
	defer cancel()
	it := client.TopicAdminClient.ListTopics(probe, &pubsubpb.ListTopicsRequest{Project: "projects/" + d.cfg.ProjectID, PageSize: 1})
	if _, err := it.Next(); err != nil && !isIteratorDone(err) {
		_ = client.Close()
		where := d.cfg.EmulatorHost
		if where == "" {
			where = "pubsub.googleapis.com"
		}
		return fmt.Errorf("pubsub: %s (project %s) is not reachable: %w", where, d.cfg.ProjectID, err)
	}
	d.client = client
	return nil
}

func isIteratorDone(err error) bool { return err != nil && err.Error() == "no more items in iterator" }

func isCode(err error, c codes.Code) bool {
	if s, ok := status.FromError(err); ok {
		return s.Code() == c
	}
	return false
}

func (d *Driver) conn() (*gpubsub.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client == nil || d.closed {
		return nil, fmt.Errorf("pubsub: %w", transport.ErrNotConnected)
	}
	return d.client, nil
}

func (d *Driver) ensureTopic(ctx context.Context, client *gpubsub.Client, channel string) (string, error) {
	id := TopicID(channel, d.cfg.TopicPrefix)
	d.mu.Lock()
	known := d.topics[channel]
	d.mu.Unlock()
	if known {
		return id, nil
	}
	if _, err := client.TopicAdminClient.CreateTopic(ctx, &pubsubpb.Topic{Name: d.topicName(id)}); err != nil && !isCode(err, codes.AlreadyExists) {
		return "", fmt.Errorf("pubsub: create topic %s: %w", id, err)
	}
	d.mu.Lock()
	d.topics[channel] = true
	d.mu.Unlock()
	return id, nil
}

func (d *Driver) ensureSharedSubscription(ctx context.Context, client *gpubsub.Client, channel, group string) (string, error) {
	id := SharedSubscriptionID(channel, group, d.cfg.TopicPrefix)
	d.mu.Lock()
	known := d.subsDecl[id]
	spec := d.specs[channel]
	d.mu.Unlock()
	if known {
		return id, nil
	}
	topicID, err := d.ensureTopic(ctx, client, channel)
	if err != nil {
		return "", err
	}
	sub := &pubsubpb.Subscription{
		Name: d.subName(id), Topic: d.topicName(topicID),
		AckDeadlineSeconds:       int32(d.cfg.AckDeadline / time.Second),
		EnableMessageOrdering:    true,
		MessageRetentionDuration: durationpb.New(d.cfg.Retention),
	}
	// Instance subscriptions die with their process; request subscriptions never expire on their own.
	if spec.Role == transport.RoleInstance {
		sub.ExpirationPolicy = &pubsubpb.ExpirationPolicy{Ttl: durationpb.New(24 * time.Hour)}
	} else {
		sub.ExpirationPolicy = &pubsubpb.ExpirationPolicy{}
	}
	if !d.cfg.NoDeadLetter {
		dlq := d.topicName(topicID + dlqSuffix)
		if _, err := client.TopicAdminClient.CreateTopic(ctx, &pubsubpb.Topic{Name: dlq}); err != nil && !isCode(err, codes.AlreadyExists) {
			return "", fmt.Errorf("pubsub: create dead-letter topic of %s: %w", channel, err)
		}
		sub.DeadLetterPolicy = &pubsubpb.DeadLetterPolicy{DeadLetterTopic: dlq, MaxDeliveryAttempts: int32(d.cfg.MaxDeliveryAttempts)}
	}
	if _, err := client.SubscriptionAdminClient.CreateSubscription(ctx, sub); err != nil && !isCode(err, codes.AlreadyExists) {
		return "", fmt.Errorf("pubsub: create subscription %s: %w", id, err)
	}
	d.mu.Lock()
	d.subsDecl[id] = true
	d.mu.Unlock()
	return id, nil
}

// Declare implements transport.Driver: every channel gets its topic, shared ones their group subscription.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	for _, spec := range channels {
		d.mu.Lock()
		d.specs[spec.Name] = spec
		if spec.Role == transport.RoleInstance || spec.Role == transport.RoleReply {
			d.owned[spec.Name] = true
		}
		d.mu.Unlock()
		if _, err := d.ensureTopic(ctx, client, spec.Name); err != nil {
			return err
		}
		if spec.Delivery == transport.DeliveryShared {
			if _, err := d.ensureSharedSubscription(ctx, client, spec.Name, spec.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

func (d *Driver) publisher(client *gpubsub.Client, topicID string) *gpubsub.Publisher {
	d.mu.Lock()
	defer d.mu.Unlock()
	if p, ok := d.pubs[topicID]; ok {
		return p
	}
	p := client.Publisher(topicID)
	p.EnableMessageOrdering = true
	p.PublishSettings.DelayThreshold = 2 * time.Millisecond
	d.pubs[topicID] = p
	return p
}

// Publish implements transport.Driver.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	client, err := d.conn()
	if err != nil {
		return "", err
	}
	topicID, err := d.ensureTopic(ctx, client, channel)
	if err != nil {
		return "", err
	}
	p := d.publisher(client, topicID)
	msg := &gpubsub.Message{Data: event.Body, Attributes: transport.PrefixHeaders(event.Headers, HeaderPrefix), OrderingKey: opts.OrderingKey}
	if _, err := p.Publish(ctx, msg).Get(ctx); err != nil {
		if opts.OrderingKey != "" {
			p.ResumePublish(opts.OrderingKey) // a failed ordered publish pauses the key
		}
		return "", fmt.Errorf("pubsub: publish to %s: %w", channel, err)
	}
	return transport.Accepted, nil
}

func newConsumerID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	client, err := d.conn()
	if err != nil {
		return nil, err
	}
	prefetch := max(opts.Prefetch, 1)
	var (
		id      string
		manual  = opts.Group != "" && opts.AckMode != transport.AckAuto
		onClose func(context.Context)
	)
	if opts.Group != "" {
		id, err = d.ensureSharedSubscription(ctx, client, channel, opts.Group)
		if err != nil {
			return nil, err
		}
	} else {
		topicID, err := d.ensureTopic(ctx, client, channel)
		if err != nil {
			return nil, err
		}
		id = topicID + broadcastInfix + newConsumerID()
		if len(id) > 255 {
			id = id[:255]
		}
		sub := &pubsubpb.Subscription{
			Name: d.subName(id), Topic: d.topicName(topicID), AckDeadlineSeconds: 10,
			MessageRetentionDuration: durationpb.New(10 * time.Minute), ExpirationPolicy: &pubsubpb.ExpirationPolicy{Ttl: durationpb.New(24 * time.Hour)},
		}
		if _, err := client.SubscriptionAdminClient.CreateSubscription(ctx, sub); err != nil {
			return nil, fmt.Errorf("pubsub: create subscription %s: %w", id, err)
		}
		name := sub.Name
		onClose = func(ctx context.Context) {
			_ = client.SubscriptionAdminClient.DeleteSubscription(ctx, &pubsubpb.DeleteSubscriptionRequest{Subscription: name})
		}
	}
	subscriber := client.Subscriber(id)
	// The client counts a message as outstanding until its callback returns (not until it is acked), so in manual mode the
	// callback blocks until the delivery is settled and prefetch is honoured. Auto-ack (broadcast) subscriptions take one
	// message at a time and ack it after the handler returns, so every consumer sees events in publish order; the client
	// would otherwise run callbacks concurrently.
	subscriber.ReceiveSettings.MaxOutstandingMessages = prefetch
	if !manual {
		subscriber.ReceiveSettings.MaxOutstandingMessages = 1
	}
	subscriber.ReceiveSettings.MaxOutstandingBytes = -1
	subscriber.ReceiveSettings.NumGoroutines = 1
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{channel: channel, cancel: cancel, done: make(chan struct{}), handler: handler, manual: manual, inFlight: map[*gpubsub.Message]bool{}, onClose: onClose, d: d}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	go func() {
		defer close(s.done)
		for runCtx.Err() == nil {
			err := subscriber.Receive(runCtx, s.receive)
			if runCtx.Err() != nil || err == nil {
				return
			}
			if isCode(err, codes.NotFound) {
				return // the subscription was deleted under us: nothing more will arrive
			}
			select {
			case <-runCtx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}()
	return s, nil
}

// DeleteChannels removes the topics and subscriptions of channels (tests and
// operators), dead-letter topics and per-consumer subscriptions included.
func (d *Driver) DeleteChannels(ctx context.Context, channels ...string) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	for _, channel := range channels {
		topicID := TopicID(channel, d.cfg.TopicPrefix)
		for _, id := range []string{topicID, topicID + dlqSuffix} {
			it := client.TopicAdminClient.ListTopicSubscriptions(ctx, &pubsubpb.ListTopicSubscriptionsRequest{Topic: d.topicName(id)})
			for {
				name, err := it.Next()
				if err != nil {
					break
				}
				_ = client.SubscriptionAdminClient.DeleteSubscription(ctx, &pubsubpb.DeleteSubscriptionRequest{Subscription: name})
			}
			_ = client.TopicAdminClient.DeleteTopic(ctx, &pubsubpb.DeleteTopicRequest{Topic: d.topicName(id)})
		}
		d.mu.Lock()
		delete(d.topics, channel)
		d.mu.Unlock()
	}
	return nil
}

// DeleteByPrefix removes every subscription and topic of the project whose id starts with idPrefix (tests and operators:
// a run's channel prefix; the emulator never expires anything).
func (d *Driver) DeleteByPrefix(ctx context.Context, idPrefix string) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	project := "projects/" + d.cfg.ProjectID
	subs := client.SubscriptionAdminClient.ListSubscriptions(ctx, &pubsubpb.ListSubscriptionsRequest{Project: project})
	for {
		sub, err := subs.Next()
		if err != nil {
			break
		}
		if strings.HasPrefix(sub.Name, project+"/subscriptions/"+idPrefix) {
			_ = client.SubscriptionAdminClient.DeleteSubscription(ctx, &pubsubpb.DeleteSubscriptionRequest{Subscription: sub.Name})
		}
	}
	topics := client.TopicAdminClient.ListTopics(ctx, &pubsubpb.ListTopicsRequest{Project: project})
	for {
		topic, err := topics.Next()
		if err != nil {
			break
		}
		if strings.HasPrefix(topic.Name, project+"/topics/"+idPrefix) {
			_ = client.TopicAdminClient.DeleteTopic(ctx, &pubsubpb.DeleteTopicRequest{Topic: topic.Name})
		}
	}
	return nil
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	client := d.client
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	pubs := make([]*gpubsub.Publisher, 0, len(d.pubs))
	for _, p := range d.pubs {
		pubs = append(pubs, p)
	}
	d.subs = map[*subscription]struct{}{}
	d.pubs = map[string]*gpubsub.Publisher{}
	d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range subs {
		_ = s.Close(ctx)
	}
	for _, p := range pubs {
		p.Stop()
	}
	// Instance and reply channels belong to this process: nobody else will ever consume them.
	d.mu.Lock()
	owned := make([]string, 0, len(d.owned))
	for channel := range d.owned {
		owned = append(owned, channel)
	}
	d.closed = false // DeleteChannels needs the client for a moment
	d.mu.Unlock()
	_ = d.DeleteChannels(ctx, owned...)
	d.mu.Lock()
	d.closed = true
	d.client = nil
	d.mu.Unlock()
	if client != nil {
		return client.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions and deliveries
// ---------------------------------------------------------------------------

type subscription struct {
	d       *Driver
	channel string
	cancel  context.CancelFunc
	done    chan struct{}
	handler transport.Handler
	manual  bool
	closed  atomic.Bool
	onClose func(context.Context)

	mu       sync.Mutex
	inFlight map[*gpubsub.Message]bool
}

func (s *subscription) Channel() string { return s.channel }

func (s *subscription) receive(ctx context.Context, m *gpubsub.Message) {
	if s.closed.Load() {
		m.Nack()
		return
	}
	attempt := 1
	if m.DeliveryAttempt != nil && *m.DeliveryAttempt > 0 {
		attempt = *m.DeliveryAttempt
	}
	del := &delivery{s: s, m: m, attempt: attempt, settledCh: make(chan struct{})}
	event := transport.WireEvent{Headers: transport.UnprefixHeaders(m.Attributes, HeaderPrefix), Body: m.Data}
	if !s.manual {
		del.settled.Store(true)
		s.handler(ctx, event, del)
		m.Ack()
		return
	}
	s.mu.Lock()
	s.inFlight[m] = true
	s.mu.Unlock()
	s.handler(ctx, event, del)
	// The handler may hold the delivery past its return (at least once); the slot stays taken until it settles.
	select {
	case <-del.settledCh:
	case <-ctx.Done():
	}
}

// Close stops receiving and nacks what it holds, so another consumer takes it at once.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	s.mu.Lock()
	held := make([]*gpubsub.Message, 0, len(s.inFlight))
	for m := range s.inFlight {
		held = append(held, m)
	}
	s.inFlight = map[*gpubsub.Message]bool{}
	s.mu.Unlock()
	for _, m := range held {
		m.Nack()
	}
	s.cancel()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	if s.onClose != nil {
		dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dcancel()
		s.onClose(dctx)
	}
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	return nil
}

type delivery struct {
	s         *subscription
	m         *gpubsub.Message
	attempt   int
	settled   atomic.Bool
	settledCh chan struct{} // closed on the first Ack or Nack
}

func (d *delivery) Attempt() int { return d.attempt }

func (d *delivery) settle() bool {
	if !d.settled.CompareAndSwap(false, true) {
		return false
	}
	d.s.mu.Lock()
	delete(d.s.inFlight, d.m)
	d.s.mu.Unlock()
	close(d.settledCh)
	return true
}

// Ack acknowledges the message.
func (d *delivery) Ack(context.Context) error {
	if d.settle() {
		d.m.Ack()
	}
	return nil
}

// Nack: with requeue the message is nacked (redelivered at once); without, it is acked.
func (d *delivery) Nack(_ context.Context, requeue bool) error {
	if d.settle() {
		if requeue {
			d.m.Nack()
		} else {
			d.m.Ack()
		}
	}
	return nil
}

var _ transport.Driver = (*Driver)(nil)
