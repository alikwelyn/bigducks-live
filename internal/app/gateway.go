package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/logging"
	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
	"github.com/alikwelyn/bigducks-live/internal/relay"
)

type gatewayDialPool interface {
	DialWithEndpoint(context.Context, string, int) (proxy.DialResult, error)
}

type gatewayConnector struct {
	pool        gatewayDialPool
	tracker     *relay.Tracker
	status      *runtimeStatusStore
	logger      *logging.Logger
	onConnected func(model.Endpoint)
}

func (c gatewayConnector) Dial(ctx context.Context, host string, port int) (net.Conn, error) {
	if c.pool == nil {
		return nil, proxy.ErrNoProxy
	}
	if c.status != nil {
		c.status.Update(func(status *RuntimeStatus) {
			status.State = RecoveryReconnecting
			status.LastError = ""
			status.LastMessage = "Abrindo uma conexão protegida com o gateway"
		})
	}
	result, err := c.pool.DialWithEndpoint(ctx, host, port)
	if err != nil || result.Conn == nil {
		if err == nil {
			err = proxy.ErrNoProxy
		}
		if c.status != nil {
			c.status.Update(func(status *RuntimeStatus) {
				status.State = RecoveryNoProxy
				status.LastError = err.Error()
				status.LastMessage = "Nenhum proxy verificado respondeu dentro do prazo"
			})
		}
		if c.logger != nil {
			c.logger.Printf("gateway connection refused for %s:%d: %v; waiting for a verified proxy instead of connecting directly", host, port, err)
		}
		return nil, err
	}
	connection := result.Conn
	if c.tracker != nil {
		connection = c.tracker.Track(result.Endpoint, result.Conn)
	}
	if connection == nil {
		_ = result.Conn.Close()
		return nil, errors.New("gateway tunnel tracker returned a nil connection")
	}
	if c.status != nil {
		c.status.Update(func(status *RuntimeStatus) {
			status.State = RecoveryProtected
			status.LastError = ""
			status.LastMessage = "Gateway conectado por uma rota protegida"
		})
	}
	if c.logger != nil {
		c.logger.Printf("gateway connection via public proxy %s to %s:%d", result.Endpoint.RedactedURL(), host, port)
	}
	if c.onConnected != nil {
		c.onConnected(result.Endpoint)
	}
	return connection, nil
}

type runtimeStatusStore struct {
	mu     sync.Mutex
	status RuntimeStatus
	events []RuntimeEvent
}

func newRuntimeStatusStore() *runtimeStatusStore {
	return &runtimeStatusStore{status: RuntimeStatus{State: RecoveryStarting, LastMessage: "Preparando a proteção da live"}}
}

func (s *runtimeStatusStore) Update(update func(*RuntimeStatus)) {
	if s == nil || update == nil {
		return
	}
	s.mu.Lock()
	before := s.status
	update(&s.status)
	if before.State != s.status.State || before.LastMessage != s.status.LastMessage || before.LastError != s.status.LastError {
		message := s.status.LastMessage
		if message == "" {
			message = string(s.status.State)
		}
		event := RuntimeEvent{
			At: time.Now().Format(time.RFC3339Nano), Level: eventLevel(s.status.State),
			Code: "route." + string(s.status.State), Message: message, Details: s.status.LastError,
		}
		s.events = append(s.events, event)
		if len(s.events) > 50 {
			s.events = append([]RuntimeEvent(nil), s.events[len(s.events)-50:]...)
		}
	}
	s.mu.Unlock()
}

func (s *runtimeStatusStore) Snapshot() RuntimeStatus {
	if s == nil {
		return RuntimeStatus{State: RecoveryStopped, LastError: fmt.Sprint(ErrRuntimeUnavailable)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	status := s.status
	status.RecentEvents = append([]RuntimeEvent(nil), s.events...)
	return status
}

func eventLevel(state RecoveryState) string {
	switch state {
	case RecoveryProtected:
		return "success"
	case RecoveryFailed, RecoveryRepairRequired:
		return "error"
	default:
		return "info"
	}
}
