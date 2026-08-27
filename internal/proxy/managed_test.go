package proxy_test

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

func TestManagedPoolDialWaitsForOneSharedRefresh(t *testing.T) {
	endpoint := verifiedEndpoint("fresh", 1080)
	var fetches atomic.Int32
	refreshStarted := make(chan struct{})
	releaseRefresh := make(chan struct{})
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		WaitBudget: 200 * time.Millisecond,
		PoolSize:   3,
		Refresh: func(context.Context) ([]model.VerifiedEndpoint, error) {
			if fetches.Add(1) == 1 {
				close(refreshStarted)
			}
			<-releaseRefresh
			return []model.VerifiedEndpoint{endpoint}, nil
		},
		Dialer: func(context.Context, model.Endpoint, string, int) (net.Conn, error) {
			return &managedTestConn{}, nil
		},
	})

	errorsSeen := make(chan error, 2)
	go func() {
		_, err := managed.DialWithEndpoint(context.Background(), "gateway.discord.gg", 443)
		errorsSeen <- err
	}()
	<-refreshStarted
	go func() {
		_, err := managed.DialWithEndpoint(context.Background(), "gateway.discord.gg", 443)
		errorsSeen <- err
	}()
	time.Sleep(20 * time.Millisecond)
	close(releaseRefresh)

	for range 2 {
		if err := <-errorsSeen; err != nil {
			t.Fatalf("DialWithEndpoint() error = %v", err)
		}
	}
	if fetches.Load() != 1 {
		t.Fatalf("refreshes = %d, want 1", fetches.Load())
	}
}

func TestManagedPoolDialStopsAfterRecoveryBudget(t *testing.T) {
	refreshCanceled := make(chan struct{})
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		WaitBudget: 25 * time.Millisecond,
		Refresh: func(ctx context.Context) ([]model.VerifiedEndpoint, error) {
			<-ctx.Done()
			close(refreshCanceled)
			return nil, ctx.Err()
		},
	})

	started := time.Now()
	_, err := managed.DialWithEndpoint(context.Background(), "gateway.discord.gg", 443)
	if !errors.Is(err, proxy.ErrNoProxy) {
		t.Fatalf("DialWithEndpoint() error = %v, want ErrNoProxy", err)
	}
	if elapsed := time.Since(started); elapsed > 150*time.Millisecond {
		t.Fatalf("DialWithEndpoint() took %v, want bounded recovery wait", elapsed)
	}
	select {
	case <-refreshCanceled:
	case <-time.After(time.Second):
		t.Fatal("refresh context was not canceled")
	}
}

func TestManagedPoolHeartbeatDropsInUseExitAfterFirstMissAndRefills(t *testing.T) {
	active := verifiedEndpoint("active", 1080)
	reserve := verifiedEndpoint("reserve", 1081)
	freshOne := verifiedEndpoint("fresh-one", 1082)
	freshTwo := verifiedEndpoint("fresh-two", 1083)
	var dead []model.Endpoint
	var changesMu sync.Mutex
	var lastChange []model.VerifiedEndpoint
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		Entries:     []model.VerifiedEndpoint{active, reserve},
		PoolSize:    3,
		MinReserves: 2,
		InUse: func(endpoint model.Endpoint) bool {
			return endpoint.Host == active.Host
		},
		OnDead: func(endpoint model.Endpoint) {
			dead = append(dead, endpoint)
		},
		OnChange: func(entries []model.VerifiedEndpoint) {
			changesMu.Lock()
			lastChange = append([]model.VerifiedEndpoint(nil), entries...)
			changesMu.Unlock()
		},
		Probe: func(_ context.Context, endpoint model.Endpoint) (model.VerifiedEndpoint, error) {
			if endpoint.Host == active.Host {
				return model.VerifiedEndpoint{}, errors.New("active exit died")
			}
			return model.VerifiedEndpoint{Endpoint: endpoint, Country: "US"}, nil
		},
		Refresh: func(context.Context) ([]model.VerifiedEndpoint, error) {
			return []model.VerifiedEndpoint{freshOne, freshTwo}, nil
		},
	})

	managed.HeartbeatOnce(context.Background())

	if len(dead) != 1 || dead[0].Host != active.Host {
		t.Fatalf("dead exits = %#v, want active", dead)
	}
	snapshot := managed.Snapshot()
	if len(snapshot) != 3 || containsHost(snapshot, active.Host) || !containsHost(snapshot, reserve.Host) {
		t.Fatalf("snapshot after heartbeat = %#v", snapshot)
	}
	changesMu.Lock()
	defer changesMu.Unlock()
	if len(lastChange) != 3 {
		t.Fatalf("last persisted pool = %#v", lastChange)
	}
}

func TestManagedPoolReserveNeedsTwoMissesBeforeEviction(t *testing.T) {
	reserve := verifiedEndpoint("reserve", 1080)
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		Entries:  []model.VerifiedEndpoint{reserve},
		PoolSize: 1,
		Probe: func(context.Context, model.Endpoint) (model.VerifiedEndpoint, error) {
			return model.VerifiedEndpoint{}, errors.New("miss")
		},
	})

	managed.HeartbeatOnce(context.Background())
	if len(managed.Snapshot()) != 1 {
		t.Fatal("reserve was removed after its first missed heartbeat")
	}
	managed.HeartbeatOnce(context.Background())
	if len(managed.Snapshot()) != 0 {
		t.Fatal("reserve remained after two missed heartbeats")
	}
}

func TestManagedPoolUnsuccessfulHuntHonorsCooldown(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	var fetches int
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		HuntCooldown: 3 * time.Minute,
		Now:          func() time.Time { return now },
		Refresh: func(context.Context) ([]model.VerifiedEndpoint, error) {
			fetches++
			return nil, proxy.ErrNoProxy
		},
	})

	if err := managed.Refresh(context.Background(), false); !errors.Is(err, proxy.ErrNoProxy) {
		t.Fatalf("first Refresh() error = %v", err)
	}
	now = now.Add(time.Minute)
	if err := managed.Refresh(context.Background(), false); !errors.Is(err, proxy.ErrRefreshCooldown) {
		t.Fatalf("cooldown Refresh() error = %v, want ErrRefreshCooldown", err)
	}
	if fetches != 1 {
		t.Fatalf("refresh calls = %d, want 1", fetches)
	}
}

func TestManagedPoolForcedRefreshBypassesBackgroundHuntCooldown(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	var fetches int
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		HuntCooldown: 3 * time.Minute,
		Now:          func() time.Time { return now },
		Refresh: func(context.Context) ([]model.VerifiedEndpoint, error) {
			fetches++
			return nil, proxy.ErrNoProxy
		},
	})

	if err := managed.Refresh(context.Background(), false); !errors.Is(err, proxy.ErrNoProxy) {
		t.Fatalf("first Refresh() error = %v", err)
	}
	now = now.Add(time.Minute)
	if err := managed.Refresh(context.Background(), true); !errors.Is(err, proxy.ErrNoProxy) {
		t.Fatalf("forced Refresh() error = %v, want ErrNoProxy", err)
	}
	if fetches != 2 {
		t.Fatalf("refresh calls = %d, want 2", fetches)
	}
}

func verifiedEndpoint(host string, port int) model.VerifiedEndpoint {
	return model.VerifiedEndpoint{
		Endpoint: model.Endpoint{Scheme: "socks5", Host: host, Port: port},
		Country:  "US",
	}
}

func containsHost(entries []model.VerifiedEndpoint, host string) bool {
	for _, entry := range entries {
		if entry.Host == host {
			return true
		}
	}
	return false
}

type managedTestConn struct{}

func (managedTestConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (managedTestConn) Write(value []byte) (int, error)  { return len(value), nil }
func (managedTestConn) Close() error                     { return nil }
func (managedTestConn) LocalAddr() net.Addr              { return managedTestAddr("local") }
func (managedTestConn) RemoteAddr() net.Addr             { return managedTestAddr("remote") }
func (managedTestConn) SetDeadline(time.Time) error      { return nil }
func (managedTestConn) SetReadDeadline(time.Time) error  { return nil }
func (managedTestConn) SetWriteDeadline(time.Time) error { return nil }

type managedTestAddr string

func (a managedTestAddr) Network() string { return string(a) }
func (a managedTestAddr) String() string  { return string(a) }
