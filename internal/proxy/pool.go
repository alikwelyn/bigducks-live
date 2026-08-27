package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
	"github.com/alikwelyn/bigducks-live/internal/model"
)

var ErrNoProxy = errors.New("no verified proxy available")

type DialerFunc func(ctx context.Context, endpoint model.Endpoint, host string, port int) (net.Conn, error)
type ProbeFunc func(ctx context.Context, endpoint model.Endpoint) (model.VerifiedEndpoint, error)

type Pool struct {
	Mu             sync.Mutex
	dialMu         sync.Mutex
	Entries        []model.VerifiedEndpoint
	Dialer         DialerFunc
	AttemptTimeout time.Duration
}

func (p *Pool) Dial(ctx context.Context, host string, port int) (net.Conn, error) {
	result, err := p.DialWithEndpoint(ctx, host, port)
	if err != nil {
		return nil, err
	}
	return result.Conn, nil
}

type DialResult struct {
	Conn     net.Conn
	Endpoint model.Endpoint
}

func (p *Pool) DialWithEndpoint(ctx context.Context, host string, port int) (DialResult, error) {
	p.dialMu.Lock()
	defer p.dialMu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	p.Mu.Lock()
	maxAttempts := len(p.Entries)
	p.Mu.Unlock()
	for attempts := 0; attempts < maxAttempts; attempts++ {
		if err := ctx.Err(); err != nil {
			return DialResult{}, err
		}
		p.Mu.Lock()
		if len(p.Entries) == 0 {
			p.Mu.Unlock()
			return DialResult{}, ErrNoProxy
		}
		entry := p.Entries[0]
		dialer := p.Dialer
		attemptTimeout := p.AttemptTimeout
		p.Mu.Unlock()
		if dialer == nil {
			dialer = DialViaSOCKS5
		}
		attemptCtx := ctx
		cancel := func() {}
		if attemptTimeout > 0 {
			attemptCtx, cancel = context.WithTimeout(ctx, attemptTimeout)
		}
		conn, err := dialer(attemptCtx, entry.Endpoint, host, port)
		cancel()
		if err == nil && conn != nil {
			return DialResult{Conn: conn, Endpoint: entry.Endpoint}, nil
		}
		if conn != nil {
			_ = conn.Close()
		}
		p.Invalidate(entry.Endpoint)
	}
	return DialResult{}, ErrNoProxy
}

func (p *Pool) Invalidate(endpoint model.Endpoint) {
	p.Mu.Lock()
	defer p.Mu.Unlock()
	for index, entry := range p.Entries {
		if sameEndpoint(entry.Endpoint, endpoint) {
			p.Entries = append(p.Entries[:index], p.Entries[index+1:]...)
			return
		}
	}
}

func (p *Pool) Snapshot() []model.VerifiedEndpoint {
	p.Mu.Lock()
	defer p.Mu.Unlock()
	return append([]model.VerifiedEndpoint(nil), p.Entries...)
}

func (p *Pool) Replace(entries []model.VerifiedEndpoint) {
	p.Mu.Lock()
	defer p.Mu.Unlock()
	p.Entries = uniqueEntries(entries, 0)
}

func (p *Pool) Merge(entries []model.VerifiedEndpoint, max int) {
	p.Mu.Lock()
	defer p.Mu.Unlock()
	combined := make([]model.VerifiedEndpoint, 0, len(p.Entries)+len(entries))
	combined = append(combined, p.Entries...)
	combined = append(combined, entries...)
	p.Entries = uniqueEntries(combined, max)
}

func (p *Pool) PromoteReserve() bool {
	p.Mu.Lock()
	defer p.Mu.Unlock()
	if len(p.Entries) < 2 {
		return false
	}
	active := p.Entries[0]
	copy(p.Entries, p.Entries[1:])
	p.Entries[len(p.Entries)-1] = active
	return true
}

func SelectVerified(ctx context.Context, candidates []model.Endpoint, max, workers int, probe ProbeFunc) []model.VerifiedEndpoint {
	if ctx == nil {
		ctx = context.Background()
	}
	if max <= 0 || max > len(candidates) {
		max = len(candidates)
	}
	if workers < 1 {
		workers = 1
	}
	if workers > len(candidates) {
		workers = len(candidates)
	}
	if len(candidates) == 0 || probe == nil {
		return nil
	}
	type result struct {
		endpoint model.VerifiedEndpoint
		err      error
	}
	jobs := make(chan model.Endpoint)
	results := make(chan result, len(candidates))
	var wait sync.WaitGroup
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for candidate := range jobs {
				verified, err := probe(ctx, candidate)
				results <- result{endpoint: verified, err: err}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, candidate := range candidates {
			select {
			case jobs <- candidate:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		wait.Wait()
		close(results)
	}()

	verified := make([]model.VerifiedEndpoint, 0, len(candidates))
	for result := range results {
		if result.err != nil || result.endpoint.Country == "" || strings.EqualFold(result.endpoint.Country, "BR") {
			continue
		}
		verified = append(verified, result.endpoint)
	}
	sort.Slice(verified, func(i, j int) bool {
		if verified[i].LatencyMS == verified[j].LatencyMS {
			return verified[i].Endpoint.RedactedURL() < verified[j].Endpoint.RedactedURL()
		}
		return verified[i].LatencyMS < verified[j].LatencyMS
	})
	if len(verified) > max {
		verified = verified[:max]
	}
	return verified
}

func SaveState(path string, entries []model.VerifiedEndpoint, now time.Time) error {
	if path == "" {
		return errors.New("state path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	data, err := json.MarshalIndent(model.State{Pool: entries, UpdatedAt: now.Unix()}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode proxy state: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("write proxy state: %w", err)
	}
	if err := fileutil.Replace(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace proxy state: %w", err)
	}
	return nil
}

func LoadState(path string, now time.Time, ttl time.Duration) ([]model.VerifiedEndpoint, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read proxy state: %w", err)
	}
	var state model.State
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode proxy state: %w", err)
	}
	if state.UpdatedAt == 0 || ttl <= 0 || now.Sub(time.Unix(state.UpdatedAt, 0)) > ttl {
		return nil, nil
	}
	return state.Pool, nil
}

func sameEndpoint(a, b model.Endpoint) bool {
	return a.Scheme == b.Scheme && a.Host == b.Host && a.Port == b.Port && a.User == b.User && a.Pass == b.Pass
}

func uniqueEntries(entries []model.VerifiedEndpoint, max int) []model.VerifiedEndpoint {
	result := make([]model.VerifiedEndpoint, 0, len(entries))
	for _, entry := range entries {
		duplicate := false
		for _, existing := range result {
			if sameEndpoint(existing.Endpoint, entry.Endpoint) {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		result = append(result, entry)
		if max > 0 && len(result) >= max {
			break
		}
	}
	return result
}
