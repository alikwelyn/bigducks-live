package hud_test

import (
	"strings"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/hud"
)

func TestPageContainsAccessibleRecoveryControls(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{
		"BIG DUCKS", "Liberar live", "Testar conexão", "Recarregar Discord",
		`aria-live="polite"`, `:focus-visible`, `prefers-reduced-motion`,
		"data:image/png;base64,", "bigDucksStatus", "bigDucksReconnect",
		"TELEMETRIA SENTRY", "bigDucksTelemetryEnable", "bigDucksTelemetryDisable",
		"bigDucksTelemetryTest", "bigDucksTelemetryPurge", "telemetry-enabled",
		"STATUS DA LIVE", "Live liberada", "Liberar live", "Preparando acesso",
		"Liberando acesso", "Buscando acesso", "Live não liberada", "Live sem proteção",
		"Testar conexão",
	} {
		if !strings.Contains(page, required) {
			t.Fatalf("HUD page does not contain %q", required)
		}
	}
	if strings.Contains(page, "{{") {
		t.Fatal("HUD page contains an unresolved asset placeholder")
	}
}

func TestTelemetryCardUsesCompactHorizontalLayout(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{
		"grid-template-columns: minmax(0, 1fr) max-content",
		"grid-row: 1 / 4",
		"min-height: 44px",
	} {
		if !strings.Contains(page, required) {
			t.Fatalf("HUD telemetry layout does not contain %q", required)
		}
	}
}

func TestTelemetryUsesAccessibleSwitchControl(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{
		`id="telemetry-toggle"`, `role="switch"`, `aria-checked="true"`,
		`id="telemetry-toggle-label"`, "telemetry-toggle",
	} {
		if !strings.Contains(page, required) {
			t.Fatalf("HUD telemetry switch does not contain %q", required)
		}
	}
}

func TestPageContainsTelemetryControlsAndPrivacyCopy(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{
		"A telemetria começa ativada", "Não envia IP", "tokens",
		"fila local", "confirm", "Telemetria desativada",
	} {
		if !strings.Contains(page, required) {
			t.Fatalf("HUD page does not contain %q", required)
		}
	}
}

func TestPageContainsNativeMediaDiagnosis(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{"diagnóstico RTC nativo", "somente leitura", "nenhum SSRC"} {
		if !strings.Contains(page, required) {
			t.Fatalf("HUD page does not contain %q", required)
		}
	}
}

func TestPageUsesFixedLandscapeDashboardWithoutDocumentZoomOrScroll(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{
		`class="dashboard"`, `class="left-column"`, `overflow: hidden`,
		`user-scalable=no`, `event.preventDefault()`, `"wheel"`,
		`setTimeout(checkUpdate, 1200)`, `bigDucksUpdateStatus`, `touch-action: manipulation`,
	} {
		if !strings.Contains(page, required) {
			t.Fatalf("landscape HUD page does not contain %q", required)
		}
	}
}
