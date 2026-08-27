//go:build windows

package discord_test

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/discord"
)

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
