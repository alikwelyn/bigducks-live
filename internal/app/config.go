package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/discord"
	"github.com/alikwelyn/bigducks-live/internal/fileutil"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
)

const (
	ConfigFileName = "config.json"
	StateFileName  = "state.json"
	LogFileName    = "discordstream.log"
)

type RoutingMode string

const (
	RoutingModeGateway RoutingMode = "gateway"
	RoutingModeFull    RoutingMode = "full"
)

type Config struct {
	DataDir             string
	DiscordRoot         string
	Disabled            bool
	AutoStartDiscord    bool
	AllowDirectFallback bool
	AggressiveRecovery  bool
	TelemetryEnabled    bool
	RoutingMode         RoutingMode
	ProxySourceURL      string
	RoutedHosts         []string
	RoutedSuffixes      []string
	ExcludedCountries   map[string]bool
	ProbeTimeout        time.Duration
	StartupBudget       time.Duration
	CacheTTL            time.Duration
	MaxCandidates       int
	PoolSize            int
	ProbeWorkers        int
	HeartbeatInterval   time.Duration
	HeartbeatTimeout    time.Duration
	RecoveryWait        time.Duration
	HuntCooldown        time.Duration
	MinReserves         int
	RelayPort           int
	PACPort             int
	DynamicRuntimePorts bool
}

type persistedConfig struct {
	Disabled            bool     `json:"disabled,omitempty"`
	AutoStartDiscord    *bool    `json:"autoStartDiscord,omitempty"`
	AllowDirectFallback bool     `json:"allowDirectFallback,omitempty"`
	AggressiveRecovery  bool     `json:"aggressiveRecovery,omitempty"`
	TelemetryEnabled    *bool    `json:"telemetryEnabled"`
	RoutingMode         string   `json:"routingMode,omitempty"`
	ProxySourceURL      string   `json:"proxySourceURL,omitempty"`
	CacheTTL            string   `json:"cacheTTL,omitempty"`
	ProbeTimeout        string   `json:"probeTimeout,omitempty"`
	ExcludedCountries   []string `json:"excludedCountries,omitempty"`
	RelayPort           int      `json:"relayPort,omitempty"`
	PACPort             int      `json:"pacPort,omitempty"`
}

func DefaultConfig() Config {
	excluded := map[string]bool{"BR": true}
	return Config{
		DataDir:           defaultDataDir(),
		DiscordRoot:       discord.DefaultRoot(),
		RoutingMode:       RoutingModeGateway,
		TelemetryEnabled:  true,
		ProxySourceURL:    proxy.DefaultSourceURL,
		RoutedHosts:       []string{"gateway.discord.gg", "remote-auth-gateway.discord.gg"},
		RoutedSuffixes:    []string{"discord.gg"},
		ExcludedCountries: excluded,
		ProbeTimeout:      6 * time.Second,
		StartupBudget:     12 * time.Second,
		CacheTTL:          24 * time.Hour,
		MaxCandidates:     proxy.MaxCandidates,
		PoolSize:          3,
		ProbeWorkers:      10,
		HeartbeatInterval: 30 * time.Second,
		HeartbeatTimeout:  4 * time.Second,
		RecoveryWait:      12 * time.Second,
		HuntCooldown:      3 * time.Minute,
		MinReserves:       2,
		RelayPort:         55367,
		PACPort:           55368,
	}
}

func defaultDataDir() string {
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		return filepath.Join(local, "DiscordStream")
	}
	if configDir, err := os.UserConfigDir(); err == nil && configDir != "" {
		return filepath.Join(configDir, "DiscordStream")
	}
	return filepath.Join(os.TempDir(), "DiscordStream")
}

func (c Config) normalized() Config {
	defaults := DefaultConfig()
	if c.DataDir == "" {
		c.DataDir = defaults.DataDir
	}
	if c.DiscordRoot == "" {
		c.DiscordRoot = defaults.DiscordRoot
	}
	if c.ProxySourceURL == "" {
		c.ProxySourceURL = defaults.ProxySourceURL
	}
	if c.RoutingMode != RoutingModeFull {
		c.RoutingMode = defaults.RoutingMode
	}
	if len(c.RoutedHosts) == 0 {
		c.RoutedHosts = append([]string(nil), defaults.RoutedHosts...)
	}
	if len(c.RoutedSuffixes) == 0 {
		c.RoutedSuffixes = append([]string(nil), defaults.RoutedSuffixes...)
	}
	if c.ExcludedCountries == nil {
		c.ExcludedCountries = cloneCountries(defaults.ExcludedCountries)
	} else {
		c.ExcludedCountries = normalizeCountries(c.ExcludedCountries)
	}
	if c.ProbeTimeout <= 0 {
		c.ProbeTimeout = defaults.ProbeTimeout
	}
	if c.StartupBudget <= 0 {
		c.StartupBudget = defaults.StartupBudget
	}
	if c.CacheTTL <= 0 {
		c.CacheTTL = defaults.CacheTTL
	}
	if c.MaxCandidates <= 0 {
		c.MaxCandidates = defaults.MaxCandidates
	}
	if c.PoolSize <= 0 {
		c.PoolSize = defaults.PoolSize
	}
	if c.ProbeWorkers <= 0 {
		c.ProbeWorkers = defaults.ProbeWorkers
	}
	if c.HeartbeatInterval <= 0 {
		c.HeartbeatInterval = defaults.HeartbeatInterval
	}
	if c.HeartbeatTimeout <= 0 {
		c.HeartbeatTimeout = defaults.HeartbeatTimeout
	}
	if c.RecoveryWait <= 0 {
		c.RecoveryWait = defaults.RecoveryWait
	}
	if c.HuntCooldown <= 0 {
		c.HuntCooldown = defaults.HuntCooldown
	}
	if c.MinReserves < 1 {
		c.MinReserves = defaults.MinReserves
	}
	if c.RelayPort < 1 || c.RelayPort > 65535 {
		c.RelayPort = defaults.RelayPort
	}
	if c.PACPort < 1 || c.PACPort > 65535 {
		c.PACPort = defaults.PACPort
	}
	return c
}

func LoadConfig(path string) (Config, error) {
	config := DefaultConfig()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	var stored persistedConfig
	if err := json.Unmarshal(data, &stored); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	if stored.ProxySourceURL != "" {
		config.ProxySourceURL = stored.ProxySourceURL
	}
	if stored.RoutingMode != "" {
		config.RoutingMode = RoutingMode(stored.RoutingMode)
	}
	config.Disabled = stored.Disabled
	if stored.AutoStartDiscord == nil {
		// Configurations written before autoStartDiscord existed implicitly
		// started Discord. Keep that behavior for existing installations; a
		// newly created configuration still uses the safe default (false).
		config.AutoStartDiscord = true
	} else {
		config.AutoStartDiscord = *stored.AutoStartDiscord
	}
	config.AllowDirectFallback = stored.AllowDirectFallback
	config.AggressiveRecovery = stored.AggressiveRecovery
	if stored.TelemetryEnabled != nil {
		config.TelemetryEnabled = *stored.TelemetryEnabled
	}
	if stored.RelayPort > 0 {
		config.RelayPort = stored.RelayPort
	}
	if stored.PACPort > 0 {
		config.PACPort = stored.PACPort
	}
	if stored.CacheTTL != "" {
		value, parseErr := time.ParseDuration(stored.CacheTTL)
		if parseErr != nil || value <= 0 {
			return Config{}, fmt.Errorf("invalid cacheTTL %q", stored.CacheTTL)
		}
		config.CacheTTL = value
	}
	if stored.ProbeTimeout != "" {
		value, parseErr := time.ParseDuration(stored.ProbeTimeout)
		if parseErr != nil || value <= 0 {
			return Config{}, fmt.Errorf("invalid probeTimeout %q", stored.ProbeTimeout)
		}
		config.ProbeTimeout = value
	}
	if stored.ExcludedCountries != nil {
		config.ExcludedCountries = make(map[string]bool, len(stored.ExcludedCountries))
		for _, country := range stored.ExcludedCountries {
			country = strings.ToUpper(strings.TrimSpace(country))
			if country != "" {
				config.ExcludedCountries[country] = true
			}
		}
	}
	return config.normalized(), nil
}

func SaveConfig(path string, config Config) error {
	config = config.normalized()
	countries := make([]string, 0, len(config.ExcludedCountries))
	for country, excluded := range config.ExcludedCountries {
		if excluded {
			countries = append(countries, country)
		}
	}
	sort.Strings(countries)
	data, err := json.MarshalIndent(persistedConfig{
		Disabled:            config.Disabled,
		AutoStartDiscord:    boolPointer(config.AutoStartDiscord),
		AllowDirectFallback: config.AllowDirectFallback,
		AggressiveRecovery:  config.AggressiveRecovery,
		TelemetryEnabled:    boolPointer(config.TelemetryEnabled),
		RoutingMode:         string(config.RoutingMode),
		ProxySourceURL:      config.ProxySourceURL,
		CacheTTL:            config.CacheTTL.String(),
		ProbeTimeout:        config.ProbeTimeout.String(),
		ExcludedCountries:   countries,
		RelayPort:           config.RelayPort,
		PACPort:             config.PACPort,
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := fileutil.Replace(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

func boolPointer(value bool) *bool {
	return &value
}

func cloneCountries(source map[string]bool) map[string]bool {
	result := make(map[string]bool, len(source))
	for country, excluded := range source {
		result[country] = excluded
	}
	return result
}

func normalizeCountries(source map[string]bool) map[string]bool {
	result := make(map[string]bool, len(source))
	for country, excluded := range source {
		country = strings.ToUpper(strings.TrimSpace(country))
		if country != "" {
			result[country] = excluded
		}
	}
	return result
}
