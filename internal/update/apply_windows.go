//go:build windows

package update

import (
	"context"
	"errors"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func waitForProcesses(ctx context.Context, processIDs []int) error {
	for _, processID := range processIDs {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(processID))
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue
		}
		if err != nil {
			continue
		}
		for {
			result, waitErr := windows.WaitForSingleObject(handle, 250)
			if waitErr != nil {
				_ = windows.CloseHandle(handle)
				return waitErr
			}
			if result == windows.WAIT_OBJECT_0 {
				break
			}
			select {
			case <-ctx.Done():
				_ = windows.CloseHandle(handle)
				return ctx.Err()
			default:
			}
		}
		_ = windows.CloseHandle(handle)
	}
	return nil
}

func configureDetachedProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
}
