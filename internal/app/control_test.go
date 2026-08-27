package app_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/app"
)

func TestRuntimeControlReconnectUsesCurrentBinding(t *testing.T) {
	called := 0
	control := app.NewRuntimeControl()
	unbind := control.Bind(app.RuntimeBindings{
		Reconnect: func(context.Context) error {
			called++
			return nil
		},
	})
	if err := control.Reconnect(context.Background()); err != nil {
		t.Fatalf("Reconnect() error = %v", err)
	}
	if called != 1 {
		t.Fatalf("reconnect calls = %d, want 1", called)
	}
	unbind()
	if err := control.Reconnect(context.Background()); !errors.Is(err, app.ErrRuntimeUnavailable) {
		t.Fatalf("Reconnect() after unbind = %v, want ErrRuntimeUnavailable", err)
	}
}

func TestRuntimeControlReloadUsesCurrentBinding(t *testing.T) {
	called := 0
	control := app.NewRuntimeControl()
	control.Bind(app.RuntimeBindings{
		Reload: func(context.Context) error {
			called++
			return nil
		},
	})
	if err := control.Reload(context.Background()); err != nil {
		t.Fatalf("Reload() error = %v", err)
	}
	if called != 1 {
		t.Fatalf("reload calls = %d, want 1", called)
	}
}

func TestRuntimeControlStatusUsesLiveBinding(t *testing.T) {
	control := app.NewRuntimeControl()
	control.SetStatus(app.RuntimeStatus{State: app.RecoveryStarting})
	control.Bind(app.RuntimeBindings{
		Status: func() app.RuntimeStatus {
			return app.RuntimeStatus{State: app.RecoveryProtected, PoolSize: 3, BridgeConnected: true}
		},
	})
	status := control.Status()
	if status.State != app.RecoveryProtected || status.PoolSize != 3 || !status.BridgeConnected {
		t.Fatalf("Status() = %#v", status)
	}
}

func TestOlderUnbindDoesNotRemoveNewRuntime(t *testing.T) {
	control := app.NewRuntimeControl()
	oldUnbind := control.Bind(app.RuntimeBindings{Reconnect: func(context.Context) error { return errors.New("old") }})
	control.Bind(app.RuntimeBindings{Reconnect: func(context.Context) error { return nil }})
	oldUnbind()
	if err := control.Reconnect(context.Background()); err != nil {
		t.Fatalf("new binding was removed by old unbind: %v", err)
	}
}
