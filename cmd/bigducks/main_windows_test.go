//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/injection"
)

func TestTrayMenuUsesOnlyShortUserFacingLabels(t *testing.T) {
	got := []string{trayOpenLabel, trayRestartLabel, trayRepairLabel, trayQuitLabel, trayEnableLabel}
	want := []string{"Abrir", "Reiniciar", "Corrigir Discord", "Sair", "Ativar"}
	if len(got) != len(want) {
		t.Fatalf("menu labels = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("tray label %d = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestRepairDeclinedDoesNotCallCore(t *testing.T) {
	called := false
	confirmed, err := confirmAndRepair(func() bool { return false }, func(context.Context) error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("confirmAndRepair() error = %v", err)
	}
	if confirmed {
		t.Fatal("declined repair was reported as confirmed")
	}
	if called {
		t.Fatal("repair callback was called after confirmation was declined")
	}
}

func TestRepairConfirmedCallsCore(t *testing.T) {
	called := false
	confirmed, err := confirmAndRepair(func() bool { return true }, func(context.Context) error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("confirmAndRepair() error = %v", err)
	}
	if !confirmed {
		t.Fatal("confirmed repair was reported as declined")
	}
	if !called {
		t.Fatal("repair callback was not called after confirmation")
	}
}

func TestCoreWatcherDoesNotRestartWhileClosing(t *testing.T) {
	if shouldRestartCore(true, false, false) {
		t.Fatal("core watcher would restart the core during shutdown")
	}
	if shouldRestartCore(false, true, false) {
		t.Fatal("core watcher would restart the core during update")
	}
	if shouldRestartCore(false, false, true) {
		t.Fatal("core watcher would restart an already running core")
	}
	if !shouldRestartCore(false, false, false) {
		t.Fatal("core watcher should restart an unexpectedly stopped core")
	}
}

func TestRepairInjectionMetadataIfNeededMakesUninstallRestorable(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Discord")
	dataDir := t.TempDir()
	original := vencordLoaderFixture()
	resourcesPaths := make([]string, 0, 2)
	for _, version := range []string{"1.0.1", "1.0.2"} {
		resources := filepath.Join(root, "app-"+version, "resources")
		resourcesPaths = append(resourcesPaths, resources)
		if err := os.MkdirAll(resources, 0o700); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(filepath.Join(filepath.Dir(resources), "Discord.exe"), []byte("fixture"), 0o600); err != nil {
			t.Fatalf("write Discord.exe fixture: %v", err)
		}
		if err := os.WriteFile(filepath.Join(resources, "_app.asar"), []byte("Discord original"), 0o600); err != nil {
			t.Fatalf("write _app.asar fixture: %v", err)
		}
		if err := os.WriteFile(filepath.Join(resources, "app.asar"), original, 0o600); err != nil {
			t.Fatalf("write app.asar fixture: %v", err)
		}
		result, err := injection.Ensure(resources, dataDir, []byte("bridge"))
		if err != nil || !result.Installed {
			t.Fatalf("Ensure(%s) = %#v, %v", version, result, err)
		}
	}
	if err := os.Remove(filepath.Join(dataDir, injection.MetadataFileName)); err != nil {
		t.Fatalf("remove metadata: %v", err)
	}
	config := app.DefaultConfig()
	config.DiscordRoot = root
	config.DataDir = dataDir
	if err := repairInjectionMetadataIfNeeded(config); err != nil {
		t.Fatalf("repairInjectionMetadataIfNeeded() error = %v", err)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() error = %v", err)
	}
	for _, resources := range resourcesPaths {
		restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
		if err != nil {
			t.Fatalf("read restored loader: %v", err)
		}
		if !bytes.Equal(restored, original) {
			t.Fatalf("restored loader = %q, want %q", restored, original)
		}
	}
}

func vencordLoaderFixture() []byte {
	index := []byte(`require("C:\\Users\\friend\\AppData\\Roaming\\Vencord\\dist\\patcher.js")`)
	packageJSON := []byte(`{"name":"discord","main":"index.js"}`)
	headerValue := map[string]any{"files": map[string]any{
		"index.js":     map[string]any{"size": len(index), "offset": "0"},
		"package.json": map[string]any{"size": len(packageJSON), "offset": fmt.Sprint(len(index))},
	}}
	header, _ := json.Marshal(headerValue)
	padded := append([]byte(nil), header...)
	for len(padded)%4 != 0 {
		padded = append(padded, 0)
	}
	result := make([]byte, 16, 16+len(padded)+len(index)+len(packageJSON))
	binary.LittleEndian.PutUint32(result[0:4], 4)
	binary.LittleEndian.PutUint32(result[4:8], uint32(len(padded)+8))
	binary.LittleEndian.PutUint32(result[8:12], uint32(len(padded)+4))
	binary.LittleEndian.PutUint32(result[12:16], uint32(len(header)))
	result = append(result, padded...)
	result = append(result, index...)
	return append(result, packageJSON...)
}
