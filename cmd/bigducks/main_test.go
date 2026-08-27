//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/app"
)

func TestReadLastLogLineIgnoresStatusSnapshots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "discordstream.log")
	log := "2026-08-26T10:00:00-03:00 Discord started with gateway-only PAC routing\n" +
		"2026-08-26T10:01:00-03:00 status:\n" +
		"installed: true\n" +
		"last_result: 2026-08-26T10:00:00-03:00 Discord started with gateway-only PAC routing\n"
	if err := os.WriteFile(path, []byte(log), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	want := "2026-08-26T10:00:00-03:00 Discord started with gateway-only PAC routing"
	if got := readLastLogLine(path); got != want {
		t.Fatalf("readLastLogLine() = %q, want %q", got, want)
	}
}

func TestParseArgsAcceptsFullProxyRoutingMode(t *testing.T) {
	parsed, err := parseArgs([]string{"--full-proxy"})
	if err != nil {
		t.Fatalf("parseArgs() error = %v", err)
	}
	if parsed.routingMode != app.RoutingModeFull || parsed.mode != modeRun {
		t.Fatalf("parsed options = %#v", parsed)
	}
}

func TestParseArgsCanSkipStartupInstallation(t *testing.T) {
	parsed, err := parseArgs([]string{"--no-install", "--full-proxy"})
	if err != nil {
		t.Fatalf("parseArgs() error = %v", err)
	}
	if parsed.installStartup {
		t.Fatal("--no-install should disable startup installation")
	}
	if parsed.routingMode != app.RoutingModeFull {
		t.Fatalf("routing mode = %q, want %q", parsed.routingMode, app.RoutingModeFull)
	}
}

func TestParseArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		mode mode
	}{
		{name: "run", mode: modeRun},
		{name: "startup", args: []string{"--startup"}, mode: modeStartup},
		{name: "status", args: []string{"--status"}, mode: modeStatus},
		{name: "uninstall", args: []string{"--uninstall"}, mode: modeUninstall},
		{name: "core", args: []string{"--core"}, mode: modeCore},
		{name: "hud", args: []string{"--hud"}, mode: modeHUD},
		{name: "apply update", args: []string{"--apply-update", `C:\Data\pending-update.json`}, mode: modeApplyUpdate},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options, err := parseArgs(test.args)
			if err != nil {
				t.Fatalf("parseArgs() error = %v", err)
			}
			if options.mode != test.mode {
				t.Fatalf("mode = %v, want %v", options.mode, test.mode)
			}
		})
	}
}

func TestParseArgsRejectsApplyUpdateWithoutRequest(t *testing.T) {
	if _, err := parseArgs([]string{"--apply-update"}); err == nil {
		t.Fatal("expected missing update request error")
	}
}

func TestParseArgsRejectsUnknownFlags(t *testing.T) {
	if _, err := parseArgs([]string{"--unknown"}); err == nil {
		t.Fatal("expected unknown flag error")
	}
}

func TestParseArgsRejectsMultipleModes(t *testing.T) {
	if _, err := parseArgs([]string{"--status", "--startup"}); err == nil {
		t.Fatal("expected multiple mode error")
	}
}

func TestParseArgsRejectsMultipleRoutingModes(t *testing.T) {
	if _, err := parseArgs([]string{"--full-proxy", "--gateway-only"}); err == nil {
		t.Fatal("expected multiple routing modes to be rejected")
	}
}

func TestParseArgsRejectsNoInstallForNonRunModes(t *testing.T) {
	if _, err := parseArgs([]string{"--status", "--no-install"}); err == nil {
		t.Fatal("expected --no-install to be rejected with --status")
	}
}
