//go:build windows

package discord

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func FindLatest(root string) (string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("read Discord directory: %w", err)
	}
	var bestPath string
	var bestVersion [3]int
	found := false
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "app-") {
			continue
		}
		version, ok := parseVersion(strings.TrimPrefix(entry.Name(), "app-"))
		if !ok {
			continue
		}
		candidate := filepath.Join(root, entry.Name(), "Discord.exe")
		info, statErr := os.Stat(candidate)
		if statErr != nil || info.IsDir() {
			continue
		}
		if !found || compareVersion(version, bestVersion) > 0 {
			bestVersion = version
			bestPath = candidate
			found = true
		}
	}
	if !found {
		return "", errors.New("Discord.exe was not found in any app-version directory")
	}
	return bestPath, nil
}

func DefaultRoot() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Discord")
}

func parseVersion(raw string) ([3]int, bool) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var result [3]int
	for index, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return [3]int{}, false
		}
		result[index] = value
	}
	return result, true
}

func compareVersion(a, b [3]int) int {
	for index := range a {
		if a[index] > b[index] {
			return 1
		}
		if a[index] < b[index] {
			return -1
		}
	}
	return 0
}
