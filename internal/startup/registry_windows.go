//go:build windows

package startup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
	"golang.org/x/sys/windows/registry"
)

const (
	RunKeyPath         = `Software\Microsoft\Windows\CurrentVersion\Run`
	DiscordValue       = "Discord"
	StartupValue       = "BigDucksLive"
	LegacyStartupValue = "DiscordStream"
)

var (
	ErrValueNotFound    = errors.New("startup value not found")
	ErrOwnershipChanged = errors.New("BIG DUCKS startup ownership changed")
)

type Registry interface {
	GetString(name string) (string, error)
	SetString(name, value string) error
	DeleteValue(name string) error
}

type Manager struct {
	registry      Registry
	metadata      string
	helperPath    string
	closeRegistry func() error
}

type metadataFile struct {
	OriginalValue   string
	OriginalPresent bool
	HelperPath      string
}

type Status struct {
	Installed     bool
	HelperPath    string
	OriginalValue string
	CurrentValue  string
}

func NewManager(registry Registry, metadataPath, helperPath string) *Manager {
	return &Manager{registry: registry, metadata: metadataPath, helperPath: helperPath}
}

func (m *Manager) Install() error {
	if m == nil || m.registry == nil {
		return errors.New("startup registry is required")
	}
	if m.helperPath == "" || m.metadata == "" {
		return errors.New("startup paths are required")
	}
	expected := commandFor(m.helperPath)
	stored, exists, err := m.readMetadata()
	if err != nil {
		return err
	}
	current, currentErr := m.registry.GetString(StartupValue)
	if currentErr != nil && !errors.Is(currentErr, ErrValueNotFound) {
		return fmt.Errorf("check BIG DUCKS startup value: %w", currentErr)
	}
	if exists {
		if stored.HelperPath == m.helperPath {
			if currentErr == nil && current == expected {
				return nil
			}
			if currentErr == nil && current != expected {
				return ErrOwnershipChanged
			}
		} else {
			if currentErr != nil || current != commandFor(stored.HelperPath) {
				return ErrOwnershipChanged
			}
			stored.HelperPath = m.helperPath
		}
	} else {
		if currentErr == nil {
			return ErrOwnershipChanged
		}
		original, getErr := m.registry.GetString(DiscordValue)
		if errors.Is(getErr, ErrValueNotFound) {
			stored = metadataFile{HelperPath: m.helperPath}
		} else if getErr != nil {
			return fmt.Errorf("read Discord startup value: %w", getErr)
		} else {
			stored = metadataFile{OriginalValue: original, OriginalPresent: true, HelperPath: m.helperPath}
		}
	}
	if err := m.writeMetadata(stored); err != nil {
		return err
	}

	if err := m.registry.SetString(StartupValue, expected); err != nil {
		return fmt.Errorf("set BIG DUCKS startup value: %w", err)
	}
	if _, getErr := m.registry.GetString(DiscordValue); getErr == nil {
		if err := m.registry.DeleteValue(DiscordValue); err != nil {
			_ = m.registry.DeleteValue(StartupValue)
			return fmt.Errorf("remove direct Discord startup value: %w", err)
		}
	} else if !errors.Is(getErr, ErrValueNotFound) {
		return fmt.Errorf("check Discord startup value: %w", getErr)
	}
	return nil
}

func (m *Manager) Uninstall() error {
	if m == nil || m.registry == nil {
		return errors.New("startup registry is required")
	}
	stored, exists, err := m.readMetadata()
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if stored.HelperPath != m.helperPath {
		return ErrOwnershipChanged
	}
	current, getErr := m.registry.GetString(StartupValue)
	if errors.Is(getErr, ErrValueNotFound) {
		return ErrOwnershipChanged
	}
	if getErr != nil {
		return fmt.Errorf("read BIG DUCKS startup value: %w", getErr)
	}
	if current != commandFor(m.helperPath) {
		return ErrOwnershipChanged
	}
	if err := m.registry.DeleteValue(StartupValue); err != nil {
		return fmt.Errorf("remove BIG DUCKS startup value: %w", err)
	}
	if stored.OriginalPresent || stored.OriginalValue != "" {
		if err := m.registry.SetString(DiscordValue, stored.OriginalValue); err != nil {
			_ = m.registry.SetString(StartupValue, current)
			return fmt.Errorf("restore Discord startup value: %w", err)
		}
	}
	if err := os.Remove(m.metadata); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove startup metadata: %w", err)
	}
	return nil
}

func (m *Manager) Status() (Status, error) {
	if m == nil || m.registry == nil {
		return Status{}, errors.New("startup registry is required")
	}
	stored, exists, err := m.readMetadata()
	if err != nil {
		return Status{}, err
	}
	status := Status{}
	if exists {
		status.HelperPath = stored.HelperPath
		status.OriginalValue = stored.OriginalValue
	}
	current, getErr := m.registry.GetString(StartupValue)
	if errors.Is(getErr, ErrValueNotFound) {
		return status, nil
	}
	if getErr != nil {
		return Status{}, fmt.Errorf("read BIG DUCKS startup value: %w", getErr)
	}
	status.CurrentValue = current
	status.Installed = exists && stored.HelperPath == m.helperPath && current == commandFor(m.helperPath)
	return status, nil
}

func (m *Manager) Close() error {
	if m == nil || m.closeRegistry == nil {
		return nil
	}
	return m.closeRegistry()
}

func (m *Manager) readMetadata() (metadataFile, bool, error) {
	data, err := os.ReadFile(m.metadata)
	if errors.Is(err, os.ErrNotExist) {
		return metadataFile{}, false, nil
	}
	if err != nil {
		return metadataFile{}, false, fmt.Errorf("read startup metadata: %w", err)
	}
	var stored metadataFile
	if err := json.Unmarshal(data, &stored); err != nil {
		return metadataFile{}, false, fmt.Errorf("decode startup metadata: %w", err)
	}
	return stored, true, nil
}

func (m *Manager) writeMetadata(stored metadataFile) error {
	if err := os.MkdirAll(filepath.Dir(m.metadata), 0o700); err != nil {
		return fmt.Errorf("create startup metadata directory: %w", err)
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return fmt.Errorf("encode startup metadata: %w", err)
	}
	temporary := m.metadata + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("write startup metadata: %w", err)
	}
	if err := fileutil.Replace(temporary, m.metadata); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace startup metadata: %w", err)
	}
	return nil
}

func commandFor(path string) string {
	return `"` + strings.ReplaceAll(path, `"`, `\"`) + `" --startup`
}

type windowsRegistry struct{ key registry.Key }

func (r *windowsRegistry) GetString(name string) (string, error) {
	value, _, err := r.key.GetStringValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return "", ErrValueNotFound
	}
	return value, err
}

func (r *windowsRegistry) SetString(name, value string) error {
	return r.key.SetStringValue(name, value)
}

func (r *windowsRegistry) DeleteValue(name string) error {
	err := r.key.DeleteValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return ErrValueNotFound
	}
	return err
}

func NewWindowsManager(helperPath string) (*Manager, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return nil, errors.New("LOCALAPPDATA is empty")
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, RunKeyPath, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return nil, fmt.Errorf("open Windows startup registry key: %w", err)
	}
	backend := &windowsRegistry{key: key}
	if err := MigrateLegacyStartup(backend); err != nil {
		_ = key.Close()
		return nil, err
	}
	manager := NewManager(backend, filepath.Join(local, "DiscordStream", "startup.json"), helperPath)
	manager.closeRegistry = backend.key.Close
	return manager, nil
}

func MigrateLegacyStartup(registry Registry) error {
	if registry == nil {
		return errors.New("startup registry is required")
	}
	if _, err := registry.GetString(StartupValue); err == nil {
		return nil
	} else if !errors.Is(err, ErrValueNotFound) {
		return err
	}
	legacy, err := registry.GetString(LegacyStartupValue)
	if errors.Is(err, ErrValueNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := registry.SetString(StartupValue, legacy); err != nil {
		return fmt.Errorf("migrate BIG DUCKS startup value: %w", err)
	}
	if err := registry.DeleteValue(LegacyStartupValue); err != nil && !errors.Is(err, ErrValueNotFound) {
		_ = registry.DeleteValue(StartupValue)
		return fmt.Errorf("remove legacy startup value: %w", err)
	}
	return nil
}

func NewPlatformManager(helperPath string) (*Manager, error) {
	return NewWindowsManager(helperPath)
}
