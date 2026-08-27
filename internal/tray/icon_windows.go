//go:build windows

package tray

import "github.com/alikwelyn/bigducks-live/internal/brand"

func Icon() []byte {
	icon, err := brand.IconICO()
	if err != nil {
		return nil
	}
	return icon
}
