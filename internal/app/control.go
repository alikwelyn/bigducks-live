package app

import (
	"context"
	"errors"
	"sync"
)

var ErrRuntimeUnavailable = errors.New("o núcleo do BIG DUCKS não está disponível")

type RecoveryState string

const (
	RecoveryStarting       RecoveryState = "starting"
	RecoveryProtected      RecoveryState = "protected"
	RecoveryReconnecting   RecoveryState = "reconnecting"
	RecoveryNoProxy        RecoveryState = "no_proxy"
	RecoveryFailed         RecoveryState = "failed"
	RecoveryRepairRequired RecoveryState = "repair_required"
	RecoveryStopped        RecoveryState = "stopped"
)

type RuntimeStatus struct {
	State           RecoveryState
	PoolSize        int
	TunnelCount     int
	BridgeConnected bool
	InjectionState  string
	RepairRequired  bool
	LastError       string
	LastMessage     string
	ActiveProxy     string
	LatencyMS       int
	RecentEvents    []RuntimeEvent
}

type RuntimeEvent struct {
	At      string `json:"at"`
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

type RuntimeBindings struct {
	Reconnect func(context.Context) error
	Reload    func(context.Context) error
	TestRoute func(context.Context) error
	Status    func() RuntimeStatus
}

type RuntimeControl struct {
	mu         sync.Mutex
	generation uint64
	bindings   RuntimeBindings
	status     RuntimeStatus
}

func NewRuntimeControl() *RuntimeControl {
	return &RuntimeControl{status: RuntimeStatus{State: RecoveryStopped}}
}

func (c *RuntimeControl) Bind(bindings RuntimeBindings) func() {
	if c == nil {
		return func() {}
	}
	c.mu.Lock()
	c.generation++
	generation := c.generation
	c.bindings = bindings
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.generation != generation {
			return
		}
		c.bindings = RuntimeBindings{}
		c.status = RuntimeStatus{State: RecoveryStopped}
	}
}

func (c *RuntimeControl) Reconnect(ctx context.Context) error {
	if c == nil {
		return ErrRuntimeUnavailable
	}
	c.mu.Lock()
	reconnect := c.bindings.Reconnect
	c.mu.Unlock()
	if reconnect == nil {
		return ErrRuntimeUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return reconnect(ctx)
}

func (c *RuntimeControl) Reload(ctx context.Context) error {
	if c == nil {
		return ErrRuntimeUnavailable
	}
	c.mu.Lock()
	reload := c.bindings.Reload
	c.mu.Unlock()
	if reload == nil {
		return ErrRuntimeUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return reload(ctx)
}

func (c *RuntimeControl) TestRoute(ctx context.Context) error {
	if c == nil {
		return ErrRuntimeUnavailable
	}
	c.mu.Lock()
	testRoute := c.bindings.TestRoute
	c.mu.Unlock()
	if testRoute == nil {
		return ErrRuntimeUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return testRoute(ctx)
}

func (c *RuntimeControl) Status() RuntimeStatus {
	if c == nil {
		return RuntimeStatus{State: RecoveryStopped}
	}
	c.mu.Lock()
	status := c.status
	statusFunc := c.bindings.Status
	c.mu.Unlock()
	if statusFunc != nil {
		return statusFunc()
	}
	return status
}

func (c *RuntimeControl) SetStatus(status RuntimeStatus) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.status = status
	c.mu.Unlock()
}
