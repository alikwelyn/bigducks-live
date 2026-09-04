package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

func TestRecoveryCoordinatorCompletesAfterElectronRedial(t *testing.T) {
	pool := &recoveryPoolStub{entries: []model.VerifiedEndpoint{{Endpoint: model.Endpoint{Scheme: "socks5", Host: "reserve", Port: 1080}}}, promoted: true}
	tunnels := &recoveryTunnelsStub{generation: 4, closed: 1}
	bridge := &recoveryBridgeStub{}
	status := newRuntimeStatusStore()
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{Pool: pool, Tunnels: tunnels, Bridge: bridge, Status: status})

	result, err := coordinator.Recover(context.Background())
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if result.State != RecoveryProtected || !result.UsedBridge {
		t.Fatalf("Recover() result = %#v", result)
	}
	if !pool.promoteCalled || !bridge.closeCalled || tunnels.waitAfter != 4 {
		t.Fatalf("recovery sequence incomplete: pool=%#v bridge=%#v tunnels=%#v", pool, bridge, tunnels)
	}
	if got := status.Snapshot().State; got != RecoveryProtected {
		t.Fatalf("status = %q, want protected", got)
	}
}

func TestRecoveryCoordinatorAbortsWhenDiscordIsClosed(t *testing.T) {
	pool := &recoveryPoolStub{entries: []model.VerifiedEndpoint{{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}}}
	status := newRuntimeStatusStore()
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{
		Pool: pool, Tunnels: &recoveryTunnelsStub{}, Status: status,
		DiscordAlive: func() bool { return false },
	})
	_, err := coordinator.Recover(context.Background())
	if !errors.Is(err, ErrDiscordClosed) {
		t.Fatalf("Recover() error = %v, want ErrDiscordClosed", err)
	}
	if got := status.Snapshot().State; got != RecoveryDiscordClosed {
		t.Fatalf("status = %q, want discord_closed", got)
	}
}

func TestRecoveryCoordinatorStartsDiscordWhenRecoveryIsRequestedWhileClosed(t *testing.T) {
	pool := &recoveryPoolStub{entries: []model.VerifiedEndpoint{{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}}}
	tunnels := &recoveryTunnelsStub{generation: 2}
	started := false
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{
		Pool: pool, Tunnels: tunnels, Status: newRuntimeStatusStore(),
		DiscordAlive: func() bool { return false },
		StartDiscord: func(context.Context) error { started = true; return nil },
	})
	if _, err := coordinator.Recover(context.Background()); err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if !started {
		t.Fatal("recovery did not start Discord")
	}
}

func TestRecoveryCoordinatorAggressiveRecoveryRunsSecondStage(t *testing.T) {
	pool := &recoveryPoolStub{entries: []model.VerifiedEndpoint{{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}}}
	tunnels := &recoveryTunnelsStub{generation: 1}
	called := false
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{
		Pool: pool, Tunnels: tunnels, Status: newRuntimeStatusStore(),
		Aggressive:  true,
		SecondStage: func(context.Context) error { called = true; return nil },
	})
	if _, err := coordinator.Recover(context.Background()); err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if !called {
		t.Fatal("aggressive recovery did not run second stage")
	}
}

func TestRecoveryCoordinatorReportsNoProxy(t *testing.T) {
	pool := &recoveryPoolStub{refreshErr: proxy.ErrNoProxy}
	status := newRuntimeStatusStore()
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{Pool: pool, Tunnels: &recoveryTunnelsStub{}, Status: status})

	_, err := coordinator.Recover(context.Background())
	if !errors.Is(err, proxy.ErrNoProxy) {
		t.Fatalf("Recover() error = %v, want ErrNoProxy", err)
	}
	if got := status.Snapshot().State; got != RecoveryNoProxy {
		t.Fatalf("status = %q, want no_proxy", got)
	}
}

func TestRecoveryCoordinatorNeverLeavesReconnectingAfterTimeout(t *testing.T) {
	pool := &recoveryPoolStub{entries: []model.VerifiedEndpoint{{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}}}
	tunnels := &recoveryTunnelsStub{generation: 8, closed: 1, waitErr: context.DeadlineExceeded}
	status := newRuntimeStatusStore()
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{Pool: pool, Tunnels: tunnels, Bridge: &recoveryBridgeStub{}, Status: status})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := coordinator.Recover(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Recover() error = %v, want deadline exceeded", err)
	}
	if got := status.Snapshot().State; got != RecoveryFailed {
		t.Fatalf("status = %q, want failed", got)
	}
}

func TestRecoveryCoordinatorCanSucceedWithoutBridge(t *testing.T) {
	pool := &recoveryPoolStub{entries: []model.VerifiedEndpoint{{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}}}
	tunnels := &recoveryTunnelsStub{generation: 2, closed: 1}
	bridge := &recoveryBridgeStub{err: errors.New("bridge unavailable")}
	status := newRuntimeStatusStore()
	coordinator := NewRecoveryCoordinator(RecoveryCoordinatorOptions{Pool: pool, Tunnels: tunnels, Bridge: bridge, Status: status})

	result, err := coordinator.Recover(context.Background())
	if err != nil {
		t.Fatalf("Recover() error = %v", err)
	}
	if result.UsedBridge || result.State != RecoveryProtected {
		t.Fatalf("Recover() result = %#v", result)
	}
}

type recoveryPoolStub struct {
	entries       []model.VerifiedEndpoint
	refreshErr    error
	promoted      bool
	promoteCalled bool
}

func (p *recoveryPoolStub) Snapshot() []model.VerifiedEndpoint  { return p.entries }
func (p *recoveryPoolStub) Refresh(context.Context, bool) error { return p.refreshErr }
func (p *recoveryPoolStub) PromoteReserve() bool {
	p.promoteCalled = true
	return p.promoted
}

type recoveryTunnelsStub struct {
	generation uint64
	closed     int
	waitAfter  uint64
	waitErr    error
}

func (t *recoveryTunnelsStub) Generation() uint64 { return t.generation }
func (t *recoveryTunnelsStub) CloseAll() int      { return t.closed }
func (t *recoveryTunnelsStub) WaitForConnection(_ context.Context, after uint64) error {
	t.waitAfter = after
	return t.waitErr
}

type recoveryBridgeStub struct {
	closeCalled bool
	err         error
}

func (b *recoveryBridgeStub) CloseConnections(context.Context) error {
	b.closeCalled = true
	return b.err
}
