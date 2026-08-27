//go:build windows

package hud

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHUDCachePathIsIsolatedPerProcess(t *testing.T) {
	root := t.TempDir()
	first := hudCachePath(root, 100)
	second := hudCachePath(root, 200)
	if first == second || filepath.Base(first) != "100" || filepath.Base(second) != "200" {
		t.Fatalf("cache paths = %q and %q", first, second)
	}
}

func TestHUDWindowUsesFixedLandscapeDimensions(t *testing.T) {
	if HUDWidth != 1180 || HUDHeight != 700 {
		t.Fatalf("HUD dimensions = %dx%d, want 1180x700", HUDWidth, HUDHeight)
	}
	if HUDWidth <= HUDHeight {
		t.Fatalf("HUD must be landscape: %dx%d", HUDWidth, HUDHeight)
	}
	if !strings.Contains(zoomGuardScript, "preventDefault") || !strings.Contains(zoomGuardScript, "wheel") {
		t.Fatalf("zoom guard is incomplete: %q", zoomGuardScript)
	}
}

func TestHUDClientSizeFitsTheDesktopWorkArea(t *testing.T) {
	outer := windowRect{Left: 0, Top: 0, Right: 1196, Bottom: 739}
	workArea := windowRect{Left: 0, Top: 0, Right: 1366, Bottom: 720}
	width, height := fitClientSize(HUDWidth, HUDHeight, outer, workArea)
	if width != 1180 || height != 681 {
		t.Fatalf("fitted client = %dx%d, want 1180x681", width, height)
	}

	left, top := centeredWindowOrigin(windowRect{Right: 1196, Bottom: 720}, workArea)
	if left != 85 || top != 0 {
		t.Fatalf("centered origin = (%d,%d), want (85,0)", left, top)
	}
}

func TestHUDClientSizeKeepsRequestedSizeWhenItFits(t *testing.T) {
	outer := windowRect{Right: 1196, Bottom: 739}
	workArea := windowRect{Left: 100, Top: 40, Right: 2020, Bottom: 1080}
	width, height := fitClientSize(HUDWidth, HUDHeight, outer, workArea)
	if width != HUDWidth || height != HUDHeight {
		t.Fatalf("fitted client = %dx%d, want %dx%d", width, height, HUDWidth, HUDHeight)
	}
}

func TestAsyncUpdateCheckReturnsWhileCheckerIsBlocked(t *testing.T) {
	release := make(chan struct{})
	delivered := make(chan UpdateView, 1)
	returned := make(chan struct{})
	go func() {
		startAsyncUpdateCheck(
			func() UpdateView {
				<-release
				return UpdateView{Current: "0.1.1", Message: "done"}
			},
			func(result UpdateView) { delivered <- result },
		)
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("starting an update check blocked the caller")
	}
	select {
	case result := <-delivered:
		t.Fatalf("checker completed before it was released: %+v", result)
	default:
	}
	close(release)
	select {
	case result := <-delivered:
		if result.Message != "done" {
			t.Fatalf("delivered result = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("async checker did not deliver its result")
	}
}

func TestCleanupStaleCachesKeepsCurrentAndRecentDirectories(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "100")
	current := filepath.Join(root, "200")
	recent := filepath.Join(root, "300")
	unknown := filepath.Join(root, "shared")
	for _, path := range []string{old, current, recent, unknown} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	cleanupStaleCaches(root, 200, 7*24*time.Hour)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("stale cache still exists: %v", err)
	}
	for _, path := range []string{current, recent, unknown} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("kept cache %q: %v", path, err)
		}
	}
}
