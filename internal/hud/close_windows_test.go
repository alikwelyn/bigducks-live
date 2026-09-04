//go:build windows

package hud

import (
	"context"
	"testing"
	"time"
)

func TestCloseExistingWindowPostsCloseAndWaitsForDisappearance(t *testing.T) {
	visible := true
	var postedMessage uintptr
	err := closeExistingWindow(context.Background(), hudWindowFunctions{
		find: func() uintptr {
			if visible {
				return 42
			}
			return 0
		},
		post: func(_ uintptr, message, _, _ uintptr) bool {
			postedMessage = message
			visible = false
			return true
		},
		terminate: func(uintptr) error {
			return nil
		},
	})
	if err != nil {
		t.Fatalf("closeExistingWindow() error = %v", err)
	}
	if postedMessage != wmClose {
		t.Fatalf("posted message = %#x, want WM_CLOSE %#x", postedMessage, wmClose)
	}
}

func TestCloseExistingWindowTerminatesWindowAfterDeadline(t *testing.T) {
	terminated := false
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := closeExistingWindow(ctx, hudWindowFunctions{
		find: func() uintptr { return 42 },
		post: func(uintptr, uintptr, uintptr, uintptr) bool { return true },
		terminate: func(handle uintptr) error {
			if handle != 42 {
				t.Fatalf("terminated handle = %d, want 42", handle)
			}
			terminated = true
			return nil
		},
	})
	if err != nil {
		t.Fatalf("closeExistingWindow() error = %v", err)
	}
	if !terminated {
		t.Fatal("stuck HUD window was not terminated")
	}
}
