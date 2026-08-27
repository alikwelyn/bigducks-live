//go:build windows

package startup_test

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/startup"
)

type fakeRegistry struct {
	values map[string]string
}

func (r *fakeRegistry) GetString(name string) (string, error) {
	value, ok := r.values[name]
	if !ok {
		return "", startup.ErrValueNotFound
	}
	return value, nil
}

func (r *fakeRegistry) SetString(name, value string) error {
	r.values[name] = value
	return nil
}

func (r *fakeRegistry) DeleteValue(name string) error {
	delete(r.values, name)
	return nil
}

func TestInstallSavesAndReplacesDiscordAutoStart(t *testing.T) {
	registry := &fakeRegistry{values: map[string]string{
		"Discord": `"C:\Users\friend\AppData\Local\Discord\Update.exe" --processStart Discord.exe`,
	}}
	metadata := filepath.Join(t.TempDir(), "startup.json")
	manager := startup.NewManager(registry, metadata, `C:\Tools\BigDucks.exe`)

	if err := manager.Install(); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	if _, ok := registry.values["Discord"]; ok {
		t.Fatal("direct Discord startup should be removed")
	}
	if got := registry.values["BigDucksLive"]; got != `"C:\Tools\BigDucks.exe" --startup` {
		t.Fatalf("BigDucks command = %q", got)
	}
	if err := manager.Install(); err != nil {
		t.Fatalf("second Install() error = %v", err)
	}
}

func TestUninstallRestoresExactOriginalValue(t *testing.T) {
	original := `"C:\Users\friend\AppData\Local\Discord\Update.exe" --processStart Discord.exe`
	registry := &fakeRegistry{values: map[string]string{"Discord": original}}
	metadata := filepath.Join(t.TempDir(), "startup.json")
	manager := startup.NewManager(registry, metadata, `C:\Tools\BigDucks.exe`)
	if err := manager.Install(); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	if err := manager.Uninstall(); err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	if registry.values["Discord"] != original {
		t.Fatalf("restored Discord value = %q, want %q", registry.values["Discord"], original)
	}
	if _, ok := registry.values["BigDucksLive"]; ok {
		t.Fatal("BigDucks value should be removed")
	}
}

func TestUninstallRefusesToOverwriteChangedHelperEntry(t *testing.T) {
	registry := &fakeRegistry{values: map[string]string{}}
	metadata := filepath.Join(t.TempDir(), "startup.json")
	manager := startup.NewManager(registry, metadata, `C:\Tools\BigDucks.exe`)
	if err := manager.Install(); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	registry.values["BigDucksLive"] = `"C:\Other\tool.exe" --startup`
	if err := manager.Uninstall(); err == nil || !errors.Is(err, startup.ErrOwnershipChanged) {
		t.Fatalf("Uninstall() error = %v, want ownership error", err)
	}
}

func TestInstallRefusesToOverwriteAnotherBigDucksEntry(t *testing.T) {
	other := `"C:\Other\tool.exe" --startup`
	registry := &fakeRegistry{values: map[string]string{"BigDucksLive": other}}
	metadata := filepath.Join(t.TempDir(), "startup.json")
	manager := startup.NewManager(registry, metadata, `C:\Tools\BigDucks.exe`)
	if err := manager.Install(); !errors.Is(err, startup.ErrOwnershipChanged) {
		t.Fatalf("Install() error = %v, want ownership error", err)
	}
	if registry.values["BigDucksLive"] != other {
		t.Fatal("foreign BIG DUCKS entry was changed")
	}
}

func TestMigrateLegacyStartupMovesOwnedValue(t *testing.T) {
	legacy := `"C:\Tools\DiscordStream.exe" --startup`
	registry := &fakeRegistry{values: map[string]string{"DiscordStream": legacy}}
	if err := startup.MigrateLegacyStartup(registry); err != nil {
		t.Fatalf("MigrateLegacyStartup() error = %v", err)
	}
	if registry.values["BigDucksLive"] != legacy {
		t.Fatalf("migrated value = %q", registry.values["BigDucksLive"])
	}
	if _, exists := registry.values["DiscordStream"]; exists {
		t.Fatal("legacy startup value was not removed")
	}
}

func TestUninstallRestoresAnExistingEmptyDiscordValue(t *testing.T) {
	registry := &fakeRegistry{values: map[string]string{"Discord": ""}}
	metadata := filepath.Join(t.TempDir(), "startup.json")
	manager := startup.NewManager(registry, metadata, `C:\Tools\BigDucks.exe`)
	if err := manager.Install(); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	if err := manager.Uninstall(); err != nil {
		t.Fatalf("Uninstall() error = %v", err)
	}
	value, exists := registry.values["Discord"]
	if !exists || value != "" {
		t.Fatalf("restored Discord value = %q, exists = %t", value, exists)
	}
}
