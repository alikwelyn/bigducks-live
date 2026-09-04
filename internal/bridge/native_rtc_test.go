package bridge_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
)

func TestNormalizeNativeSnapshotKeepsOnlySafeAggregates(t *testing.T) {
	snapshot, err := bridge.NormalizeNativeSnapshot(map[string]any{
		"hooked":           true,
		"streamConnection": true,
		"statsAvailable":   true,
		"hasAudioSsrc":     true,
		"videoSsrc":        "123456789012345678",
		"audioPackets":     float64(30960),
		"videoPackets":     float64(0),
		"framesDecoded":    float64(0),
		"userId":           "123456789012345678",
		"url":              "wss://secret.discord.media/?token=secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.HasAudioSSRC || snapshot.HasVideoSSRC {
		t.Fatalf("ssrc presence = %#v", snapshot)
	}
	if snapshot.AudioPackets != 30960 || snapshot.VideoPackets != 0 {
		t.Fatalf("counters = %#v", snapshot)
	}
	if snapshot.RawShape != "" {
		t.Fatalf("raw shape leaked: %q", snapshot.RawShape)
	}
}

func TestNormalizeNativeSnapshotRejectsUnboundedOrInvalidCounters(t *testing.T) {
	_, err := bridge.NormalizeNativeSnapshot(map[string]any{
		"audioPackets": float64(-1),
		"videoPackets": float64(9007199254740992),
	})
	if !errors.Is(err, bridge.ErrInvalidNativeSnapshot) {
		t.Fatalf("error = %v", err)
	}
}

func TestServerReceivesValidatedNativeSnapshot(t *testing.T) {
	dataDir := t.TempDir()
	server := bridge.NewServer(dataDir)
	events := make(chan bridge.MediaEvent, 1)
	server.SetMediaEventHandler(func(event bridge.MediaEvent) { events <- event })
	if err := server.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	data, err := os.ReadFile(filepath.Join(dataDir, bridge.ControlFileName))
	if err != nil {
		t.Fatal(err)
	}
	var control bridge.ControlFile
	if err := json.Unmarshal(data, &control); err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", control.Address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(map[string]any{"type": "hello", "token": control.Token}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for !server.Status().Connected && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !server.Status().Connected {
		t.Fatal("bridge did not connect")
	}
	if err := encoder.Encode(map[string]any{
		"type": "media_event", "event": "native_rtc_snapshot",
		"native": map[string]any{
			"audioPackets": float64(20), "videoPackets": float64(0),
			"hasAudioSsrc": true, "hasVideoSsrc": false,
			"videoSsrc": "123456789012345678", "url": "wss://secret/?token=secret",
		},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event.Native == nil || !event.Native.HasAudioSSRC || event.Native.HasVideoSSRC || event.Native.AudioPackets != 20 {
			t.Fatalf("native event = %#v", event.Native)
		}
	case <-time.After(time.Second):
		t.Fatal("native event was not delivered")
	}
}
