//go:build windows

package hud

import (
	"unsafe"

	webview "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

type windowRect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type monitorInfo struct {
	Size    uint32
	Monitor windowRect
	Work    windowRect
	Flags   uint32
}

var (
	hudUser32             = windows.NewLazySystemDLL("User32.dll")
	pHUDGetWindowRect     = hudUser32.NewProc("GetWindowRect")
	pHUDMonitorFromWindow = hudUser32.NewProc("MonitorFromWindow")
	pHUDGetMonitorInfo    = hudUser32.NewProc("GetMonitorInfoW")
	pHUDSetWindowPos      = hudUser32.NewProc("SetWindowPos")
)

func (r windowRect) width() int {
	return int(r.Right - r.Left)
}

func (r windowRect) height() int {
	return int(r.Bottom - r.Top)
}

func fitClientSize(requestedWidth, requestedHeight int, outer, workArea windowRect) (int, int) {
	frameWidth := max(0, outer.width()-requestedWidth)
	frameHeight := max(0, outer.height()-requestedHeight)
	width := min(requestedWidth, max(1, workArea.width()-frameWidth))
	height := min(requestedHeight, max(1, workArea.height()-frameHeight))
	return width, height
}

func centeredWindowOrigin(outer, workArea windowRect) (int32, int32) {
	left := workArea.Left + int32((workArea.width()-outer.width())/2)
	top := workArea.Top + int32((workArea.height()-outer.height())/2)
	return left, top
}

func fitAndCenterHUD(view webview.WebView) {
	view.SetSize(HUDWidth, HUDHeight, webview.HintFixed)
	window := uintptr(view.Window())
	if window == 0 {
		return
	}

	var outer windowRect
	if result, _, _ := pHUDGetWindowRect.Call(window, uintptr(unsafe.Pointer(&outer))); result == 0 {
		return
	}
	const monitorDefaultToNearest = 0x00000002
	monitor, _, _ := pHUDMonitorFromWindow.Call(window, monitorDefaultToNearest)
	if monitor == 0 {
		return
	}
	info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if result, _, _ := pHUDGetMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); result == 0 {
		return
	}

	width, height := fitClientSize(HUDWidth, HUDHeight, outer, info.Work)
	if width != HUDWidth || height != HUDHeight {
		view.SetSize(width, height, webview.HintFixed)
		if result, _, _ := pHUDGetWindowRect.Call(window, uintptr(unsafe.Pointer(&outer))); result == 0 {
			return
		}
	}
	left, top := centeredWindowOrigin(outer, info.Work)
	const setPositionOnly = 0x0001 | 0x0004 | 0x0010
	pHUDSetWindowPos.Call(window, 0, uintptr(uint32(left)), uintptr(uint32(top)), 0, 0, setPositionOnly)
}
