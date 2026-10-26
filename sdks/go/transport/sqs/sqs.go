// Package sqs is the Amazon SQS driver of sdks/go/transport (docs/transports.md
// "Brokers", docs/protocol.md §14.9), built on aws-sdk-go-v2. It is
// wire-compatible with the TypeScript driver (@landflow/transports/sqs):
//
//   - Local only by default: the config names an explicit endpoint
//     (http://127.0.0.1:54566 for LocalStack) and static credentials (test/test
//     when none are given). The AWS default endpoint and credential chain
//     (~/.aws, instance roles) are used only with AllowAWS and no static
//     credentials; without an endpoint and without AllowAWS the driver refuses.
//   - A shared channel is one standard queue (`<QueuePrefix><channel>` with
//     "." → "_", names over 80 characters shortened with a hash). Consumers
//     long-poll it with MaxNumberOfMessages = free prefetch slots (at most 10);
//     a received message is invisible for VisibilityTimeout and in-flight
//     deliveries extend it, so a slow call is not redelivered. Ack =
//     DeleteMessage; a nack with requeue and a closing consumer =
//     ChangeMessageVisibility 0 (immediate redelivery); the attempt is
//     ApproximateReceiveCount. Standard queues, not FIFO (no ordering keys).
//   - Broadcast channels (reply, registry, control) have no fan-out in SQS:
//     every consumer creates a queue of its own (`<queue>--bc-<consumerId>`,
//     retention = the channel TTL, deleted on Close) and a publisher sends the
//     event to every queue listed under that prefix (ListQueues, cached for
//     FanoutRefresh).
//   - Mode: structured (Headers false; SQS allows 10 message attributes). The
//     driver carries `content-type` and, when the body is not valid SQS text,
//     `lf-encoding: base64` (`empty` for an empty body).
//   - Size: 1 MiB (MaximumMessageSize is set on every queue the driver
//     creates). No per-message TTL; queues get a retention period. Stats
//     reports depth (ApproximateNumberOfMessages); SQS cannot count consumers,
//     so Undeliverable is unknown.
//
// This package is its own Go module so sdks/go stays free of the AWS SDK. Code
// use: sqs.New(sqs.Config{Endpoint: "http://127.0.0.1:54566"}); env use:
// blank-import the package and set LANDFLOW_SQS_URL=http://127.0.0.1:54566
// (plus LANDFLOW_SQS_REGION, _USERNAME / _PASSWORD as the access key id and
// secret, _ENDPOINT, _ALLOWAWS=true, _QUEUEPREFIX, _PREFIX).
package sqs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
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
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "sqs"

const (
	// MaxMessageBytes is SQS's maximum message size (1 MiB since 2025; the per-queue default is still 256 KiB).
	MaxMessageBytes = 1 << 20
	// DefaultRegion is used when none is configured.
	DefaultRegion = "us-east-1"
	// DummyAccessKey / DummySecretKey are what LocalStack accepts; used when an endpoint is set and no credentials are given.
	DummyAccessKey = "test"
	DummySecretKey = "test"

	queueNameMax         = 80
	broadcastInfix       = "--bc-"
	contentTypeAttribute = "content-type"
	encodingAttribute    = "lf-encoding"
	minRetention         = 60 * time.Second
	maxRetention         = 14 * 24 * time.Hour
)

// Config configures an SQS driver.
type Config struct {
	transport.Config
	// Endpoint is the SQS endpoint ("http://127.0.0.1:54566" for LocalStack,
	// "https://sqs.<region>.amazonaws.com"). Empty only with AllowAWS.
	Endpoint string
	// Region (default us-east-1).
	Region string
	// AccessKeyID / SecretAccessKey / SessionToken are static credentials;
	// test/test when absent and an endpoint is set. The default chain is used
	// only with AllowAWS and no credentials.
	AccessKeyID, SecretAccessKey, SessionToken string
	// AllowAWS opts in to the AWS default endpoint and credential chain. Never set in tests.
	AllowAWS bool
	// QueuePrefix is prepended to every queue name (default none).
	QueuePrefix string
	// MaxMessageBytes the driver accepts (default and maximum 1 MiB); also the
	// MaximumMessageSize of queues it creates.
	MaxMessageBytes int
	// VisibilityTimeout is how long a received message stays invisible (default
	// 30 s); in-flight deliveries extend it. Redelivery after a hard crash waits this long.
	VisibilityTimeout time.Duration
	// WaitTime is the ReceiveMessage long-poll wait (default 5 s, at most 20 s).
	// A closing subscription waits for its poll in flight (cancelling it would
	// let the server hand the poll a message nobody tracks), so Close takes up
	// to this long.
	WaitTime time.Duration
	// Retention is the MessageRetentionPeriod of request and instance queues
	// (default 1 h, at least 60 s). Broadcast queues use the channel TTL.
	Retention time.Duration
	// FanoutRefresh is how long a publisher caches the list of a broadcast channel's consumer queues (default 2 s).
	FanoutRefresh time.Duration
}

// Driver is one SQS client.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu     sync.Mutex
	client *awssqs.Client
	closed bool
	specs  map[string]transport.ChannelSpec
	urls   map[string]string          // queue URL by shared channel
	local  map[string]map[string]bool // this driver's own broadcast queues by channel
	fanout map[string]*fanoutEntry    // listed broadcast queues by channel
	subs   map[*subscription]struct{}
	owned  map[string]bool // instance channels this driver declared: their queues die with the process (Close deletes them)
}

type fanoutEntry struct {
	at   time.Time
	urls map[string]bool
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.Region == "" {
		cfg.Region = DefaultRegion
	}
	if cfg.MaxMessageBytes <= 0 || cfg.MaxMessageBytes > MaxMessageBytes {
		cfg.MaxMessageBytes = MaxMessageBytes
	}
	if cfg.VisibilityTimeout <= 0 {
		cfg.VisibilityTimeout = 30 * time.Second
	}
	if cfg.WaitTime <= 0 {
		cfg.WaitTime = 5 * time.Second
	}
	if cfg.WaitTime > 20*time.Second {
		cfg.WaitTime = 20 * time.Second
	}
	if cfg.Retention <= 0 {
		cfg.Retention = time.Hour
	}
	if cfg.FanoutRefresh <= 0 {
		cfg.FanoutRefresh = 2 * time.Second
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
			Latency:         transport.LatencyHigh,
			Headers:         false,
			OrderingKeys:    false,
			Nack:            true,
			Attempts:        true,
		},
		specs: map[string]transport.ChannelSpec{}, urls: map[string]string{}, local: map[string]map[string]bool{},
		fanout: map[string]*fanoutEntry{}, subs: map[*subscription]struct{}{}, owned: map[string]bool{},
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

var regionRE = regexp.MustCompile(`^[a-z]{2}(-[a-z]+)+-\d$`)

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// ConfigFromURL builds a Config from a connection URL and options. The URL is
// the endpoint ("http://127.0.0.1:54566", "https://sqs.eu-west-1.amazonaws.com",
// or "sqs://host:port", plain HTTP unless opts.TLS); "sqs://aws[/<region>]"
// means the AWS default endpoint and needs the field allowaws. Fields: region
// (also ?region= on the URL; default us-east-1), endpoint (wins over the URL),
// allowaws, queueprefix; Username/Password are the access key id and secret.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	raw := strings.TrimSpace(rawURL)
	cfg := Config{Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}, Region: DefaultRegion}
	var parsed *url.URL
	if raw != "" {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme == "" {
			return Config{}, fmt.Errorf("sqs: URL %q must be the endpoint, http://127.0.0.1:54566 (LocalStack) or https://sqs.<region>.amazonaws.com", rawURL)
		}
		switch u.Scheme {
		case "http", "https", "sqs":
		default:
			return Config{}, fmt.Errorf("sqs: URL %q must use http://, https:// or sqs://", rawURL)
		}
		parsed = u
	}
	cfg.AllowAWS = truthy(opts.Fields["allowaws"])
	endpoint := strings.TrimSpace(opts.Fields["endpoint"])
	if endpoint == "" && parsed != nil && parsed.Hostname() != "" && !(parsed.Scheme == "sqs" && parsed.Hostname() == "aws") {
		if parsed.Scheme == "sqs" {
			scheme := "http"
			if opts.TLS {
				scheme = "https"
			}
			endpoint = scheme + "://" + parsed.Host
		} else {
			endpoint = parsed.Scheme + "://" + parsed.Host + strings.TrimSuffix(parsed.Path, "/")
		}
	}
	if endpoint != "" {
		u, err := url.Parse(endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
			return Config{}, fmt.Errorf("sqs: endpoint %q must be an http:// or https:// URL", endpoint)
		}
		cfg.Endpoint = endpoint
	} else if !cfg.AllowAWS {
		return Config{}, errors.New("sqs: an explicit endpoint is needed (http://127.0.0.1:54566 for LocalStack): the default AWS endpoint is used only with allowaws")
	}
	region := strings.TrimSpace(opts.Fields["region"])
	if region == "" && parsed != nil {
		region = parsed.Query().Get("region")
		if region == "" && parsed.Scheme == "sqs" && parsed.Hostname() == "aws" {
			region = strings.Trim(parsed.Path, "/")
		}
	}
	if region != "" {
		cfg.Region = region
	}
	if !regionRE.MatchString(cfg.Region) {
		return Config{}, fmt.Errorf("sqs: region %q must look like us-east-1", cfg.Region)
	}
	if (opts.Username == "") != (opts.Password == "") {
		return Config{}, errors.New("sqs: credentials need both an access key id (username) and a secret access key (password)")
	}
	cfg.AccessKeyID, cfg.SecretAccessKey = opts.Username, opts.Password
	cfg.SessionToken = opts.Fields["sessiontoken"]
	cfg.QueuePrefix = strings.TrimSpace(opts.Fields["queueprefix"])
	if v := opts.Fields["maxmessagebytes"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 || n > MaxMessageBytes {
			return Config{}, fmt.Errorf("sqs: maxmessagebytes %q must be 1..%d", v, MaxMessageBytes)
		}
		cfg.MaxMessageBytes = n
	}
	for name, dst := range map[string]*time.Duration{"visibilitytimeoutseconds": &cfg.VisibilityTimeout, "waittimeseconds": &cfg.WaitTime, "retentionseconds": &cfg.Retention} {
		if v := opts.Fields[name]; v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				*dst = time.Duration(n) * time.Second
			}
		}
	}
	if v := opts.Fields["fanoutrefreshms"]; v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.FanoutRefresh = time.Duration(n) * time.Millisecond
		}
	}
	return cfg, nil
}

// fit shortens a queue name to max characters, keeping a readable head and a hash of the whole.
func fit(name string, max int) string {
	if len(name) <= max {
		return name
	}
	sum := sha256.Sum256([]byte(name))
	hash := hex.EncodeToString(sum[:])[:16]
	return name[:max-len(hash)-1] + "-" + hash
}

var unsafeRE = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// QueueName is the queue name of a channel: [A-Za-z0-9_-]{1,80} ("." and other characters become "_").
func QueueName(channel, queuePrefix string) string {
	return fit(unsafeRE.ReplaceAllString(queuePrefix+channel, "_"), queueNameMax)
}

// BroadcastPrefix is the prefix shared by the per-consumer queues of a broadcast channel.
func BroadcastPrefix(channel, queuePrefix string) string {
	return fit(unsafeRE.ReplaceAllString(queuePrefix+channel, "_"), queueNameMax-len(broadcastInfix)-10) + broadcastInfix
}

// IsBroadcastChannel reports whether a channel is a broadcast one, from its
// role in the name (`<prefix>.v1.reply…`, `.registry`, `.control…`): a plugin
// publishes replies to a host's reply channel without ever declaring it, so
// the spec alone cannot tell. A declared spec wins.
func IsBroadcastChannel(channel string, spec transport.ChannelSpec, declared bool) bool {
	if declared {
		return spec.Delivery == transport.DeliveryBroadcast
	}
	marker := "." + transport.ChannelVersion + "."
	at := strings.Index(channel, marker)
	if at < 0 {
		return false
	}
	role, _, _ := strings.Cut(channel[at+len(marker):], ".")
	return role == string(transport.RoleReply) || role == string(transport.RoleRegistry) || role == string(transport.RoleControl)
}

// IsSQSText reports whether text can travel as an SQS message body (XML 1.0 characters only).
func IsSQSText(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		switch {
		case r == 0x9 || r == 0xa || r == 0xd:
		case r < 0x20, r > 0xd7ff && r < 0xe000, r == 0xfffe, r == 0xffff:
			return false
		}
	}
	return true
}

func stringAttr(v string) types.MessageAttributeValue {
	return types.MessageAttributeValue{DataType: aws.String("String"), StringValue: aws.String(v)}
}

// ToMessage encodes an event: the body as text when it is valid SQS text,
// else base64 with `lf-encoding: base64`; `content-type` as an attribute.
func ToMessage(event transport.WireEvent) (body string, attributes map[string]types.MessageAttributeValue) {
	attributes = map[string]types.MessageAttributeValue{}
	for name, value := range event.Headers {
		if strings.EqualFold(name, contentTypeAttribute) {
			attributes[contentTypeAttribute] = stringAttr(value)
		}
	}
	if len(event.Body) == 0 {
		attributes[encodingAttribute] = stringAttr("empty")
		return "-", attributes
	}
	if s := string(event.Body); IsSQSText(s) {
		return s, attributes
	}
	attributes[encodingAttribute] = stringAttr("base64")
	return base64.StdEncoding.EncodeToString(event.Body), attributes
}

// FromMessage is the inverse of ToMessage.
func FromMessage(body string, attributes map[string]types.MessageAttributeValue) transport.WireEvent {
	headers := map[string]string{}
	if ct, ok := attributes[contentTypeAttribute]; ok && ct.StringValue != nil {
		headers[contentTypeAttribute] = *ct.StringValue
	}
	encoding := ""
	if enc, ok := attributes[encodingAttribute]; ok && enc.StringValue != nil {
		encoding = *enc.StringValue
	}
	switch encoding {
	case "empty":
		return transport.WireEvent{Headers: headers, Body: []byte{}}
	case "base64":
		raw, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			raw = []byte(body)
		}
		return transport.WireEvent{Headers: headers, Body: raw}
	}
	return transport.WireEvent{Headers: headers, Body: []byte(body)}
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// SQSConfig returns the full driver configuration.
func (d *Driver) SQSConfig() Config { return d.cfg }

// Connect implements transport.Driver: it builds the client without touching
// the AWS default chain unless AllowAWS, and proves the endpoint answers.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("sqs: driver closed: %w", transport.ErrNotConnected)
	}
	if d.client != nil {
		return nil
	}
	if d.cfg.Endpoint == "" && !d.cfg.AllowAWS {
		return errors.New("sqs: an explicit endpoint is needed (http://127.0.0.1:54566 for LocalStack) unless AllowAWS is set")
	}
	var awsCfg aws.Config
	switch {
	case d.cfg.AccessKeyID != "" && d.cfg.SecretAccessKey != "":
		awsCfg = aws.Config{Region: d.cfg.Region, Credentials: credentials.NewStaticCredentialsProvider(d.cfg.AccessKeyID, d.cfg.SecretAccessKey, d.cfg.SessionToken)}
	case d.cfg.AllowAWS:
		loaded, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(d.cfg.Region))
		if err != nil {
			return fmt.Errorf("sqs: AWS configuration: %w", err)
		}
		awsCfg = loaded
	default:
		awsCfg = aws.Config{Region: d.cfg.Region, Credentials: credentials.NewStaticCredentialsProvider(DummyAccessKey, DummySecretKey, "")}
	}
	awsCfg.RetryMaxAttempts = 3
	if d.cfg.Endpoint != "" {
		awsCfg.BaseEndpoint = aws.String(d.cfg.Endpoint)
	}
	client := awssqs.NewFromConfig(awsCfg)
	probe, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := client.ListQueues(probe, &awssqs.ListQueuesInput{QueueNamePrefix: aws.String(QueueName(d.cfg.Prefix, d.cfg.QueuePrefix)), MaxResults: aws.Int32(1)}); err != nil {
		where := d.cfg.Endpoint
		if where == "" {
			where = "the AWS endpoint for " + d.cfg.Region
		}
		return fmt.Errorf("sqs: %s is not reachable: %w", where, err)
	}
	d.client = client
	return nil
}

func (d *Driver) conn() (*awssqs.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client == nil || d.closed {
		return nil, fmt.Errorf("sqs: %w", transport.ErrNotConnected)
	}
	return d.client, nil
}

// rewrite puts a queue URL onto the configured endpoint: LocalStack returns
// `sqs.<region>.localhost`, which does not resolve.
func (d *Driver) rewrite(queueURL string) string {
	if d.cfg.Endpoint == "" {
		return queueURL
	}
	base, err := url.Parse(d.cfg.Endpoint)
	if err != nil {
		return queueURL
	}
	u, err := url.Parse(queueURL)
	if err != nil {
		return queueURL
	}
	return base.Scheme + "://" + base.Host + strings.TrimSuffix(base.Path, "/") + u.Path
}

func isMissingQueue(err error) bool {
	var missing *types.QueueDoesNotExist
	return errors.As(err, &missing) || strings.Contains(err.Error(), "NonExistentQueue")
}

func isExistingQueue(err error) bool {
	var exists *types.QueueNameExists
	return errors.As(err, &exists) || strings.Contains(err.Error(), "QueueAlreadyExists")
}

func (d *Driver) queueURL(ctx context.Context, client *awssqs.Client, name string) (string, error) {
	out, err := client.GetQueueUrl(ctx, &awssqs.GetQueueUrlInput{QueueName: aws.String(name)})
	if err != nil {
		return "", err
	}
	return d.rewrite(aws.ToString(out.QueueUrl)), nil
}

func (d *Driver) createQueue(ctx context.Context, client *awssqs.Client, name string, attributes map[string]string) (string, error) {
	out, err := client.CreateQueue(ctx, &awssqs.CreateQueueInput{QueueName: aws.String(name), Attributes: attributes})
	if err != nil {
		if isExistingQueue(err) {
			return d.queueURL(ctx, client, name) // same name, other attributes: use it as is
		}
		return "", fmt.Errorf("sqs: create queue %s: %w", name, err)
	}
	return d.rewrite(aws.ToString(out.QueueUrl)), nil
}

func (d *Driver) queueAttributes(ttl, visibility time.Duration) map[string]string {
	retention := d.cfg.Retention
	if ttl > 0 {
		retention = ttl
	}
	retention = min(maxRetention, max(minRetention, retention))
	if visibility <= 0 {
		visibility = d.cfg.VisibilityTimeout
	}
	return map[string]string{
		"MaximumMessageSize":     strconv.Itoa(d.caps.MaxMessageBytes),
		"MessageRetentionPeriod": strconv.Itoa(int((retention + time.Second - 1) / time.Second)),
		"VisibilityTimeout":      strconv.Itoa(int((visibility + time.Second - 1) / time.Second)),
	}
}

// ensureQueue returns the URL of a shared channel's queue, creating the queue on first use.
func (d *Driver) ensureQueue(ctx context.Context, client *awssqs.Client, channel string) (string, error) {
	d.mu.Lock()
	cached, ok := d.urls[channel]
	spec := d.specs[channel]
	d.mu.Unlock()
	if ok {
		return cached, nil
	}
	u, err := d.createQueue(ctx, client, QueueName(channel, d.cfg.QueuePrefix), d.queueAttributes(spec.TTL, 0))
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	d.urls[channel] = u
	d.mu.Unlock()
	return u, nil
}

// Declare implements transport.Driver: shared channels get their queue now.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	for _, spec := range channels {
		d.mu.Lock()
		d.specs[spec.Name] = spec
		if spec.Role == transport.RoleInstance {
			d.owned[spec.Name] = true
		}
		d.mu.Unlock()
		if spec.Delivery == transport.DeliveryShared {
			if _, err := d.ensureQueue(ctx, client, spec.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

// fanoutURLs lists every per-consumer queue of a broadcast channel: this driver's own at once, the others as listed (cached).
func (d *Driver) fanoutURLs(ctx context.Context, client *awssqs.Client, channel string) ([]string, error) {
	d.mu.Lock()
	entry := d.fanout[channel]
	stale := entry == nil || time.Since(entry.at) > d.cfg.FanoutRefresh
	d.mu.Unlock()
	if stale {
		urls := map[string]bool{}
		var token *string
		for {
			out, err := client.ListQueues(ctx, &awssqs.ListQueuesInput{QueueNamePrefix: aws.String(BroadcastPrefix(channel, d.cfg.QueuePrefix)), MaxResults: aws.Int32(1000), NextToken: token})
			if err != nil {
				return nil, fmt.Errorf("sqs: list queues of %s: %w", channel, err)
			}
			for _, u := range out.QueueUrls {
				urls[d.rewrite(u)] = true
			}
			if out.NextToken == nil {
				break
			}
			token = out.NextToken
		}
		entry = &fanoutEntry{at: time.Now(), urls: urls}
		d.mu.Lock()
		d.fanout[channel] = entry
		d.mu.Unlock()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	all := map[string]bool{}
	for u := range entry.urls {
		all[u] = true
	}
	for u := range d.local[channel] {
		all[u] = true
	}
	out := make([]string, 0, len(all))
	for u := range all {
		out = append(out, u)
	}
	return out, nil
}

// Publish implements transport.Driver: SendMessage to the channel's queue, or
// to every consumer queue of a broadcast channel.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, _ transport.PublishOptions) (transport.PublishOutcome, error) {
	client, err := d.conn()
	if err != nil {
		return "", err
	}
	body, attributes := ToMessage(event)
	d.mu.Lock()
	spec, declared := d.specs[channel]
	d.mu.Unlock()
	if IsBroadcastChannel(channel, spec, declared) {
		urls, err := d.fanoutURLs(ctx, client, channel)
		if err != nil {
			return "", err
		}
		var wg sync.WaitGroup
		errs := make([]error, len(urls))
		for i, u := range urls {
			wg.Add(1)
			go func(i int, u string) {
				defer wg.Done()
				_, err := client.SendMessage(ctx, &awssqs.SendMessageInput{QueueUrl: aws.String(u), MessageBody: aws.String(body), MessageAttributes: attributes})
				if err != nil && isMissingQueue(err) {
					d.mu.Lock()
					if e := d.fanout[channel]; e != nil {
						delete(e.urls, u) // that consumer is gone
					}
					d.mu.Unlock()
					err = nil
				}
				errs[i] = err
			}(i, u)
		}
		wg.Wait()
		if err := errors.Join(errs...); err != nil {
			return "", fmt.Errorf("sqs: send to %s: %w", channel, err)
		}
		return transport.Accepted, nil
	}
	u, err := d.ensureQueue(ctx, client, channel)
	if err != nil {
		return "", err
	}
	if _, err := client.SendMessage(ctx, &awssqs.SendMessageInput{QueueUrl: aws.String(u), MessageBody: aws.String(body), MessageAttributes: attributes}); err != nil {
		return "", fmt.Errorf("sqs: send to %s: %w", channel, err)
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
		queueURL string
		manual   = opts.Group != "" && opts.AckMode != transport.AckAuto
		onClose  func(context.Context)
	)
	if opts.Group != "" {
		queueURL, err = d.ensureQueue(ctx, client, channel)
		if err != nil {
			return nil, err
		}
	} else {
		d.mu.Lock()
		ttl := d.specs[channel].TTL
		d.mu.Unlock()
		if ttl <= 0 {
			ttl = time.Minute
		}
		name := BroadcastPrefix(channel, d.cfg.QueuePrefix) + newConsumerID()
		queueURL, err = d.createQueue(ctx, client, name, d.queueAttributes(ttl, 5*time.Second))
		if err != nil {
			return nil, err
		}
		d.mu.Lock()
		if d.local[channel] == nil {
			d.local[channel] = map[string]bool{}
		}
		d.local[channel][queueURL] = true
		d.mu.Unlock()
		u := queueURL
		onClose = func(ctx context.Context) {
			d.mu.Lock()
			delete(d.local[channel], u)
			d.mu.Unlock()
			_, _ = client.DeleteQueue(ctx, &awssqs.DeleteQueueInput{QueueUrl: aws.String(u)})
		}
	}
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{
		d: d, client: client, channel: channel, url: queueURL, cancel: cancel, done: make(chan struct{}), handler: handler,
		prefetch: prefetch, manual: manual, slots: make(chan struct{}, prefetch), inFlight: map[string]string{}, onClose: onClose, stopping: make(chan struct{}),
	}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	go s.run(runCtx)
	return s, nil
}

// Stats implements transport.StatsReporter: ApproximateNumberOfMessages as depth; SQS cannot count consumers.
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	client, err := d.conn()
	if err != nil {
		return transport.ChannelStats{}, err
	}
	d.mu.Lock()
	u, ok := d.urls[channel]
	d.mu.Unlock()
	if !ok {
		u, err = d.queueURL(ctx, client, QueueName(channel, d.cfg.QueuePrefix))
		if err != nil {
			return transport.ChannelStats{Depth: transport.Int(0)}, nil
		}
	}
	out, err := client.GetQueueAttributes(ctx, &awssqs.GetQueueAttributesInput{QueueUrl: aws.String(u), AttributeNames: []types.QueueAttributeName{types.QueueAttributeNameApproximateNumberOfMessages}})
	if err != nil {
		if isMissingQueue(err) {
			return transport.ChannelStats{Depth: transport.Int(0)}, nil
		}
		return transport.ChannelStats{}, fmt.Errorf("sqs: queue attributes of %s: %w", channel, err)
	}
	depth, _ := strconv.Atoi(out.Attributes["ApproximateNumberOfMessages"])
	return transport.ChannelStats{Depth: transport.Int(depth)}, nil
}

// DeleteQueues removes the queues of channels (tests and operators): the shared queue and every per-consumer broadcast queue.
func (d *Driver) DeleteQueues(ctx context.Context, channels ...string) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	for _, channel := range channels {
		names := map[string]bool{QueueName(channel, d.cfg.QueuePrefix): true}
		out, err := client.ListQueues(ctx, &awssqs.ListQueuesInput{QueueNamePrefix: aws.String(BroadcastPrefix(channel, d.cfg.QueuePrefix))})
		if err == nil {
			for _, u := range out.QueueUrls {
				names[u[strings.LastIndex(u, "/")+1:]] = true
			}
		}
		for name := range names {
			if u, err := d.queueURL(ctx, client, name); err == nil {
				_, _ = client.DeleteQueue(ctx, &awssqs.DeleteQueueInput{QueueUrl: aws.String(u)})
			}
		}
		d.mu.Lock()
		delete(d.urls, channel)
		delete(d.fanout, channel)
		d.mu.Unlock()
	}
	return nil
}

// DeleteQueuesByPrefix removes every queue whose name starts with queueNamePrefix (tests and operators: a run's channel prefix).
func (d *Driver) DeleteQueuesByPrefix(ctx context.Context, queueNamePrefix string) error {
	client, err := d.conn()
	if err != nil {
		return err
	}
	var token *string
	for {
		out, err := client.ListQueues(ctx, &awssqs.ListQueuesInput{QueueNamePrefix: aws.String(queueNamePrefix), MaxResults: aws.Int32(1000), NextToken: token})
		if err != nil {
			return fmt.Errorf("sqs: list queues %s*: %w", queueNamePrefix, err)
		}
		for _, u := range out.QueueUrls {
			_, _ = client.DeleteQueue(ctx, &awssqs.DeleteQueueInput{QueueUrl: aws.String(d.rewrite(u))})
		}
		if out.NextToken == nil {
			return nil
		}
		token = out.NextToken
	}
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
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
	// Instance queues belong to this process: nobody else will ever consume them.
	d.mu.Lock()
	client := d.client
	var ownedURLs []string
	for channel := range d.owned {
		if u, ok := d.urls[channel]; ok {
			ownedURLs = append(ownedURLs, u)
		}
	}
	d.client = nil
	d.mu.Unlock()
	if client != nil {
		for _, u := range ownedURLs {
			_, _ = client.DeleteQueue(ctx, &awssqs.DeleteQueueInput{QueueUrl: aws.String(u)})
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions and deliveries
// ---------------------------------------------------------------------------

type subscription struct {
	d        *Driver
	client   *awssqs.Client
	channel  string
	url      string
	cancel   context.CancelFunc
	done     chan struct{}
	handler  transport.Handler
	prefetch int
	manual   bool
	slots    chan struct{}
	closed   atomic.Bool
	stopping chan struct{} // closed by Close: the loop ends after its poll in flight
	onClose  func(context.Context)
	keep     sync.WaitGroup // the keep-alive goroutine

	mu       sync.Mutex
	inFlight map[string]string // receipt handle by message id, held unacknowledged
}

func (s *subscription) Channel() string { return s.channel }

// changeVisibility sets the visibility of handles (at most 10 per call).
func (s *subscription) changeVisibility(ctx context.Context, handles []string, seconds int32) {
	for len(handles) > 0 {
		n := min(10, len(handles))
		entries := make([]types.ChangeMessageVisibilityBatchRequestEntry, n)
		for i, h := range handles[:n] {
			entries[i] = types.ChangeMessageVisibilityBatchRequestEntry{Id: aws.String(strconv.Itoa(i)), ReceiptHandle: aws.String(h), VisibilityTimeout: seconds}
		}
		_, _ = s.client.ChangeMessageVisibilityBatch(ctx, &awssqs.ChangeMessageVisibilityBatchInput{QueueUrl: aws.String(s.url), Entries: entries})
		handles = handles[n:]
	}
}

// Close stops polling (after the poll in flight, at most WaitTime, so the
// server cannot hand it what is released here) and makes what it holds visible
// to another consumer at once.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	close(s.stopping)
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	s.cancel()
	s.keep.Wait()
	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	s.mu.Lock()
	held := make([]string, 0, len(s.inFlight))
	for _, h := range s.inFlight {
		held = append(held, h)
	}
	s.inFlight = map[string]string{}
	s.mu.Unlock()
	s.changeVisibility(dctx, held, 0)
	if s.onClose != nil {
		s.onClose(dctx)
	}
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	return nil
}

func (s *subscription) run(ctx context.Context) {
	defer close(s.done)
	if s.manual {
		s.keep.Add(1)
		go s.keepAlive(ctx)
	}
	visibility := int32((s.d.cfg.VisibilityTimeout + time.Second - 1) / time.Second)
	wait := int32(s.d.cfg.WaitTime / time.Second)
	pollCtx := context.WithoutCancel(ctx) // a poll is never cancelled, only waited for (see Close)
	for !s.closed.Load() {
		free := s.prefetch - len(s.slots)
		if free <= 0 {
			select {
			case <-s.stopping:
				return
			case <-time.After(20 * time.Millisecond):
			}
			continue
		}
		out, err := s.client.ReceiveMessage(pollCtx, &awssqs.ReceiveMessageInput{
			QueueUrl: aws.String(s.url), MaxNumberOfMessages: int32(min(10, free)), WaitTimeSeconds: wait, VisibilityTimeout: visibility,
			MessageAttributeNames: []string{"All"}, MessageSystemAttributeNames: []types.MessageSystemAttributeName{types.MessageSystemAttributeNameApproximateReceiveCount},
		})
		if err != nil {
			if s.closed.Load() {
				return
			}
			if isMissingQueue(err) {
				return // the queue was deleted under us: nothing more will arrive
			}
			select {
			case <-s.stopping:
				return
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		if len(out.Messages) == 0 {
			continue
		}
		if s.closed.Load() {
			// Received while closing: give them back at once rather than after the visibility timeout.
			if s.manual {
				handles := make([]string, 0, len(out.Messages))
				for _, m := range out.Messages {
					handles = append(handles, aws.ToString(m.ReceiptHandle))
				}
				s.changeVisibility(pollCtx, handles, 0)
			}
			return
		}
		if !s.manual {
			// Auto ack: the broker forgets the messages before the handler sees them.
			msgs := out.Messages
			for len(msgs) > 0 {
				n := min(10, len(msgs))
				entries := make([]types.DeleteMessageBatchRequestEntry, n)
				for i, m := range msgs[:n] {
					entries[i] = types.DeleteMessageBatchRequestEntry{Id: aws.String(strconv.Itoa(i)), ReceiptHandle: m.ReceiptHandle}
				}
				_, _ = s.client.DeleteMessageBatch(context.WithoutCancel(ctx), &awssqs.DeleteMessageBatchInput{QueueUrl: aws.String(s.url), Entries: entries})
				msgs = msgs[n:]
			}
		}
		for _, m := range out.Messages {
			s.dispatch(ctx, m)
		}
	}
}

// keepAlive extends the visibility of the messages this consumer holds, so a slow call is not redelivered.
func (s *subscription) keepAlive(ctx context.Context) {
	defer s.keep.Done()
	every := max(time.Second, s.d.cfg.VisibilityTimeout/3)
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			handles := make([]string, 0, len(s.inFlight))
			for _, h := range s.inFlight {
				handles = append(handles, h)
			}
			s.mu.Unlock()
			if len(handles) > 0 && !s.closed.Load() {
				s.changeVisibility(context.WithoutCancel(ctx), handles, int32((s.d.cfg.VisibilityTimeout+time.Second-1)/time.Second))
			}
		}
	}
}

func (s *subscription) dispatch(ctx context.Context, m types.Message) {
	s.slots <- struct{}{}
	id := aws.ToString(m.MessageId)
	if id == "" {
		id = newConsumerID()
	}
	attempt := 1
	if n, err := strconv.Atoi(m.Attributes["ApproximateReceiveCount"]); err == nil && n > 0 {
		attempt = n
	}
	del := &delivery{s: s, id: id, handle: aws.ToString(m.ReceiptHandle), attempt: attempt}
	if s.manual {
		s.mu.Lock()
		s.inFlight[id] = del.handle
		s.mu.Unlock()
	} else {
		del.settled.Store(true)
		defer func() { <-s.slots }()
		s.handler(ctx, FromMessage(aws.ToString(m.Body), m.MessageAttributes), del)
		return
	}
	go s.handler(ctx, FromMessage(aws.ToString(m.Body), m.MessageAttributes), del)
}

type delivery struct {
	s       *subscription
	id      string
	handle  string
	attempt int
	settled atomic.Bool
}

func (d *delivery) Attempt() int { return d.attempt }

func (d *delivery) settle(ctx context.Context, fn func(ctx context.Context) error) error {
	if !d.settled.CompareAndSwap(false, true) {
		return nil
	}
	defer func() { <-d.s.slots }()
	d.s.mu.Lock()
	delete(d.s.inFlight, d.id)
	d.s.mu.Unlock()
	return fn(context.WithoutCancel(ctx))
}

// Ack: DeleteMessage.
func (d *delivery) Ack(ctx context.Context) error {
	return d.settle(ctx, func(ctx context.Context) error {
		_, err := d.s.client.DeleteMessage(ctx, &awssqs.DeleteMessageInput{QueueUrl: aws.String(d.s.url), ReceiptHandle: aws.String(d.handle)})
		if err != nil && !isMissingQueue(err) {
			return fmt.Errorf("sqs: delete message: %w", err)
		}
		return nil
	})
}

// Nack: with requeue the message becomes visible at once (ChangeMessageVisibility 0); without, it is deleted.
func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	if !requeue || d.s.closed.Load() {
		return d.Ack(ctx)
	}
	return d.settle(ctx, func(ctx context.Context) error {
		_, err := d.s.client.ChangeMessageVisibility(ctx, &awssqs.ChangeMessageVisibilityInput{QueueUrl: aws.String(d.s.url), ReceiptHandle: aws.String(d.handle), VisibilityTimeout: 0})
		if err != nil && !isMissingQueue(err) {
			return fmt.Errorf("sqs: requeue: %w", err)
		}
		return nil
	})
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
)
