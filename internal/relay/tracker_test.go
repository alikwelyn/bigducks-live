package relay_test

import (
	"context"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/relay"
)

func TestTrackerWaitForConnectionAfterGeneration(t *testing.T) {
	tracker := relay.NewTracker()
	before := tracker.Generation()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- tracker.WaitForConnection(ctx, before) }()

	tracked := tracker.Track(
		model.Endpoint{Scheme: "socks5", Host: "127.0.0.1", Port: 1080},
		&trackingTestConn{},
	)
	t.Cleanup(func() { _ = tracked.Close() })
	if err := <-done; err != nil {
		t.Fatalf("WaitForConnection() error = %v", err)
	}
}

func TestTrackerWaitForConnectionHonorsTimeout(t *testing.T) {
	tracker := relay.NewTracker()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := tracker.WaitForConnection(ctx, tracker.Generation()); err != context.DeadlineExceeded {
		t.Fatalf("WaitForConnection() error = %v, want deadline exceeded", err)
	}
}

func TestTrackerCloseEndpointOnlyClosesOwnedTunnels(t *testing.T) {
	tracker := relay.NewTracker()
	endpointA := model.Endpoint{Scheme: "socks5", Host: "first", Port: 1080}
	endpointB := model.Endpoint{Scheme: "socks5", Host: "second", Port: 1080}
	firstBase := &trackingTestConn{}
	secondBase := &trackingTestConn{}
	tracker.Track(endpointA, firstBase)
	tracker.Track(endpointB, secondBase)

	if closed := tracker.CloseEndpoint(endpointA); closed != 1 {
		t.Fatalf("CloseEndpoint() = %d, want 1", closed)
	}
	if !firstBase.Closed() {
		t.Fatal("endpoint A remained open")
	}
	if secondBase.Closed() {
		t.Fatal("endpoint B was closed")
	}
	if tracker.Count() != 1 {
		t.Fatalf("Count() = %d, want 1", tracker.Count())
	}
}

func TestTrackerTrackedCloseRemovesTunnelExactlyOnce(t *testing.T) {
	tracker := relay.NewTracker()
	endpoint := model.Endpoint{Scheme: "socks5", Host: "proxy", Port: 1080}
	base := &trackingTestConn{}
	tracked := tracker.Track(endpoint, base)

	if !tracker.InUse(endpoint) {
		t.Fatal("tracked endpoint is not reported in use")
	}
	if err := tracked.Close(); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}
	if err := tracked.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
	if tracker.Count() != 0 || tracker.InUse(endpoint) {
		t.Fatalf("tracker retained closed tunnel: count=%d inUse=%t", tracker.Count(), tracker.InUse(endpoint))
	}
	if base.CloseCalls() != 1 {
		t.Fatalf("underlying Close() calls = %d, want 1", base.CloseCalls())
	}
}

func TestTrackerCloseAllIsIdempotent(t *testing.T) {
	tracker := relay.NewTracker()
	for index := range 3 {
		tracker.Track(model.Endpoint{Scheme: "socks5", Host: "proxy", Port: 1080 + index}, &trackingTestConn{})
	}
	if closed := tracker.CloseAll(); closed != 3 {
		t.Fatalf("first CloseAll() = %d, want 3", closed)
	}
	if closed := tracker.CloseAll(); closed != 0 {
		t.Fatalf("second CloseAll() = %d, want 0", closed)
	}
}

type trackingTestConn struct {
	mu         sync.Mutex
	closeCalls int
}

func (c *trackingTestConn) Read([]byte) (int, error)        { return 0, io.EOF }
func (c *trackingTestConn) Write(value []byte) (int, error) { return len(value), nil }
func (c *trackingTestConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeCalls++
	return nil
}
func (c *trackingTestConn) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closeCalls > 0
}
func (c *trackingTestConn) CloseCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closeCalls
}
func (*trackingTestConn) LocalAddr() net.Addr              { return trackingTestAddr("local") }
func (*trackingTestConn) RemoteAddr() net.Addr             { return trackingTestAddr("remote") }
func (*trackingTestConn) SetDeadline(time.Time) error      { return nil }
func (*trackingTestConn) SetReadDeadline(time.Time) error  { return nil }
func (*trackingTestConn) SetWriteDeadline(time.Time) error { return nil }

type trackingTestAddr string

func (a trackingTestAddr) Network() string { return string(a) }
func (a trackingTestAddr) String() string  { return string(a) }
