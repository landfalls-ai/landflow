package servicebus

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
)

// retryBackoff are the pauses between the attempts of an operation the namespace pushed back on (ServiceBusy, error 50002 "being
// throttled", a timeout): 8 retries, 200 ms doubling to 2 s, about 11 s in all. Same schedule as the TypeScript driver.
var retryBackoff = []time.Duration{200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, 1600 * time.Millisecond,
	2 * time.Second, 2 * time.Second, 2 * time.Second, 2 * time.Second}

// EmulatorOpsPerSecond and EmulatorMsPerKiB are the load the driver paces itself to on the emulator (a real namespace is not paced).
// The emulator throttles the whole namespace ("error 50002, wait 10 seconds") above roughly 100 small operations a second, but only
// 4 to 5 messages of 64 KiB a second (about 10 ms plus 1.4 ms per KiB per operation), and a throttle episode stalls every caller for
// 3 to 12 s; smooth pacing costs milliseconds instead. The defaults leave a margin: 25 ms plus 2 ms per KiB.
const (
	EmulatorOpsPerSecond = 40
	EmulatorMsPerKiB     = 2
)

// isTransient reports an error worth another try: throttling, a timeout or a lost connection (a missing entity, a locked session or a lost
// message lock are not).
func isTransient(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var sbErr *azservicebus.Error
	if errors.As(err, &sbErr) {
		switch sbErr.Code {
		case azservicebus.CodeTimeout, azservicebus.CodeConnectionLost:
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "server-busy") || strings.Contains(msg, "throttled") || strings.Contains(msg, "servicebusy")
}

// withBackoff runs op, retrying transient failures on retryBackoff (jittered) until ctx ends.
func withBackoff(ctx context.Context, op func() error) error {
	for attempt := 0; ; attempt++ {
		err := op()
		if err == nil || attempt >= len(retryBackoff) || !isTransient(err) || ctx.Err() != nil {
			return err
		}
		wait := time.Duration(float64(retryBackoff[attempt]) * (0.75 + rand.Float64()*0.5))
		select {
		case <-ctx.Done():
			return err
		case <-time.After(wait):
		}
	}
}

// settleRetry settles a delivery through the pacer, retrying a throttled settlement (a failed one leaves the message to redeliver once its lock lapses).
func (d *Driver) settleRetry(ctx context.Context, size int, op func(context.Context) error) error {
	return withBackoff(ctx, func() error {
		if err := d.gate.take(ctx, size); err != nil {
			return err
		}
		return op(ctx)
	})
}

// describeError names the cause of an error the library returns with an empty or opaque message.
func describeError(err error) error {
	if err == nil {
		return nil
	}
	var sbErr *azservicebus.Error
	if errors.As(err, &sbErr) {
		return fmt.Errorf("[%s] %w", sbErr.Code, err)
	}
	return err
}

// rateGate paces operations to a rate with a small burst (a leaky bucket); a rate <= 0 disables it.
type rateGate struct {
	mu       sync.Mutex
	next     time.Time
	interval time.Duration
	burst    time.Duration
	perKiB   time.Duration
}

func newRateGate(perSecond, burst int, msPerKiB float64) *rateGate {
	g := &rateGate{perKiB: time.Duration(msPerKiB * float64(time.Millisecond))}
	if perSecond > 0 {
		g.interval = time.Second / time.Duration(perSecond)
		g.burst = g.interval * time.Duration(max(1, burst))
	}
	return g
}

// take waits for the next slot; an operation costs one interval plus perKiB for every KiB it moves.
func (g *rateGate) take(ctx context.Context, size int) error {
	if g == nil || g.interval == 0 {
		return nil
	}
	g.mu.Lock()
	now := time.Now()
	if floor := now.Add(-g.burst); g.next.Before(floor) {
		g.next = floor
	}
	g.next = g.next.Add(g.interval + time.Duration(float64(g.perKiB)*float64(size)/1024))
	wait := g.next.Sub(now)
	g.mu.Unlock()
	if wait <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(wait):
		return nil
	}
}
