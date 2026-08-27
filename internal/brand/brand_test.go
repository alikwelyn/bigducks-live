package brand_test

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/brand"
)

func TestEmbeddedLogoAndWindowsIconAreValid(t *testing.T) {
	logo := brand.LogoPNG()
	decoded, err := png.Decode(bytes.NewReader(logo))
	if err != nil {
		t.Fatalf("decode logo: %v", err)
	}
	if decoded.Bounds().Dx() != decoded.Bounds().Dy() || decoded.Bounds().Dx() < 512 {
		t.Fatalf("logo bounds = %v", decoded.Bounds())
	}
	ico, err := brand.IconICO()
	if err != nil {
		t.Fatalf("IconICO() error = %v", err)
	}
	if len(ico) < 6 || binary.LittleEndian.Uint16(ico[2:4]) != 1 {
		t.Fatal("generated icon has an invalid ICO header")
	}
	if count := binary.LittleEndian.Uint16(ico[4:6]); count != 7 {
		t.Fatalf("ICO frame count = %d, want 7", count)
	}
}
