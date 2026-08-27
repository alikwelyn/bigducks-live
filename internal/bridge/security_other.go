//go:build !windows

package bridge

import "os"

func secureUserOnly(_ string) error {
	return nil
}

func ProtectDataDirectory(path string) error {
	return os.MkdirAll(path, 0o700)
}
