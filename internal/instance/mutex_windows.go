//go:build windows

package instance

import (
	"errors"

	"golang.org/x/sys/windows"
)

const DefaultName = `Local\BigDucks.Live.Helper`

func AcquireNamed(name string) (func(), bool, error) {
	if name == "" {
		return nil, false, errors.New("mutex name is empty")
	}
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, false, err
	}
	handle, createErr := windows.CreateMutex(nil, true, namePtr)
	if createErr != nil && !errors.Is(createErr, windows.ERROR_ALREADY_EXISTS) {
		return nil, false, createErr
	}
	alreadyRunning := errors.Is(createErr, windows.ERROR_ALREADY_EXISTS)
	release := func() {
		if !alreadyRunning {
			_ = windows.ReleaseMutex(handle)
		}
		_ = windows.CloseHandle(handle)
	}
	return release, alreadyRunning, nil
}

func Acquire() (func(), bool, error) {
	return AcquireNamed(DefaultName)
}
