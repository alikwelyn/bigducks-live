package proxy

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

var ErrRefreshCooldown = errors.New("proxy refresh is cooling down")

type RefreshFunc func(ctx context.Context) ([]model.VerifiedEndpoint, error)

type ManagedOptions struct {
	Entries          []model.VerifiedEndpoint
	Dialer           DialerFunc
	AttemptTimeout   time.Duration
	Refresh          RefreshFunc
	Probe            ProbeFunc
	WaitBudget       time.Duration
	HeartbeatTimeout time.Duration
	PoolSize         int
	MinReserves      int
	HuntCooldown     time.Duration
	Now              func() time.Time
	InUse            func(model.Endpoint) bool
	OnDead           func(model.Endpoint)
	OnChange         func([]model.VerifiedEndpoint)
}

type refreshFlight struct {
	done chan struct{}
	err  error
}

type ManagedPool struct {
	pool             *Pool
	refresh          RefreshFunc
	probe            ProbeFunc
	waitBudget       time.Duration
	heartbeatTimeout time.Duration
	poolSize         int
	minReserves      int
	huntCooldown     time.Duration
	now              func() time.Time
	inUse            func(model.Endpoint) bool
	onDead           func(model.Endpoint)
	onChange         func([]model.VerifiedEndpoint)

	mu         sync.Mutex
	flight     *refreshFlight
	lastFailed time.Time
	misses     map[string]int
}

func NewManagedPool(options ManagedOptions) *ManagedPool {
	poolSize := options.PoolSize
	if poolSize < 1 {
		poolSize = 3
	}
	minReserves := options.MinReserves
	if minReserves < 0 {
		minReserves = 0
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	pool := &Pool{
		Dialer:         options.Dialer,
		AttemptTimeout: options.AttemptTimeout,
	}
	pool.Replace(options.Entries)
	return &ManagedPool{
		pool:             pool,
		refresh:          options.Refresh,
		probe:            options.Probe,
		waitBudget:       options.WaitBudget,
		heartbeatTimeout: options.HeartbeatTimeout,
		poolSize:         poolSize,
		minReserves:      minReserves,
		huntCooldown:     options.HuntCooldown,
		now:              now,
		inUse:            options.InUse,
		onDead:           options.OnDead,
		onChange:         options.OnChange,
		misses:           make(map[string]int),
	}
}

func (m *ManagedPool) DialWithEndpoint(ctx context.Context, host string, port int) (DialResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	before := m.pool.Snapshot()
	result, err := m.pool.DialWithEndpoint(ctx, host, port)
	if err == nil {
		return result, nil
	}
	m.reportDialRemovals(before)
	if parentErr := ctx.Err(); parentErr != nil {
		return DialResult{}, parentErr
	}

	recoveryCtx := ctx
	cancel := func() {}
	if m.waitBudget > 0 {
		recoveryCtx, cancel = context.WithTimeout(ctx, m.waitBudget)
	}
	refreshErr := m.Refresh(recoveryCtx, true)
	cancel()
	if refreshErr != nil {
		if parentErr := ctx.Err(); parentErr != nil {
			return DialResult{}, parentErr
		}
		return DialResult{}, ErrNoProxy
	}

	before = m.pool.Snapshot()
	result, err = m.pool.DialWithEndpoint(ctx, host, port)
	if err != nil {
		m.reportDialRemovals(before)
		if parentErr := ctx.Err(); parentErr != nil {
			return DialResult{}, parentErr
		}
		return DialResult{}, ErrNoProxy
	}
	return result, nil
}

func (m *ManagedPool) Refresh(ctx context.Context, force bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if m.refresh == nil {
		return ErrNoProxy
	}

	m.mu.Lock()
	if m.flight != nil {
		flight := m.flight
		m.mu.Unlock()
		select {
		case <-flight.done:
			return flight.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if !force && len(m.pool.Snapshot()) >= m.poolSize {
		m.mu.Unlock()
		return nil
	}
	if !force && !m.lastFailed.IsZero() && m.huntCooldown > 0 && m.now().Sub(m.lastFailed) < m.huntCooldown {
		m.mu.Unlock()
		return ErrRefreshCooldown
	}
	flight := &refreshFlight{done: make(chan struct{})}
	m.flight = flight
	m.mu.Unlock()

	entries, err := m.refresh(ctx)
	if err == nil && len(entries) == 0 {
		err = ErrNoProxy
	}
	if err == nil {
		m.pool.Merge(entries, m.poolSize)
		m.notifyChange()
	}

	m.mu.Lock()
	if err != nil {
		m.lastFailed = m.now()
	} else {
		m.lastFailed = time.Time{}
	}
	flight.err = err
	close(flight.done)
	if m.flight == flight {
		m.flight = nil
	}
	m.mu.Unlock()
	return err
}

func (m *ManagedPool) HeartbeatOnce(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	entries := m.pool.Snapshot()
	if m.probe != nil && len(entries) > 0 {
		type probeResult struct {
			entry model.VerifiedEndpoint
			err   error
		}
		results := make(chan probeResult, len(entries))
		var wait sync.WaitGroup
		for _, entry := range entries {
			wait.Add(1)
			go func(entry model.VerifiedEndpoint) {
				defer wait.Done()
				probeCtx := ctx
				cancel := func() {}
				if m.heartbeatTimeout > 0 {
					probeCtx, cancel = context.WithTimeout(ctx, m.heartbeatTimeout)
				}
				_, err := m.probe(probeCtx, entry.Endpoint)
				cancel()
				results <- probeResult{entry: entry, err: err}
			}(entry)
		}
		wait.Wait()
		close(results)

		changed := false
		for result := range results {
			key := result.entry.Endpoint.URL()
			if result.err == nil {
				m.mu.Lock()
				delete(m.misses, key)
				m.mu.Unlock()
				continue
			}
			m.mu.Lock()
			m.misses[key]++
			misses := m.misses[key]
			m.mu.Unlock()
			threshold := 2
			if m.inUse != nil && m.inUse(result.entry.Endpoint) {
				threshold = 1
			}
			if misses < threshold {
				continue
			}
			m.pool.Invalidate(result.entry.Endpoint)
			m.mu.Lock()
			delete(m.misses, key)
			m.mu.Unlock()
			changed = true
			if m.onDead != nil {
				m.onDead(result.entry.Endpoint)
			}
		}
		if changed {
			m.notifyChange()
		}
	}

	desired := 1 + m.minReserves
	if desired > m.poolSize {
		desired = m.poolSize
	}
	if len(m.pool.Snapshot()) < desired {
		_ = m.Refresh(ctx, false)
	}
}

func (m *ManagedPool) Start(ctx context.Context, interval time.Duration) {
	if ctx == nil {
		ctx = context.Background()
	}
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.HeartbeatOnce(ctx)
		}
	}
}

func (m *ManagedPool) Snapshot() []model.VerifiedEndpoint {
	return m.pool.Snapshot()
}

func (m *ManagedPool) PromoteReserve() bool {
	if !m.pool.PromoteReserve() {
		return false
	}
	m.notifyChange()
	return true
}

func (m *ManagedPool) reportDialRemovals(before []model.VerifiedEndpoint) {
	after := m.pool.Snapshot()
	changed := false
	for _, previous := range before {
		if containsEndpoint(after, previous.Endpoint) {
			continue
		}
		changed = true
		if m.onDead != nil {
			m.onDead(previous.Endpoint)
		}
	}
	if changed {
		m.notifyChange()
	}
}

func (m *ManagedPool) notifyChange() {
	if m.onChange != nil {
		m.onChange(m.pool.Snapshot())
	}
}

func containsEndpoint(entries []model.VerifiedEndpoint, endpoint model.Endpoint) bool {
	for _, entry := range entries {
		if sameEndpoint(entry.Endpoint, endpoint) {
			return true
		}
	}
	return false
}
