package app_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/app"
)

func TestRunDryRunBuildsLocalInfrastructureWithoutLaunchingDiscord(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Discord")
	discordPath := filepath.Join(root, "app-1.0.1", "Discord.exe")
	if err := os.MkdirAll(filepath.Dir(discordPath), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(discordPath, []byte("test"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	config := app.DefaultConfig()
	config.DiscordRoot = root
	config.DataDir = t.TempDir()
	config.DynamicRuntimePorts = true
	if err := app.Run(context.Background(), app.RunOptions{Config: config, DryRun: true, SkipProxyFetch: true, MutexHeld: true}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
}
