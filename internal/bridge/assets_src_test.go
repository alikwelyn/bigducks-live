package bridge_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBridgeSourceConfiguresOptInSentryWithoutRendererInstrumentation(t *testing.T) {
	path := filepath.Join("assets-src", "discord_bridge.js")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, fragment := range []string{
		`require("@sentry/electron/main")`,
		`require("@sentry/node")`,
		"beforeSend: sanitizeElectronEvent",
		`message.type === "telemetry_sync"`,
		`message.type === "telemetry_test"`,
		`message.type === "telemetry_disable"`,
		`message.type === "telemetry_purge"`,
		`let telemetryEnabled = false`,
		`capabilities: ["telemetry"]`,
		"let telemetryConfigPromise = Promise.resolve()",
		"function queueTelemetryConfiguration",
		"await telemetryConfigPromise",
		`const accepted = captureBridgeEvent("telemetry_test", { connected: true })`,
		`void Promise.resolve(Sentry.flush(2000)).catch(() => {})`,
		`ipcMode: 0`,
	} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("source does not contain %q", fragment)
		}
	}
	if strings.Contains(text, "window.Sentry") || strings.Contains(text, "globalThis.Sentry") {
		t.Fatal("Sentry must not be installed in renderer globals")
	}
}
