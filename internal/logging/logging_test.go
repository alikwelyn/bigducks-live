package logging_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/logging"
)

func TestLoggerTruncatesLargeFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "discordstream.log")
	logger, err := logging.New(path, 128)
	if err != nil {
		t.Fatalf("logging.New() error = %v", err)
	}

	logger.Printf("%s", strings.Repeat("x", 512))

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("os.Stat() error = %v", err)
	}
	if info.Size() > 128 {
		t.Fatalf("log size = %d, want <= 128", info.Size())
	}
}
