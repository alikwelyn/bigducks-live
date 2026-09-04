//go:build windows

package hud

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/alikwelyn/bigducks-live/internal/instance"
)

const (
	HUDMutexName   = `Local\BigDucks.Live.HUD`
	HUDWindowTitle = "BIG DUCKS LIVE"
)

var (
	user32Window              = windows.NewLazySystemDLL("user32.dll")
	findWindowW               = user32Window.NewProc("FindWindowW")
	showWindow                = user32Window.NewProc("ShowWindow")
	setForegroundWindow       = user32Window.NewProc("SetForegroundWindow")
	postMessageW              = user32Window.NewProc("PostMessageW")
	getWindowThreadProcessIDW = user32Window.NewProc("GetWindowThreadProcessId")
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

const (
	wmClose   = uintptr(0x0010)
	swRestore = 9
)

type hudWindowFunctions struct {
	find      func() uintptr
	post      func(hwnd, message, wParam, lParam uintptr) bool
	terminate func(hwnd uintptr) error
}

func findExistingWindow() uintptr {
	title, err := windows.UTF16PtrFromString(HUDWindowTitle)
	if err != nil {
		return 0
	}
	handle, _, _ := findWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	return handle
}

func ActivateExisting() bool {
	handle := findExistingWindow()
	if handle == 0 {
		return false
	}
	showWindow.Call(handle, swRestore)
	setForegroundWindow.Call(handle)
	return true
}

func CloseExisting(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return closeExistingWindow(ctx, hudWindowFunctions{
		find: findExistingWindow,
		post: func(hwnd, message, wParam, lParam uintptr) bool {
			result, _, _ := postMessageW.Call(hwnd, message, wParam, lParam)
			return result != 0
		},
		terminate: terminateHUDWindow,
	})
}

func closeExistingWindow(ctx context.Context, functions hudWindowFunctions) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if functions.find == nil {
		return nil
	}
	handle := functions.find()
	if handle == 0 {
		return nil
	}
	if functions.post == nil || !functions.post(handle, wmClose, 0, 0) {
		return fmt.Errorf("post WM_CLOSE to HUD window failed")
	}
	poll := time.NewTicker(25 * time.Millisecond)
	defer poll.Stop()
	for {
		if functions.find() == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			if functions.terminate == nil {
				return ctx.Err()
			}
			if err := functions.terminate(handle); err != nil {
				return fmt.Errorf("terminate HUD process: %w", err)
			}
			return nil
		case <-poll.C:
		}
	}
}

func terminateHUDWindow(handle uintptr) error {
	var pid uint32
	if result, _, err := getWindowThreadProcessIDW.Call(handle, uintptr(unsafe.Pointer(&pid))); result == 0 || pid == 0 {
		if err != nil {
			return err
		}
		return fmt.Errorf("HUD process id is unavailable")
	}
	if err := exec.Command("taskkill.exe", "/PID", strconv.FormatUint(uint64(pid), 10), "/T", "/F").Run(); err != nil {
		return err
	}
	return nil
}
