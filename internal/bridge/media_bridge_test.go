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

func TestMediaBridgePageExposesFrameTakeoverHooks(t *testing.T) {
	path := filepath.Join("assets-src", "media_bridge_page.js")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, fragment := range []string{
		"__BIG_DUCKS_MEDIA__",
		"__BIG_DUCKS_MEDIA_SUMMARY__",
		"addVideoOutputSink",
		"getNextVideoOutputFrame",
		"addDirectVideoOutputSink",
		"CanvasRenderingContext2D",
		"putImageData",
		"requireModule",
		"discord_voice",
		"webpackChunkdiscord_app",
		"setGoLiveSource",
		"setStream",
		"requestAnimationFrame",
		"enableTestPattern",
		"setAutoTest",
	} {
		if !contains(text, fragment) {
			t.Fatalf("media bridge page does not contain %q", fragment)
		}
	}
}

func TestEmbeddedScriptShipsMediaBridge(t *testing.T) {
	script := string(bridge.Script())
	for _, required := range []string{
		"__BIG_DUCKS_MEDIA__",
		"__BIG_DUCKS_MEDIA_SUMMARY__",
		"addVideoOutputSink",
		"getNextVideoOutputFrame",
		"putImageData",
		"installMediaBridge",
		"media_probe",
		"media_test_pattern",
	} {
		if !contains(script, required) {
			t.Fatalf("embedded script does not contain %q", required)
		}
	}
}

func TestServerDeliversMediaCommands(t *testing.T) {
	dataDir := t.TempDir()
	server := bridge.NewServer(dataDir)
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	control := readBridgeControl(t, dataDir)
	client, err := net.Dial("tcp", control.Address)
	if err != nil {
		t.Fatalf("dial bridge client: %v", err)
	}
	defer client.Close()
	encoder := json.NewEncoder(client)
	decoder := json.NewDecoder(client)
	if err := encoder.Encode(map[string]any{"type": "hello", "token": control.Token}); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	waitForBridge(t, server)
	discardTelemetrySync(t, decoder)

	probeDone := make(chan struct {
		value string
		err   error
	}, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		value, err := server.MediaProbe(ctx)
		probeDone <- struct {
			value string
			err   error
		}{value: value, err: err}
	}()
	var probeCommand struct {
		Type string `json:"type"`
		ID   uint64 `json:"id"`
	}
	if err := decoder.Decode(&probeCommand); err != nil {
		t.Fatalf("read media_probe command: %v", err)
	}
	if probeCommand.Type != "media_probe" || probeCommand.ID == 0 {
		t.Fatalf("media_probe command = %#v", probeCommand)
	}
	const probePayload = `{"engine":true,"sinkHook":true}`
	if err := encoder.Encode(map[string]any{"type": "result", "id": probeCommand.ID, "ok": true, "value": probePayload}); err != nil {
		t.Fatalf("send media_probe result: %v", err)
	}
	probeResult := <-probeDone
	if probeResult.err != nil || probeResult.value != probePayload {
		t.Fatalf("MediaProbe() = %q, %v", probeResult.value, probeResult.err)
	}

	patternDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, err := server.SetMediaTestPattern(ctx, true)
		patternDone <- err
	}()
	var patternCommand struct {
		Type    string `json:"type"`
		ID      uint64 `json:"id"`
		Enabled bool   `json:"enabled"`
	}
	if err := decoder.Decode(&patternCommand); err != nil {
		t.Fatalf("read media_test_pattern command: %v", err)
	}
	if patternCommand.Type != "media_test_pattern" || patternCommand.ID == 0 || !patternCommand.Enabled {
		t.Fatalf("media_test_pattern command = %#v", patternCommand)
	}
	if err := encoder.Encode(map[string]any{"type": "result", "id": patternCommand.ID, "ok": true, "value": probePayload}); err != nil {
		t.Fatalf("send media_test_pattern result: %v", err)
	}
	if err := <-patternDone; err != nil {
		t.Fatalf("SetMediaTestPattern() error = %v", err)
	}
}
