//go:build windows

package tray_test

import (
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/tray"
)

func TestIconReturnsICOData(t *testing.T) {
	data := tray.Icon()
	if len(data) < 1024 {
		t.Fatalf("icon length = %d, want a multi-resolution icon", len(data))
	}
	if data[0] != 0 || data[1] != 0 || data[2] != 1 || data[3] != 0 {
		t.Fatalf("icon is not an ICO file")
	}
	if data[4] != 7 || data[5] != 0 {
		t.Fatalf("icon frame count = %d, want 7", data[4])
	}
}
