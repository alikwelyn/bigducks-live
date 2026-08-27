//go:build windows

package hud

import (
	"os"
	"path/filepath"
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
