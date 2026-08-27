package relay

import (
	"context"
	"net"
	"sync"

	"github.com/alikwelyn/bigducks-live/internal/model"
)

type Tracker struct {
	mu         sync.Mutex
	nextID     uint64
	generation uint64
	entries    map[uint64]*trackedConn
	changed    chan struct{}
}

func NewTracker() *Tracker {
	return &Tracker{entries: make(map[uint64]*trackedConn), changed: make(chan struct{})}
}

func (t *Tracker) Track(endpoint model.Endpoint, conn net.Conn) net.Conn {
	if conn == nil {
		return nil
	}
	if t == nil {
		return conn
	}
	t.mu.Lock()
	if t.entries == nil {
		t.entries = make(map[uint64]*trackedConn)
	}
	t.nextID++
	t.generation++
	tracked := &trackedConn{
		Conn:     conn,
		tracker:  t,
		id:       t.nextID,
		endpoint: endpoint,
	}
	t.entries[tracked.id] = tracked
	t.signalLocked()
	t.mu.Unlock()
	return tracked
}

func (t *Tracker) Generation() uint64 {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.generation
}

func (t *Tracker) WaitForConnection(ctx context.Context, after uint64) error {
	if t == nil {
		return context.Canceled
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		t.mu.Lock()
		if t.generation > after && len(t.entries) > 0 {
			t.mu.Unlock()
			return nil
		}
		changed := t.changed
		t.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (t *Tracker) CloseEndpoint(endpoint model.Endpoint) int {
	if t == nil {
		return 0
	}
	targets := t.matching(func(entry *trackedConn) bool { return entry.endpoint == endpoint })
	closed := 0
	for _, target := range targets {
		if target.closeOnce() {
			closed++
		}
	}
	return closed
}

func (t *Tracker) CloseAll() int {
	if t == nil {
		return 0
	}
	targets := t.matching(func(*trackedConn) bool { return true })
	closed := 0
	for _, target := range targets {
		if target.closeOnce() {
			closed++
		}
	}
	return closed
}

func (t *Tracker) InUse(endpoint model.Endpoint) bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, entry := range t.entries {
		if entry.endpoint == endpoint {
			return true
		}
	}
	return false
}

func (t *Tracker) Count() int {
	if t == nil {
		return 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.entries)
}

func (t *Tracker) matching(match func(*trackedConn) bool) []*trackedConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	result := make([]*trackedConn, 0, len(t.entries))
	for _, entry := range t.entries {
		if match(entry) {
			result = append(result, entry)
		}
	}
	return result
}

func (t *Tracker) remove(id uint64) {
	t.mu.Lock()
	delete(t.entries, id)
	t.signalLocked()
	t.mu.Unlock()
}

func (t *Tracker) signalLocked() {
	if t.changed == nil {
		t.changed = make(chan struct{})
		return
	}
	close(t.changed)
	t.changed = make(chan struct{})
}

type trackedConn struct {
	net.Conn
	tracker  *Tracker
	id       uint64
	endpoint model.Endpoint
	once     sync.Once
	closeErr error
}

func (c *trackedConn) Close() error {
	c.closeOnce()
	return c.closeErr
}

func (c *trackedConn) closeOnce() bool {
	closed := false
	c.once.Do(func() {
		closed = true
		c.tracker.remove(c.id)
		c.closeErr = c.Conn.Close()
	})
	return closed
}
