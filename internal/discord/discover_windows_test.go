//go:build windows

package discord_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/discord"
)

func TestFindLatestReturnsNewestDiscordExecutable(t *testing.T) {
	root := t.TempDir()
	for _, version := range []string{"1.0.9208", "1.0.9253"} {
		path := filepath.Join(root, "app-"+version, "Discord.exe")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(path, []byte(version), 0o600); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "app-1.0.9999"), 0o700); err != nil {
		t.Fatalf("MkdirAll() missing executable error = %v", err)
	}

	got, err := discord.FindLatest(root)
	if err != nil {
		t.Fatalf("FindLatest() error = %v", err)
	}
	want := filepath.Join(root, "app-1.0.9253", "Discord.exe")
	if got != want {
		t.Fatalf("FindLatest() = %q, want %q", got, want)
	}
}

func TestFindLatestReturnsErrorWhenNoExecutableExists(t *testing.T) {
	_, err := discord.FindLatest(t.TempDir())
	if err == nil {
		t.Fatal("expected missing Discord error")
	}
}

func TestFindLatestForCanaryExecutable(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "app-1.0.1187", "DiscordCanary.exe")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("canary"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := discord.FindLatestFor(root, "DiscordCanary.exe")
	if err != nil {
		t.Fatalf("FindLatestFor() error = %v", err)
	}
	if got != path {
		t.Fatalf("FindLatestFor() = %q, want %q", got, path)
	}
	if _, err := discord.FindLatest(root); err == nil {
		t.Fatal("FindLatest() must not match a Canary-only install")
	}
}
