//go:build windows

package systray

import (
	"testing"
	"unsafe"
)

func TestIsMenuNotificationSupportsClassicAndVersionFourEvents(t *testing.T) {
	tests := []struct {
		name   string
		lParam uintptr
		want   bool
	}{
		{name: "classic left button", lParam: 0x0202, want: true},
		{name: "classic right button", lParam: 0x0205, want: true},
		{name: "version four context menu", lParam: uintptr(100<<16 | 0x007B), want: true},
		{name: "version four pointer select", lParam: uintptr(100<<16 | 0x0400), want: true},
		{name: "version four keyboard select", lParam: uintptr(100<<16 | 0x0401), want: true},
		{name: "mouse move", lParam: 0x0200, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isMenuNotification(test.lParam); got != test.want {
				t.Fatalf("isMenuNotification(%#x) = %t, want %t", test.lParam, got, test.want)
			}
		})
	}
}

func TestNotifyIconDataUsesTheTimeoutVersionUnion(t *testing.T) {
	nid := notifyIconData{}
	unionOffset := unsafe.Offsetof(nid.TimeoutOrVersion)
	titleOffset := unsafe.Offsetof(nid.InfoTitle)
	if got, want := titleOffset-unionOffset, unsafe.Sizeof(uint32(0)); got != want {
		t.Fatalf("InfoTitle starts %d bytes after the union, want %d", got, want)
	}
}

func TestAddingIconNegotiatesVersionFour(t *testing.T) {
	nid := notifyIconData{}
	var calls []uintptr
	err := nid.addWith(func(message uintptr, got *notifyIconData) (uintptr, error) {
		calls = append(calls, message)
		if message == nimSetVersion && got.TimeoutOrVersion != notifyIconVersion4 {
			t.Fatalf("version = %d, want %d", got.TimeoutOrVersion, notifyIconVersion4)
		}
		return 1, nil
	})
	if err != nil {
		t.Fatalf("addWith returned %v", err)
	}
	if len(calls) != 2 || calls[0] != nimAdd || calls[1] != nimSetVersion {
		t.Fatalf("Shell_NotifyIcon calls = %#v, want NIM_ADD followed by NIM_SETVERSION", calls)
	}
}

func TestPopupSequencePostsWMNullAfterTracking(t *testing.T) {
	var calls []string
	err := runPopupSequence(
		func() (uintptr, error) {
			calls = append(calls, "track")
			return 1, nil
		},
		func() (uintptr, error) {
			calls = append(calls, "post-null")
			return 1, nil
		},
	)
	if err != nil {
		t.Fatalf("runPopupSequence returned %v", err)
	}
	if len(calls) != 2 || calls[0] != "track" || calls[1] != "post-null" {
		t.Fatalf("calls = %#v, want TrackPopupMenu followed by PostMessage(WM_NULL)", calls)
	}
}
