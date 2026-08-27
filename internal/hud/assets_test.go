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
