package controlapi_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/controlapi"
)

func TestServerAuthenticatesAndDispatchesRuntimeActions(t *testing.T) {
	runtime := app.NewRuntimeControl()
	reconnectCalls := 0
	routeCalls := 0
	repairCalls := 0
	runtime.Bind(app.RuntimeBindings{
		Reconnect:     func(context.Context) error { reconnectCalls++; return nil },
		RepairDiscord: func(context.Context) error { repairCalls++; return nil },
		Reload:        func(context.Context) error { return nil },
		TestRoute:     func(context.Context) error { routeCalls++; return nil },
		Status: func() app.RuntimeStatus {
			return app.RuntimeStatus{State: app.RecoveryProtected, PoolSize: 3, TunnelCount: 1, BridgeConnected: true}
		},
	})
	shutdown := make(chan struct{}, 1)
	server := controlapi.NewServer(controlapi.ServerOptions{
		DataDir: t.TempDir(), Runtime: runtime,
		Shutdown: func() { shutdown <- struct{}{} },
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := server.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	client, err := controlapi.LoadClient(server.ControlPath())
	if err != nil {
		t.Fatalf("LoadClient() error = %v", err)
	}

	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if status.State != app.RecoveryProtected || status.TunnelCount != 1 {
		t.Fatalf("Status() = %#v", status)
	}
	if err := client.Reconnect(context.Background()); err != nil {
		t.Fatalf("Reconnect() error = %v", err)
	}
	if err := client.TestRoute(context.Background()); err != nil {
		t.Fatalf("TestRoute() error = %v", err)
	}
	if err := client.RepairDiscord(context.Background()); err != nil {
		t.Fatalf("RepairDiscord() error = %v", err)
	}
	if reconnectCalls != 1 || routeCalls != 1 || repairCalls != 1 {
		t.Fatalf("action calls: reconnect=%d route=%d repair=%d", reconnectCalls, routeCalls, repairCalls)
	}
	if err := client.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	select {
	case <-shutdown:
	case <-time.After(time.Second):
		t.Fatal("shutdown callback was not called")
	}
}

func TestServerRejectsMissingBearerToken(t *testing.T) {
	server := controlapi.NewServer(controlapi.ServerOptions{DataDir: t.TempDir(), Runtime: app.NewRuntimeControl()})
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	response, err := http.Get("http://" + server.Address() + "/v1/status")
	if err != nil {
		t.Fatalf("GET status error = %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want unauthorized", response.StatusCode)
	}
}

func TestClientReturnsRemoteRuntimeError(t *testing.T) {
	runtime := app.NewRuntimeControl()
	runtime.Bind(app.RuntimeBindings{Reconnect: func(context.Context) error { return errors.New("no proxy") }})
	server := controlapi.NewServer(controlapi.ServerOptions{DataDir: t.TempDir(), Runtime: runtime})
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	client, err := controlapi.LoadClient(server.ControlPath())
	if err != nil {
		t.Fatalf("LoadClient() error = %v", err)
	}
	if err := client.Reconnect(context.Background()); err == nil || err.Error() != "no proxy" {
		t.Fatalf("Reconnect() error = %v", err)
	}
}
