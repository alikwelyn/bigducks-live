package brand_test

import (
	"bytes"
	"encoding/binary"
	"image"
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
	bounds := decoded.Bounds()
	for _, point := range []image.Point{
		bounds.Min,
		{X: bounds.Max.X - 1, Y: bounds.Min.Y},
		{X: bounds.Min.X, Y: bounds.Max.Y - 1},
		{X: bounds.Max.X - 1, Y: bounds.Max.Y - 1},
	} {
		_, _, _, alpha := decoded.At(point.X, point.Y).RGBA()
		if alpha > 0x0101 {
			t.Fatalf("logo corner %v alpha = %d, want visually transparent", point, alpha)
		}
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
