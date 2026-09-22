//go:build windows

package discord_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/discord"
)

func TestCompanionRootsFindsSiblingInstalls(t *testing.T) {
	base := t.TempDir()
	stable := filepath.Join(base, "Discord")
	canary := filepath.Join(base, "DiscordCanary")
	ptb := filepath.Join(base, "DiscordPTB")
	for _, dir := range []string{stable, canary, ptb} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	roots := discord.CompanionRoots(stable)
	if len(roots) != 2 {
		t.Fatalf("CompanionRoots() = %#v, want Canary and PTB", roots)
	}
	found := map[string]bool{}
	for _, root := range roots {
		found[root] = true
	}
	if !found[canary] || !found[ptb] {
		t.Fatalf("CompanionRoots() = %#v, missing a sibling install", roots)
	}
}

func TestCompanionRootsSkipsMissingAndPrimary(t *testing.T) {
	base := t.TempDir()
	stable := filepath.Join(base, "Discord")
	if err := os.MkdirAll(stable, 0o700); err != nil {
		t.Fatal(err)
	}
	if roots := discord.CompanionRoots(stable); len(roots) != 0 {
		t.Fatalf("CompanionRoots() = %#v, want none", roots)
	}
}

func TestBuildArgsUsesOnlyPACProxyConfiguration(t *testing.T) {
	args := discord.BuildArgs("http://127.0.0.1:4567/proxy.pac")
	if len(args) != 1 || args[0] != "--proxy-pac-url=http://127.0.0.1:4567/proxy.pac" {
		t.Fatalf("BuildArgs() = %#v", args)
	}
	for _, arg := range args {
		if arg == "--proxy-server" || arg == "--proxy-pac-url" {
			t.Fatalf("unexpected split/full-device proxy argument %q", arg)
		}
	}
}

func TestBuildFullProxyArgsBypassesOnlyDiscordMedia(t *testing.T) {
	args := discord.BuildFullProxyArgs("socks5://198.51.100.7:1080")
	if len(args) != 2 {
		t.Fatalf("BuildFullProxyArgs() = %#v", args)
	}
	if args[0] != "--proxy-server=socks5://198.51.100.7:1080" {
		t.Fatalf("proxy argument = %q", args[0])
	}
	wantBypass := "--proxy-bypass-list=cdn.discordapp.com;*.discord.media;*.discordapp.net;<local>"
	if args[1] != wantBypass {
		t.Fatalf("bypass argument = %q, want %q", args[1], wantBypass)
	}
}
