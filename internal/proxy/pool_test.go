package proxy_test

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

func TestPoolDialRemovesFailedEndpointAndTriesNext(t *testing.T) {
	first := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "first", Port: 1}}
	second := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "second", Port: 2}}
	var peer net.Conn
	p := &proxy.Pool{
		Entries: []model.VerifiedEndpoint{first, second},
		Dialer: func(_ context.Context, endpoint model.Endpoint, _ string, _ int) (net.Conn, error) {
			if endpoint.Host == "first" {
				return nil, errors.New("first proxy failed")
			}
			var local net.Conn
			local, peer = net.Pipe()
			return local, nil
		},
	}

	conn, err := p.Dial(context.Background(), "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("Pool.Dial() error = %v", err)
	}
	defer conn.Close()
	defer peer.Close()
	if len(p.Snapshot()) != 1 || p.Snapshot()[0].Host != "second" {
		t.Fatalf("pool after failure = %#v", p.Snapshot())
	}
}

func TestPoolDialUsesIndependentAttemptTimeouts(t *testing.T) {
	first := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "slow", Port: 1}}
	second := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "fast", Port: 2}}
	var peer net.Conn
	p := &proxy.Pool{
		Entries:        []model.VerifiedEndpoint{first, second},
		AttemptTimeout: 25 * time.Millisecond,
		Dialer: func(ctx context.Context, endpoint model.Endpoint, _ string, _ int) (net.Conn, error) {
			if endpoint.Host == "slow" {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			var local net.Conn
			local, peer = net.Pipe()
			return local, nil
		},
	}

	started := time.Now()
	conn, err := p.Dial(context.Background(), "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("Pool.Dial() error = %v", err)
	}
	defer conn.Close()
	defer peer.Close()
	if elapsed := time.Since(started); elapsed > 150*time.Millisecond {
		t.Fatalf("Pool.Dial() took %v, want independent attempt timeout", elapsed)
	}
	if len(p.Snapshot()) != 1 || p.Snapshot()[0].Host != "fast" {
		t.Fatalf("pool after timeout = %#v", p.Snapshot())
	}
}

func TestPoolDialWithEndpointReportsTheSelectedProxy(t *testing.T) {
	entry := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "selected", Port: 1080}}
	var peer net.Conn
	p := &proxy.Pool{
		Entries: []model.VerifiedEndpoint{entry},
		Dialer: func(_ context.Context, _ model.Endpoint, _ string, _ int) (net.Conn, error) {
			var local net.Conn
			local, peer = net.Pipe()
			return local, nil
		},
	}

	result, err := p.DialWithEndpoint(context.Background(), "gateway.discord.gg", 443)
	if err != nil {
		t.Fatalf("Pool.DialWithEndpoint() error = %v", err)
	}
	defer result.Conn.Close()
	defer peer.Close()
	if result.Endpoint.Host != "selected" {
		t.Fatalf("selected endpoint = %#v", result.Endpoint)
	}
}

func TestPoolKeepsUsingActiveEndpointUntilItFails(t *testing.T) {
	first := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}
	second := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "reserve", Port: 1081}}
	var used []string
	p := &proxy.Pool{
		Entries: []model.VerifiedEndpoint{first, second},
		Dialer: func(_ context.Context, endpoint model.Endpoint, _ string, _ int) (net.Conn, error) {
			used = append(used, endpoint.Host)
			local, peer := net.Pipe()
			_ = peer.Close()
			return local, nil
		},
	}

	for range 3 {
		conn, err := p.Dial(context.Background(), "gateway.discord.gg", 443)
		if err != nil {
			t.Fatalf("Pool.Dial() error = %v", err)
		}
		_ = conn.Close()
	}
	if len(used) != 3 || used[0] != "active" || used[1] != "active" || used[2] != "active" {
		t.Fatalf("used endpoints = %#v, want active only", used)
	}
}

func TestPoolPromoteReserveChangesTheStickyActiveEndpoint(t *testing.T) {
	first := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}
	second := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "reserve", Port: 1081}}
	p := &proxy.Pool{Entries: []model.VerifiedEndpoint{first, second}}
	if !p.PromoteReserve() {
		t.Fatal("PromoteReserve() = false, want true")
	}
	snapshot := p.Snapshot()
	if len(snapshot) != 2 || snapshot[0].Host != "reserve" || snapshot[1].Host != "active" {
		t.Fatalf("pool after promotion = %#v", snapshot)
	}
}

func TestPoolConcurrentFailureCannotReturnRemovedActiveEndpoint(t *testing.T) {
	active := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "active", Port: 1080}}
	reserve := model.VerifiedEndpoint{Endpoint: model.Endpoint{Scheme: "socks5", Host: "reserve", Port: 1081}}
	activeStarted := make(chan struct{})
	releaseFailure := make(chan struct{})
	var once sync.Once
	p := &proxy.Pool{
		Entries: []model.VerifiedEndpoint{active, reserve},
		Dialer: func(_ context.Context, endpoint model.Endpoint, _ string, _ int) (net.Conn, error) {
			if endpoint.Host == "active" {
				first := false
				once.Do(func() {
					first = true
					close(activeStarted)
				})
				if first {
					<-releaseFailure
					return nil, errors.New("active failed")
				}
				return &poolTestConn{}, nil
			}
			return &poolTestConn{}, nil
		},
	}

	results := make(chan proxy.DialResult, 2)
	errorsSeen := make(chan error, 2)
	go func() {
		result, err := p.DialWithEndpoint(context.Background(), "gateway.discord.gg", 443)
		results <- result
		errorsSeen <- err
	}()
	<-activeStarted
	go func() {
		result, err := p.DialWithEndpoint(context.Background(), "gateway.discord.gg", 443)
		results <- result
		errorsSeen <- err
	}()
	time.Sleep(10 * time.Millisecond)
	close(releaseFailure)

	for range 2 {
		if err := <-errorsSeen; err != nil {
			t.Fatalf("DialWithEndpoint() error = %v", err)
		}
		result := <-results
		if result.Endpoint.Host != "reserve" {
			t.Fatalf("returned endpoint = %q, want reserve", result.Endpoint.Host)
		}
		_ = result.Conn.Close()
	}
}

func TestStateRoundTripHonorsExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	now := time.Unix(1_700_000_000, 0)
	entries := []model.VerifiedEndpoint{{
		Endpoint: model.Endpoint{Scheme: "socks5", Host: "proxy.example", Port: 1080},
		Country:  "US",
	}}
	if err := proxy.SaveState(path, entries, now); err != nil {
		t.Fatalf("SaveState() error = %v", err)
	}
	loaded, err := proxy.LoadState(path, now.Add(30*time.Minute), time.Hour)
	if err != nil || len(loaded) != 1 {
		t.Fatalf("LoadState() = %#v, %v", loaded, err)
	}
	expired, err := proxy.LoadState(path, now.Add(2*time.Hour), time.Hour)
	if err != nil {
		t.Fatalf("expired LoadState() error = %v", err)
	}
	if expired != nil {
		t.Fatalf("expired state = %#v, want nil", expired)
	}
}

func TestSelectVerifiedSortsAndExcludesBrazil(t *testing.T) {
	candidates := []model.Endpoint{
		{Scheme: "socks5", Host: "slow", Port: 1},
		{Scheme: "socks5", Host: "fast", Port: 2},
		{Scheme: "socks5", Host: "brasil", Port: 3},
	}
	selected := proxy.SelectVerified(context.Background(), candidates, 2, 2, func(_ context.Context, endpoint model.Endpoint) (model.VerifiedEndpoint, error) {
		country := "US"
		latency := 200
		if endpoint.Host == "fast" {
			latency = 50
		}
		if endpoint.Host == "brasil" {
			country = "BR"
		}
		return model.VerifiedEndpoint{Endpoint: endpoint, Country: country, LatencyMS: latency}, nil
	})
	if len(selected) != 2 || selected[0].Host != "fast" || selected[1].Host != "slow" {
		t.Fatalf("selected = %#v", selected)
	}
}

type poolTestConn struct{ managedTestConn }
