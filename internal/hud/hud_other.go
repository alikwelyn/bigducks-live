//go:build !windows

package hud

import "errors"

func Run(string) error {
	return errors.New("BIG DUCKS HUD is currently available on Windows")
}
