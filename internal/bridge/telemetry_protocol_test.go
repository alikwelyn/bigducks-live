package bridge_test

import (
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
)

func TestServerSynchronizesAndControlsTelemetry(t *testing.T) {
	dataDir := t.TempDir()
	server := bridge.NewServer(dataDir)
	server.SetTelemetryEnabled(true)
	if err := server.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	control := readBridgeControl(t, dataDir)
	conn, err := net.Dial("tcp", control.Address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	encoder := json.NewEncoder(conn)
	decoder := json.NewDecoder(conn)
	if err := encoder.Encode(map[string]any{"type": "hello", "token": control.Token}); err != nil {
		t.Fatal(err)
	}
	waitForBridge(t, server)

	var syncMessage struct {
		Type    string `json:"type"`
		Enabled bool   `json:"enabled"`
	}
	if err := decoder.Decode(&syncMessage); err != nil {
		t.Fatal(err)
	}
	if syncMessage.Type != "telemetry_sync" || !syncMessage.Enabled {
		t.Fatalf("sync message = %#v", syncMessage)
	}

	for _, command := range []struct {
		name string
		call func(context.Context) error
	}{
		{name: "telemetry_test", call: server.TestTelemetry},
		{name: "telemetry_disable", call: server.DisableTelemetry},
		{name: "telemetry_purge", call: server.PurgeTelemetry},
	} {
		done := make(chan error, 1)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			done <- command.call(ctx)
		}()
		var request struct {
			Type string `json:"type"`
			ID   uint64 `json:"id"`
		}
		if command.name == "telemetry_disable" {
			var disableSync struct {
				Type    string `json:"type"`
				Enabled bool   `json:"enabled"`
			}
			if err := decoder.Decode(&disableSync); err != nil {
				t.Fatalf("read disable sync: %v", err)
			}
			if disableSync.Type != "telemetry_sync" || disableSync.Enabled {
				t.Fatalf("disable sync = %#v", disableSync)
			}
		}
		if err := decoder.Decode(&request); err != nil {
			t.Fatalf("read %s: %v", command.name, err)
		}
		if request.Type != command.name || request.ID == 0 {
			t.Fatalf("request = %#v, want %s", request, command.name)
		}
		if err := encoder.Encode(map[string]any{"type": "result", "id": request.ID, "ok": true}); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatalf("%s() error = %v", command.name, err)
		}
	}
}
