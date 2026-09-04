package app_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

func TestDefaultConfigUsesGatewayOnlyDefaults(t *testing.T) {
	config := app.DefaultConfig()
	if config.ProxySourceURL != proxy.DefaultSourceURL {
		t.Fatalf("ProxySourceURL = %q", config.ProxySourceURL)
	}
	if len(config.RoutedHosts) != 2 || config.RoutedHosts[0] != "gateway.discord.gg" || config.RoutedHosts[1] != "remote-auth-gateway.discord.gg" {
		t.Fatalf("RoutedHosts = %#v", config.RoutedHosts)
	}
	if config.ProbeTimeout != 6*time.Second || config.StartupBudget != 12*time.Second || config.CacheTTL != 24*time.Hour {
		t.Fatalf("unexpected timeouts: probe=%v startup=%v cache=%v", config.ProbeTimeout, config.StartupBudget, config.CacheTTL)
	}
	if config.RoutingMode != app.RoutingModeGateway {
		t.Fatalf("RoutingMode = %q, want %q", config.RoutingMode, app.RoutingModeGateway)
	}
	if config.AutoStartDiscord || config.AllowDirectFallback || config.AggressiveRecovery {
		t.Fatalf("unsafe defaults: autoStart=%t directFallback=%t aggressive=%t", config.AutoStartDiscord, config.AllowDirectFallback, config.AggressiveRecovery)
	}
	if config.RelayPort != 55367 || config.PACPort != 55368 {
		t.Fatalf("runtime ports = relay %d PAC %d", config.RelayPort, config.PACPort)
	}
	if config.HeartbeatInterval != 30*time.Second || config.HeartbeatTimeout != 4*time.Second || config.RecoveryWait != 12*time.Second || config.HuntCooldown != 3*time.Minute || config.MinReserves != 2 {
		t.Fatalf("unexpected recovery defaults: heartbeat=%v timeout=%v wait=%v cooldown=%v reserves=%d", config.HeartbeatInterval, config.HeartbeatTimeout, config.RecoveryWait, config.HuntCooldown, config.MinReserves)
	}
}

func TestDefaultConfigDisablesTelemetry(t *testing.T) {
	if app.DefaultConfig().TelemetryEnabled {
		t.Fatal("telemetry must be disabled by default")
	}
}

func TestLoadConfigWithoutTelemetryFieldKeepsItDisabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"routingMode":"gateway"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := app.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.TelemetryEnabled {
		t.Fatal("legacy config enabled telemetry")
	}
}

func TestTelemetryConfigRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	config := app.DefaultConfig()
	config.TelemetryEnabled = true
	if err := app.SaveConfig(path, config); err != nil {
		t.Fatal(err)
	}
	loaded, err := app.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.TelemetryEnabled {
		t.Fatal("telemetry opt-in was not persisted")
	}
}

func TestLegacyConfigPreservesAutomaticDiscordStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"routingMode":"gateway"}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	loaded, err := app.LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if !loaded.AutoStartDiscord {
		t.Fatal("legacy config unexpectedly disabled automatic Discord startup")
	}
}

func TestSavedSafeConfigKeepsAutomaticDiscordStartupDisabled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := app.SaveConfig(path, app.DefaultConfig()); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}
	loaded, err := app.LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if loaded.AutoStartDiscord {
		t.Fatal("saved safe config enabled automatic Discord startup")
	}
}

func TestConfigRoundTripPersistsSupportedOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := app.DefaultConfig()
	original.Disabled = true
	original.AutoStartDiscord = true
	original.AllowDirectFallback = true
	original.AggressiveRecovery = true
	original.ProxySourceURL = "https://proxy.example/list"
	original.CacheTTL = 2 * time.Hour
	original.ProbeTimeout = 3 * time.Second
	original.RoutingMode = app.RoutingModeFull
	original.ExcludedCountries = map[string]bool{"BR": true, "US": true}
	original.RelayPort = 56367
	original.PACPort = 56368
	if err := app.SaveConfig(path, original); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}
	original.CacheTTL = 3 * time.Hour
	if err := app.SaveConfig(path, original); err != nil {
		t.Fatalf("second SaveConfig() error = %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("config file was not created: %v", err)
	}
	loaded, err := app.LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if !loaded.Disabled || !loaded.AutoStartDiscord || !loaded.AllowDirectFallback || !loaded.AggressiveRecovery || loaded.ProxySourceURL != original.ProxySourceURL || loaded.CacheTTL != original.CacheTTL || loaded.ProbeTimeout != original.ProbeTimeout || loaded.RoutingMode != app.RoutingModeFull || loaded.RelayPort != original.RelayPort || loaded.PACPort != original.PACPort {
		t.Fatalf("loaded overrides = %#v", loaded)
	}
	if !loaded.ExcludedCountries["BR"] || !loaded.ExcludedCountries["US"] {
		t.Fatalf("loaded countries = %#v", loaded.ExcludedCountries)
	}
}
