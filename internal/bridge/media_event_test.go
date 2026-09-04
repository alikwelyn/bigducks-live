package bridge_test

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
)

func TestServerReceivesMediaEventsFromBridgeClient(t *testing.T) {
	dataDir := t.TempDir()
	server := bridge.NewServer(dataDir)
	events := make(chan bridge.MediaEvent, 1)
	server.SetMediaEventHandler(func(event bridge.MediaEvent) { events <- event })
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	controlData, err := os.ReadFile(filepath.Join(dataDir, bridge.ControlFileName))
	if err != nil {
		t.Fatalf("read control file: %v", err)
	}
	var control bridge.ControlFile
	if err := json.Unmarshal(controlData, &control); err != nil {
		t.Fatalf("decode control: %v", err)
	}
	conn, err := net.Dial("tcp", control.Address)
	if err != nil {
		t.Fatalf("dial bridge: %v", err)
	}
	defer conn.Close()
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(map[string]any{"type": "hello", "token": control.Token}); err != nil {
		t.Fatalf("hello: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for !server.Status().Connected && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !server.Status().Connected {
		t.Fatal("bridge did not connect")
	}
	if err := encoder.Encode(map[string]any{"type": "media_event", "session": "s1", "event": "video_frame", "at": time.Unix(10, 0)}); err != nil {
		t.Fatalf("media event: %v", err)
	}
	select {
	case event := <-events:
		if event.Session != "s1" || event.Kind != "video_frame" {
			t.Fatalf("event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("media event was not delivered")
	}
}
