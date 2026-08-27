package fileutil_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
)

func TestReplaceOverwritesExistingDestination(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "state.tmp")
	destination := filepath.Join(root, "state.json")
	if err := os.WriteFile(source, []byte("new"), 0o600); err != nil {
		t.Fatalf("WriteFile(source) error = %v", err)
	}
	if err := os.WriteFile(destination, []byte("old"), 0o600); err != nil {
		t.Fatalf("WriteFile(destination) error = %v", err)
	}
	if err := fileutil.Replace(source, destination); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	data, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("ReadFile(destination) error = %v", err)
	}
	if string(data) != "new" {
		t.Fatalf("destination = %q, want new", data)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("source still exists, stat error = %v", err)
	}
}
