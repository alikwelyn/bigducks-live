//go:build windows

package systray

import "testing"

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
