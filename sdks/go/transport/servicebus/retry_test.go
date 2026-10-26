package servicebus

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

func TestIsTransient(t *testing.T) {
	for msg, want := range map[string]bool{
		"The request was terminated because the namespace is being throttled. Error code : 50002": true,
		"amqp: com.microsoft:server-busy": true,
		"entity not found":                false,
	} {
		if got := isTransient(errors.New(msg)); got != want {
			t.Errorf("isTransient(%q) = %v, want %v", msg, got, want)
		}
	}
	if isTransient(context.Canceled) || isTransient(nil) {
		t.Error("cancellation and nil are not transient")
	}
}

func TestWithBackoffRetriesThrottlingOnly(t *testing.T) {
	saved := retryBackoff
	retryBackoff = []time.Duration{time.Millisecond, time.Millisecond}
	defer func() { retryBackoff = saved }()
	busy := errors.New("namespace is being throttled")
	calls := 0
	if err := withBackoff(context.Background(), func() error {
		calls++
		if calls < 3 {
			return busy
		}
		return nil
	}); err != nil || calls != 3 {
		t.Fatalf("want success on the 3rd call, got err=%v calls=%d", err, calls)
	}
	calls = 0
	if err := withBackoff(context.Background(), func() error { calls++; return busy }); !errors.Is(err, busy) || calls != 3 {
		t.Fatalf("want the throttle error after 3 calls, got err=%v calls=%d", err, calls)
	}
	calls = 0
	gone := errors.New("entity not found")
	if err := withBackoff(context.Background(), func() error { calls++; return gone }); !errors.Is(err, gone) || calls != 1 {
		t.Fatalf("a permanent error is not retried, got err=%v calls=%d", err, calls)
	}
}

func TestRateGatePaces(t *testing.T) {
	g := newRateGate(100, 4, 0) // 10 ms apart, 4 free
	start := time.Now()
	for i := 0; i < 14; i++ {
		if err := g.take(context.Background(), 0); err != nil {
			t.Fatal(err)
		}
	}
	if d := time.Since(start); d < 85*time.Millisecond {
		t.Errorf("14 takes at 100/s with a burst of 4 took %v, want >= ~100ms", d)
	}
	off := newRateGate(0, 4, 1.2)
	start = time.Now()
	for i := 0; i < 1000; i++ {
		_ = off.take(context.Background(), 65536)
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Error("a gate at 0 must not wait")
	}
}

func TestMaxOpsPerSecondDefaults(t *testing.T) {
	emu := New(Config{ConnectionString: "Endpoint=sb://127.0.0.1:55675;SharedAccessKeyName=n;SharedAccessKey=k;UseDevelopmentEmulator=true;"})
	if emu.gate.interval != time.Second/EmulatorOpsPerSecond {
		t.Errorf("emulator pace = %v", emu.gate.interval)
	}
	real := New(Config{ConnectionString: "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=n;SharedAccessKey=k;"})
	if real.gate.interval != 0 {
		t.Errorf("a real namespace is not paced, got %v", real.gate.interval)
	}
	cfg, err := ConfigFromURL("c", "sb://127.0.0.1:55675", transport.ConnectionOptions{Fields: map[string]string{"maxopspersecond": "25"}})
	if err != nil || cfg.MaxOpsPerSecond == nil || *cfg.MaxOpsPerSecond != 25 {
		t.Errorf("maxopspersecond field: %v %v", cfg.MaxOpsPerSecond, err)
	}
}

func TestRateGateChargesBytes(t *testing.T) {
	g := newRateGate(1000, 1, 1) // 1 ms per operation + 1 ms per KiB
	start := time.Now()
	for i := 0; i < 4; i++ {
		_ = g.take(context.Background(), 20*1024) // 21 ms each
	}
	if d := time.Since(start); d < 55*time.Millisecond {
		t.Errorf("4 takes of 20 KiB took %v, want >= ~63ms", d)
	}
}
