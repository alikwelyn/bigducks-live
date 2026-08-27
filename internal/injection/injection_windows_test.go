//go:build windows

package injection_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/injection"
)

func TestEnsureInstallsVanillaAndRestoreIsByteExact(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	original := officialDiscordAsarFixture([]byte("vanilla-asar-fixture\x00\x01"))
	writeFixture(t, filepath.Join(resources, "app.asar"), original)

	before, err := injection.Inspect(resources, dataDir)
	if err != nil {
		t.Fatalf("Inspect() before install error = %v", err)
	}
	if before.State != injection.StateVanilla {
		t.Fatalf("state before install = %q, want vanilla", before.State)
	}
	result, err := injection.Ensure(resources, dataDir, []byte("module.exports = {};"))
	if err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if result.State != injection.StateOurs || !result.Installed {
		t.Fatalf("Ensure() result = %#v", result)
	}
	index, err := os.ReadFile(filepath.Join(resources, "app.asar", "index.js"))
	if err != nil {
		t.Fatalf("read stub index: %v", err)
	}
	if !strings.Contains(string(index), injection.Marker) {
		t.Fatalf("stub index = %q, missing marker", index)
	}
	bridgeRequire := strings.Index(string(index), "try {")
	catchBridgeFailure := strings.Index(string(index), "catch (error)")
	originalRequire := strings.LastIndex(string(index), "require(")
	if bridgeRequire < 0 || catchBridgeFailure < bridgeRequire || originalRequire < catchBridgeFailure {
		t.Fatalf("stub index is not fail-open: %q", index)
	}
	packageData, err := os.ReadFile(filepath.Join(resources, "app.asar", "package.json"))
	if err != nil {
		t.Fatalf("read stub package: %v", err)
	}
	var packageValue map[string]any
	if err := json.Unmarshal(packageData, &packageValue); err != nil {
		t.Fatalf("stub package is invalid JSON: %v", err)
	}

	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() error = %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read restored app.asar: %v", err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatalf("restored bytes = %q, want %q", restored, original)
	}
}

func TestEnsureChainsRecognizedVencordAndRestoresItsLoader(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	vencord := loaderAsarFixture(`require("C:\\Users\\friend\\AppData\\Roaming\\Vencord\\dist\\patcher.js")`)
	writeFixture(t, filepath.Join(resources, "_app.asar"), []byte("Discord original"))
	writeFixture(t, filepath.Join(resources, "app.asar"), vencord)

	before, err := injection.Inspect(resources, dataDir)
	if err != nil {
		t.Fatalf("Inspect() error = %v", err)
	}
	if before.State != injection.StateRecognizedMod {
		t.Fatalf("recognized loader state = %q", before.State)
	}
	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() error = %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read restored Vencord loader: %v", err)
	}
	if !bytes.Equal(restored, vencord) {
		t.Fatalf("restored loader = %q, want Vencord loader", restored)
	}
	if _, err := os.Stat(filepath.Join(resources, "_app.asar")); err != nil {
		t.Fatalf("Discord original backup was disturbed: %v", err)
	}
}

func TestEnsureRefusesAsarThatOnlyMentionsVencordPatcher(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	current := loaderAsarFixture(`// Vencord patcher.js is mentioned, but this is not its loader`)
	writeFixture(t, filepath.Join(resources, "_app.asar"), []byte("Discord original"))
	writeFixture(t, filepath.Join(resources, "app.asar"), current)

	result, err := injection.Ensure(resources, dataDir, []byte("bridge"))
	if err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if result.State != injection.StateUnknownMod || result.Installed {
		t.Fatalf("Ensure() result = %#v", result)
	}
}

func TestEnsureRefusesUnknownModWithoutChangingFiles(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	current := []byte("unknown third-party loader")
	writeFixture(t, filepath.Join(resources, "_app.asar"), []byte("Discord original"))
	writeFixture(t, filepath.Join(resources, "app.asar"), current)

	result, err := injection.Ensure(resources, dataDir, []byte("bridge"))
	if err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if result.State != injection.StateUnknownMod || result.Installed {
		t.Fatalf("Ensure() result = %#v", result)
	}
	after, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read unknown loader: %v", err)
	}
	if !bytes.Equal(after, current) {
		t.Fatal("unknown loader was modified")
	}
}

func TestEnsureRefusesUnknownLoaderWithoutDiscordBackup(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	current := []byte("custom loader without a Discord _app.asar backup")
	writeFixture(t, filepath.Join(resources, "app.asar"), current)

	result, err := injection.Ensure(resources, dataDir, []byte("bridge"))
	if err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if result.State != injection.StateUnknownMod || result.Installed {
		t.Fatalf("Ensure() result = %#v", result)
	}
	after, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read unknown loader: %v", err)
	}
	if !bytes.Equal(after, current) {
		t.Fatal("unknown loader without _app.asar was modified")
	}
}

func TestEnsureRollsBackWhenMetadataCannotBeSaved(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	original := officialDiscordAsarFixture([]byte("vanilla-asar-fixture"))
	writeFixture(t, filepath.Join(resources, "app.asar"), original)
	if err := os.Mkdir(filepath.Join(dataDir, injection.MetadataFileName), 0o700); err != nil {
		t.Fatalf("block metadata path: %v", err)
	}

	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err == nil {
		t.Fatal("Ensure() unexpectedly succeeded with blocked metadata path")
	}
	restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read rolled-back app.asar: %v", err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatalf("rollback bytes = %q, want %q", restored, original)
	}
}

func TestInspectReportsOurInstalledLoader(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	writeFixture(t, filepath.Join(resources, "app.asar"), officialDiscordAsarFixture([]byte("vanilla")))
	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	result, err := injection.Inspect(resources, dataDir)
	if err != nil {
		t.Fatalf("Inspect() error = %v", err)
	}
	if result.State != injection.StateOurs || !result.Installed || result.RepairRequired {
		t.Fatalf("Inspect() result = %#v", result)
	}
}

func TestEnsureUpgradesLegacyFailClosedStub(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	writeFixture(t, filepath.Join(resources, "app.asar"), officialDiscordAsarFixture([]byte("original")))
	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("first Ensure() error = %v", err)
	}
	indexPath := filepath.Join(resources, "app.asar", "index.js")
	current, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read current stub: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(current)), "\n")
	backupRequire := lines[len(lines)-1]
	bridgePath, _ := json.Marshal(filepath.Join(dataDir, injection.BridgeFileName))
	legacy := "// discordstream-electron-bridge-v1\nrequire(" + string(bridgePath) + ");\n" + backupRequire + "\n"
	writeFixture(t, indexPath, []byte(legacy))

	result, err := injection.Ensure(resources, dataDir, []byte("bridge-v2"))
	if err != nil {
		t.Fatalf("upgrade Ensure() error = %v", err)
	}
	if result.RepairRequired {
		t.Fatalf("upgrade result = %#v", result)
	}
	upgraded, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatalf("read upgraded stub: %v", err)
	}
	if !strings.Contains(string(upgraded), injection.Marker) || !strings.Contains(string(upgraded), "try {") || strings.Contains(string(upgraded), "discordstream-electron-bridge-v1") {
		t.Fatalf("stub was not upgraded to fail-open current version: %q", upgraded)
	}
}

func TestEnsureRepairsMissingMetadataBeforeRestore(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	original := officialDiscordAsarFixture([]byte("original"))
	writeFixture(t, filepath.Join(resources, "app.asar"), original)
	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("first Ensure() error = %v", err)
	}
	if err := os.Remove(filepath.Join(dataDir, injection.MetadataFileName)); err != nil {
		t.Fatalf("remove metadata: %v", err)
	}

	result, err := injection.Ensure(resources, dataDir, []byte("bridge"))
	if err != nil {
		t.Fatalf("repair Ensure() error = %v", err)
	}
	if result.RepairRequired {
		t.Fatalf("repair result = %#v", result)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() after repair error = %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read restored app.asar: %v", err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatal("metadata repair did not preserve byte-exact restoration")
	}
}

func TestRestoreAllRefusesToOrphanStubWhenMetadataIsMissing(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	writeFixture(t, filepath.Join(resources, "app.asar"), officialDiscordAsarFixture([]byte("original")))
	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if err := os.Remove(filepath.Join(dataDir, injection.MetadataFileName)); err != nil {
		t.Fatalf("remove metadata: %v", err)
	}

	if err := injection.RestoreAll(dataDir); err == nil {
		t.Fatal("RestoreAll() unexpectedly removed files without restoration metadata")
	}
	if _, err := os.Stat(filepath.Join(dataDir, injection.BridgeFileName)); err != nil {
		t.Fatalf("bridge was removed after refused restore: %v", err)
	}
	result, err := injection.Inspect(resources, dataDir)
	if err != nil {
		t.Fatalf("Inspect() error = %v", err)
	}
	if result.State != injection.StateOurs || !result.RepairRequired {
		t.Fatalf("injection after refused restore = %#v", result)
	}
}

func TestEnsureRecoversInterruptedRenameTransaction(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	original := officialDiscordAsarFixture([]byte("interrupted original"))
	writeFixture(t, filepath.Join(resources, "app.asar.discordstream-installing"), original)

	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() recovery error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(resources, "app.asar.discordstream-installing")); !os.IsNotExist(err) {
		t.Fatalf("transaction file after recovery error = %v, want not exist", err)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() error = %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read restored original: %v", err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatal("interrupted transaction recovery changed original bytes")
	}
}

func TestEnsureRecoversInterruptedPartialStubTransaction(t *testing.T) {
	dataDir := t.TempDir()
	resources := t.TempDir()
	original := officialDiscordAsarFixture([]byte("partial interrupted original"))
	writeFixture(t, filepath.Join(resources, "app.asar.discordstream-installing"), original)
	appPath := filepath.Join(resources, "app.asar")
	if err := os.Mkdir(appPath, 0o700); err != nil {
		t.Fatalf("create partial stub: %v", err)
	}
	writeFixture(t, filepath.Join(appPath, "package.json"), []byte(`{"name":"discord","main":"index.js","version":"1.0.0"}`))

	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() recovery error = %v", err)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() error = %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
	if err != nil {
		t.Fatalf("read restored original: %v", err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatal("partial transaction recovery changed original bytes")
	}
}

func TestRestoreAllForgetsDiscordVersionRemovedByUpdater(t *testing.T) {
	dataDir := t.TempDir()
	resources := filepath.Join(t.TempDir(), "resources")
	if err := os.MkdirAll(resources, 0o700); err != nil {
		t.Fatalf("create resources fixture: %v", err)
	}
	writeFixture(t, filepath.Join(resources, "app.asar"), officialDiscordAsarFixture([]byte("old Discord version")))
	if _, err := injection.Ensure(resources, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	if err := os.RemoveAll(resources); err != nil {
		t.Fatalf("remove disposable resources fixture: %v", err)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() after updater removal = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, injection.MetadataFileName)); !os.IsNotExist(err) {
		t.Fatalf("metadata after removed version error = %v, want not exist", err)
	}
}

func TestRestoreAllSupportsInstallationsSharingTheSameBackup(t *testing.T) {
	dataDir := t.TempDir()
	original := officialDiscordAsarFixture([]byte("same Discord loader"))
	resourcesOne := t.TempDir()
	resourcesTwo := t.TempDir()
	writeFixture(t, filepath.Join(resourcesOne, "app.asar"), original)
	writeFixture(t, filepath.Join(resourcesTwo, "app.asar"), original)
	if _, err := injection.Ensure(resourcesOne, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() first installation error = %v", err)
	}
	if _, err := injection.Ensure(resourcesTwo, dataDir, []byte("bridge")); err != nil {
		t.Fatalf("Ensure() second installation error = %v", err)
	}
	if err := injection.RestoreAll(dataDir); err != nil {
		t.Fatalf("RestoreAll() shared backup error = %v", err)
	}
	for _, resources := range []string{resourcesOne, resourcesTwo} {
		restored, err := os.ReadFile(filepath.Join(resources, "app.asar"))
		if err != nil {
			t.Fatalf("read restored loader in %s: %v", resources, err)
		}
		if !bytes.Equal(restored, original) {
			t.Fatalf("restored loader in %s = %q", resources, restored)
		}
	}
}

func writeFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write fixture %s: %v", path, err)
	}
}

func officialDiscordAsarFixture(payload []byte) []byte {
	header := []byte(`{"files":{"bundle.js":{"size":1,"offset":"0"},"package.json":{"size":1,"offset":"1"},"splash":{"files":{}},"splashScreenPreload.js":{"size":1,"offset":"2"}}}`)
	paddedHeader := append([]byte(nil), header...)
	for len(paddedHeader)%4 != 0 {
		paddedHeader = append(paddedHeader, 0)
	}
	result := make([]byte, 16, 16+len(paddedHeader)+len(payload))
	binary.LittleEndian.PutUint32(result[0:4], 4)
	binary.LittleEndian.PutUint32(result[4:8], uint32(len(paddedHeader)+8))
	binary.LittleEndian.PutUint32(result[8:12], uint32(len(paddedHeader)+4))
	binary.LittleEndian.PutUint32(result[12:16], uint32(len(header)))
	result = append(result, paddedHeader...)
	return append(result, payload...)
}

func loaderAsarFixture(index string) []byte {
	packageJSON := []byte(`{"name":"discord","main":"index.js"}`)
	indexData := []byte(index)
	headerValue := map[string]any{"files": map[string]any{
		"index.js":     map[string]any{"size": len(indexData), "offset": "0"},
		"package.json": map[string]any{"size": len(packageJSON), "offset": fmt.Sprint(len(indexData))},
	}}
	header, _ := json.Marshal(headerValue)
	paddedHeader := append([]byte(nil), header...)
	for len(paddedHeader)%4 != 0 {
		paddedHeader = append(paddedHeader, 0)
	}
	result := make([]byte, 16, 16+len(paddedHeader)+len(indexData)+len(packageJSON))
	binary.LittleEndian.PutUint32(result[0:4], 4)
	binary.LittleEndian.PutUint32(result[4:8], uint32(len(paddedHeader)+8))
	binary.LittleEndian.PutUint32(result[8:12], uint32(len(paddedHeader)+4))
	binary.LittleEndian.PutUint32(result[12:16], uint32(len(header)))
	result = append(result, paddedHeader...)
	result = append(result, indexData...)
	return append(result, packageJSON...)
}
