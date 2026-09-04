//go:build !windows

package discord

func CurrentProcess() (ProcessIdentity, error) {
	return ProcessIdentity{}, nil
}
