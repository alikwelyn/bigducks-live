package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
	"github.com/alikwelyn/bigducks-live/internal/relay"
)

func TestGatewayConnectorNeverFallsBackWhenPoolIsEmpty(t *testing.T) {
	pool := &gatewayPoolStub{err: proxy.ErrNoProxy}
	status := newRuntimeStatusStore()
	connector := gatewayConnector{pool: pool, tracker: relay.NewTracker(), status: status}

	connection, err := connector.Dial(context.Background(), "gateway.discord.gg", 443)
	if connection != nil || !errors.Is(err, proxy.ErrNoProxy) {
		t.Fatalf("Dial() = %#v, %v; want nil ErrNoProxy", connection, err)
	}
	if pool.calls != 1 {
		t.Fatalf("managed pool calls = %d, want 1", pool.calls)
	}
	if got := status.Snapshot().State; got != RecoveryNoProxy {
		t.Fatalf("recovery state = %q, want %q", got, RecoveryNoProxy)
	}
}

func TestGatewayConnectorCanUseExplicitDirectFallback(t *testing.T) {
	pool := &gatewayPoolStub{err: proxy.ErrNoProxy}
	status := newRuntimeStatusStore()
	connector := gatewayConnector{
		pool: pool, status: status, allowDirectFallback: true,
		directDial: func(context.Context, string, int) (net.Conn, error) { return &gatewayTestConn{}, nil },
	}
	connection, err := connector.Dial(context.Background(), "gateway.discord.gg", 443)
	if err != nil || connection == nil {
		t.Fatalf("Dial() = %#v, %v; want direct connection", connection, err)
	}
	connection.Close()
	if got := status.Snapshot().State; got != RecoveryDirect {
		t.Fatalf("state = %q, want %q", got, RecoveryDirect)
	}
}

func TestGatewayConnectorTracksSuccessfulProxyTunnel(t *testing.T) {
	endpoint := model.Endpoint{Scheme: "socks5", Host: "proxy", Port: 1080}
	pool := &gatewayPoolStub{result: proxy.DialResult{Conn: &gatewayTestConn{}, Endpoint: endpoint}}
	tracker := relay.NewTracker()
	status := newRuntimeStatusStore()
	connected := false
	connector := gatewayConnector{
		pool: pool, tracker: tracker, status: status,
		onConnected: func(selected model.Endpoint) {
			connected = selected == endpoint
		},
	}

	connection, err := connector.Dial(context.Background(), "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	defer connection.Close()
	if tracker.Count() != 1 || !tracker.InUse(endpoint) {
		t.Fatalf("successful tunnel was not tracked: count=%d", tracker.Count())
	}
	if got := status.Snapshot().State; got != RecoveryProtected {
		t.Fatalf("recovery state = %q, want %q", got, RecoveryProtected)
	}
	if !connected {
		t.Fatal("successful routed connection did not notify recovery coordinator")
	}
	snapshot := status.Snapshot()
	if snapshot.LastMessage == "" || len(snapshot.RecentEvents) == 0 {
		t.Fatalf("successful connection did not produce a user-facing event: %#v", snapshot)
	}
}

func TestRuntimeStatusStoreBoundsStructuredEvents(t *testing.T) {
	store := newRuntimeStatusStore()
	for index := 0; index < 80; index++ {
		store.Update(func(status *RuntimeStatus) {
			status.State = RecoveryReconnecting
			status.LastMessage = fmt.Sprintf("attempt %d", index)
		})
	}
	status := store.Snapshot()
	if len(status.RecentEvents) != 50 {
		t.Fatalf("event count = %d, want 50", len(status.RecentEvents))
	}
	if status.RecentEvents[len(status.RecentEvents)-1].Message != "attempt 79" {
		t.Fatalf("last event = %#v", status.RecentEvents[len(status.RecentEvents)-1])
	}
}

type gatewayPoolStub struct {
	result proxy.DialResult
	err    error
	calls  int
}

func (p *gatewayPoolStub) DialWithEndpoint(context.Context, string, int) (proxy.DialResult, error) {
	p.calls++
	return p.result, p.err
}

type gatewayTestConn struct{}

func (gatewayTestConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (gatewayTestConn) Write(value []byte) (int, error)  { return len(value), nil }
func (gatewayTestConn) Close() error                     { return nil }
func (gatewayTestConn) LocalAddr() net.Addr              { return gatewayTestAddr("local") }
func (gatewayTestConn) RemoteAddr() net.Addr             { return gatewayTestAddr("remote") }
func (gatewayTestConn) SetDeadline(time.Time) error      { return nil }
func (gatewayTestConn) SetReadDeadline(time.Time) error  { return nil }
func (gatewayTestConn) SetWriteDeadline(time.Time) error { return nil }

type gatewayTestAddr string

func (a gatewayTestAddr) Network() string { return string(a) }
func (a gatewayTestAddr) String() string  { return string(a) }
