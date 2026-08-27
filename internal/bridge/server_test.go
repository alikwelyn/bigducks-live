package bridge_test

import (
	"bufio"
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

func TestServerRejectsWrongTokenAndDeliversReload(t *testing.T) {
	dataDir := t.TempDir()
	server := bridge.NewServer(dataDir)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := server.Start(ctx); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	control := readBridgeControl(t, dataDir)

	wrong, err := net.Dial("tcp", control.Address)
	if err != nil {
		t.Fatalf("dial wrong-token client: %v", err)
	}
	_, _ = wrong.Write([]byte("{\"type\":\"hello\",\"token\":\"wrong\"}\n"))
	_ = wrong.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := bufio.NewReader(wrong).ReadByte(); err == nil {
		t.Fatal("wrong-token connection remained open")
	}
	_ = wrong.Close()

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

	reloadDone := make(chan error, 1)
	go func() {
		reloadCtx, reloadCancel := context.WithTimeout(context.Background(), time.Second)
		defer reloadCancel()
		reloadDone <- server.Reload(reloadCtx)
	}()
	var command struct {
		Type string `json:"type"`
		ID   uint64 `json:"id"`
	}
	if err := decoder.Decode(&command); err != nil {
		t.Fatalf("read command: %v", err)
	}
	if command.Type != "reload" || command.ID == 0 {
		t.Fatalf("command = %#v", command)
	}
	if err := encoder.Encode(map[string]any{"type": "result", "id": command.ID, "ok": true}); err != nil {
		t.Fatalf("send result: %v", err)
	}
	if err := <-reloadDone; err != nil {
		t.Fatalf("Reload() error = %v", err)
	}
}

func TestServerReloadReportsUnavailableWithoutAuthenticatedClient(t *testing.T) {
	server := bridge.NewServer(t.TempDir())
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	if err := server.Reload(context.Background()); !errors.Is(err, bridge.ErrUnavailable) {
		t.Fatalf("Reload() error = %v, want ErrUnavailable", err)
	}
}

func TestServerDeliversNetworkControlCommands(t *testing.T) {
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

	closeDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		closeDone <- server.CloseConnections(ctx)
	}()
	var closeCommand struct {
		Type string `json:"type"`
		ID   uint64 `json:"id"`
	}
	if err := decoder.Decode(&closeCommand); err != nil {
		t.Fatalf("read close command: %v", err)
	}
	if closeCommand.Type != "close_connections" || closeCommand.ID == 0 {
		t.Fatalf("close command = %#v", closeCommand)
	}
	if err := encoder.Encode(map[string]any{"type": "result", "id": closeCommand.ID, "ok": true}); err != nil {
		t.Fatalf("send close result: %v", err)
	}
	if err := <-closeDone; err != nil {
		t.Fatalf("CloseConnections() error = %v", err)
	}

	resolveDone := make(chan struct {
		value string
		err   error
	}, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		value, err := server.ResolveProxy(ctx, "https://gateway-us-east1-b.discord.gg")
		resolveDone <- struct {
			value string
			err   error
		}{value: value, err: err}
	}()
	var resolveCommand struct {
		Type string `json:"type"`
		ID   uint64 `json:"id"`
		URL  string `json:"url"`
	}
	if err := decoder.Decode(&resolveCommand); err != nil {
		t.Fatalf("read resolve command: %v", err)
	}
	if resolveCommand.Type != "resolve_proxy" || resolveCommand.URL != "https://gateway-us-east1-b.discord.gg" {
		t.Fatalf("resolve command = %#v", resolveCommand)
	}
	if err := encoder.Encode(map[string]any{"type": "result", "id": resolveCommand.ID, "ok": true, "value": "SOCKS5 127.0.0.1:55367"}); err != nil {
		t.Fatalf("send resolve result: %v", err)
	}
	result := <-resolveDone
	if result.err != nil || result.value != "SOCKS5 127.0.0.1:55367" {
		t.Fatalf("ResolveProxy() = %q, %v", result.value, result.err)
	}
}

func TestServerCloseRemovesControlFile(t *testing.T) {
	dataDir := t.TempDir()
	server := bridge.NewServer(dataDir)
	if err := server.Start(context.Background()); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	path := filepath.Join(dataDir, bridge.ControlFileName)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("control file before close: %v", err)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("control file after close error = %v, want not exist", err)
	}
}

func TestEmbeddedScriptTargetsOnlyDiscordClientWindows(t *testing.T) {
	script := string(bridge.Script())
	for _, required := range []string{"BrowserWindow.getAllWindows", "discord\\.com", "bridge-control.json", "webContents.reload", "closeAllConnections", "resolveProxy"} {
		if !contains(script, required) {
			t.Fatalf("embedded script does not contain %q", required)
		}
	}
}

func readBridgeControl(t *testing.T, dataDir string) bridge.ControlFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dataDir, bridge.ControlFileName))
	if err != nil {
		t.Fatalf("read control file: %v", err)
	}
	var control bridge.ControlFile
	if err := json.Unmarshal(data, &control); err != nil {
		t.Fatalf("decode control file: %v", err)
	}
	return control
}

func waitForBridge(t *testing.T, server *bridge.Server) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if server.Status().Connected {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("bridge did not authenticate")
}

func contains(value, fragment string) bool {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return true
		}
	}
	return false
}
