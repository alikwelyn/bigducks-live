//go:build windows

package hud

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/alikwelyn/bigducks-live/internal/instance"
)

const (
	HUDMutexName   = `Local\BigDucks.Live.HUD`
	HUDWindowTitle = "BIG DUCKS LIVE"
)

var (
	user32Window        = windows.NewLazySystemDLL("user32.dll")
	findWindowW         = user32Window.NewProc("FindWindowW")
	showWindow          = user32Window.NewProc("ShowWindow")
	setForegroundWindow = user32Window.NewProc("SetForegroundWindow")
)

type hudAcquire func() (release func(), alreadyRunning bool, err error)

func runSingleHUD(acquire hudAcquire, activate func() bool, runWindow func() error) error {
	release, alreadyRunning, err := acquire()
	if err != nil {
		return err
	}
	if release != nil {
		defer release()
	}
	if alreadyRunning {
		activate()
		return nil
	}
	return runWindow()
}

func acquireHUD() (func(), bool, error) {
	release, alreadyRunning, err := instance.AcquireNamed(HUDMutexName)
	if err != nil {
		return nil, false, fmt.Errorf("acquire HUD mutex: %w", err)
	}
	return release, alreadyRunning, nil
}

func ActivateExisting() bool {
	title, err := windows.UTF16PtrFromString(HUDWindowTitle)
	if err != nil {
		return false
	}
	handle, _, _ := findWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	if handle == 0 {
		return false
	}
	const swRestore = 9
	showWindow.Call(handle, swRestore)
	setForegroundWindow.Call(handle)
	return true
}
