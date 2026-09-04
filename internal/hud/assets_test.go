package hud_test

import (
	"strings"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/hud"
)

func TestPageContainsAccessibleRecoveryControls(t *testing.T) {
	page := hud.PageHTML()
	for _, required := range []string{
		"BIG DUCKS", "Reconectar live", "Testar rota", "Recarregar Discord",
		`aria-live="polite"`, `:focus-visible`, `prefers-reduced-motion`,
		"data:image/png;base64,", "bigDucksStatus", "bigDucksReconnect",
	} {
		if !strings.Contains(page, required) {
			t.Fatalf("HUD page does not contain %q", required)
		}
	}
	if strings.Contains(page, "{{") {
		t.Fatal("HUD page contains an unresolved asset placeholder")
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
