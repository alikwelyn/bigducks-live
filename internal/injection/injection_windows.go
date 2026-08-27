//go:build windows

package injection

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
)

const (
	appAsarName     = "app.asar"
	backupDirectory = "injection-backups"
	legacyMarker    = "discordstream-electron-bridge-v1"
)

var requireOnlyPattern = regexp.MustCompile(`(?s)^\s*require\(\s*("(\\.|[^"\\])*")\s*\)\s*;?\s*$`)

type metadata struct {
	Records []injectionRecord `json:"records"`
}

type injectionRecord struct {
	Resources string `json:"resources"`
	Backup    string `json:"backup"`
	SHA256    string `json:"sha256"`
}

func Inspect(resources, dataDir string) (Result, error) {
	resources, err := validateDirectory(resources, "Discord resources")
	if err != nil {
		return Result{State: StateUnavailable, Reason: err.Error()}, err
	}
	appPath := filepath.Join(resources, appAsarName)
	info, err := os.Stat(appPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Result{State: StateUnavailable, RepairRequired: true, Reason: "Discord app.asar was not found"}, nil
		}
		return Result{State: StateUnavailable, Reason: err.Error()}, fmt.Errorf("inspect Discord app.asar: %w", err)
	}
	if info.IsDir() {
		index, readErr := os.ReadFile(filepath.Join(appPath, "index.js"))
		backupPath, owned := ownedStubBackup(index, dataDir)
		if readErr == nil && owned {
			recorded, metadataErr := hasRecord(dataDir, resources)
			if metadataErr != nil {
				return Result{}, metadataErr
			}
			packageCurrent := validStubPackage(appPath)
			indexCurrent := bytes.Equal(index, buildStubIndex(filepath.Join(dataDir, BridgeFileName), backupPath))
			repairRequired := !recorded || !packageCurrent || !indexCurrent
			reason := ""
			if !recorded {
				reason = "BIG DUCKS integration metadata is missing"
			} else if !packageCurrent || !indexCurrent {
				reason = "BIG DUCKS integration loader needs an upgrade"
			}
			return Result{
				State:          StateOurs,
				Installed:      true,
				RepairRequired: repairRequired,
				Reason:         reason,
			}, nil
		}
		return Result{State: StateUnknownMod, Reason: "an unrecognized app.asar directory is already installed"}, nil
	}

	current, err := os.ReadFile(appPath)
	if err != nil {
		return Result{State: StateUnavailable, Reason: err.Error()}, fmt.Errorf("read Discord app.asar: %w", err)
	}
	if recognizedLoader(current) {
		return Result{State: StateRecognizedMod, Reason: "recognized Vencord or Equicord loader"}, nil
	}
	if _, err := os.Stat(filepath.Join(resources, "_app.asar")); err == nil {
		return Result{State: StateUnknownMod, Reason: "another Discord modification is already installed"}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("inspect Discord original backup: %w", err)
	}
	if officialDiscordAsar(current) {
		return Result{State: StateVanilla}, nil
	}
	return Result{State: StateUnknownMod, Reason: "app.asar is not a recognized official Discord archive"}, nil
}

func Ensure(resources, dataDir string, bridgeScript []byte) (Result, error) {
	resources, err := validateDirectory(resources, "Discord resources")
	if err != nil {
		return Result{}, err
	}
	dataDir, err = ensureDataDirectory(dataDir)
	if err != nil {
		return Result{}, err
	}
	if err := recoverInterruptedInstall(resources); err != nil {
		return Result{}, err
	}
	state, err := Inspect(resources, dataDir)
	if err != nil {
		return Result{}, err
	}
	if state.State == StateUnknownMod || state.State == StateUnavailable {
		return state, nil
	}
	bridgePath := filepath.Join(dataDir, BridgeFileName)
	if err := writeAtomic(bridgePath, bridgeScript, 0o600); err != nil {
		return Result{}, fmt.Errorf("install Discord bridge script: %w", err)
	}
	if state.State == StateOurs {
		if state.RepairRequired {
			if err := repairRecord(resources, dataDir); err != nil {
				return Result{}, fmt.Errorf("repair Discord injection metadata: %w", err)
			}
			if err := rewriteStub(resources, dataDir); err != nil {
				return Result{}, fmt.Errorf("upgrade Discord injection loader: %w", err)
			}
			state.RepairRequired = false
			state.Reason = ""
		}
		state.Installed = true
		return state, nil
	}

	stored, err := loadMetadata(dataDir)
	if err != nil {
		return Result{}, err
	}
	appPath := filepath.Join(resources, appAsarName)
	current, err := os.ReadFile(appPath)
	if err != nil {
		return Result{}, fmt.Errorf("read loader before injection: %w", err)
	}
	digest := sha256.Sum256(current)
	digestText := hex.EncodeToString(digest[:])
	backupDir := filepath.Join(dataDir, backupDirectory)
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return Result{}, fmt.Errorf("create injection backup directory: %w", err)
	}
	backupPath := filepath.Join(backupDir, digestText+".asar")
	if err := ensureBackup(backupPath, current); err != nil {
		return Result{}, err
	}

	temporaryOriginal := filepath.Join(resources, "app.asar.discordstream-installing")
	if _, err := os.Stat(temporaryOriginal); err == nil {
		return Result{}, errors.New("a previous BIG DUCKS integration transaction is still present")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("inspect injection transaction: %w", err)
	}
	if err := os.Rename(appPath, temporaryOriginal); err != nil {
		return Result{}, fmt.Errorf("preserve current Discord loader: %w", err)
	}
	stubCreated := false
	rollback := func() {
		if stubCreated {
			_ = os.RemoveAll(appPath)
		}
		_ = os.Rename(temporaryOriginal, appPath)
	}
	if err := os.Mkdir(appPath, 0o700); err != nil {
		rollback()
		return Result{}, fmt.Errorf("create Discord injection loader: %w", err)
	}
	stubCreated = true
	packageJSON := stubPackageJSON()
	if err := os.WriteFile(filepath.Join(appPath, "package.json"), packageJSON, 0o600); err != nil {
		rollback()
		return Result{}, fmt.Errorf("write Discord injection package: %w", err)
	}
	index := buildStubIndex(bridgePath, backupPath)
	if err := os.WriteFile(filepath.Join(appPath, "index.js"), index, 0o600); err != nil {
		rollback()
		return Result{}, fmt.Errorf("write Discord injection entrypoint: %w", err)
	}

	record := injectionRecord{Resources: resources, Backup: backupPath, SHA256: digestText}
	stored.Records = replaceRecord(stored.Records, record)
	if err := saveMetadata(dataDir, stored); err != nil {
		rollback()
		return Result{}, err
	}
	if err := os.Remove(temporaryOriginal); err != nil {
		return Result{}, fmt.Errorf("finish Discord injection transaction: %w", err)
	}
	return Result{State: StateOurs, Installed: true}, nil
}

func RestoreAll(dataDir string) error {
	dataDir, err := validateDirectory(dataDir, "BIG DUCKS data")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	stored, err := loadMetadata(dataDir)
	if err != nil {
		return err
	}
	if len(stored.Records) == 0 {
		backups, readErr := os.ReadDir(filepath.Join(dataDir, backupDirectory))
		if readErr == nil && len(backups) > 0 {
			return errors.New("Discord injection metadata is missing; repair the injection before uninstalling")
		}
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return fmt.Errorf("inspect Discord injection backups: %w", readErr)
		}
	}
	remaining := make([]injectionRecord, 0, len(stored.Records))
	var restoreErrors []error
	cleanupBackups := make(map[string]struct{})
	for _, record := range stored.Records {
		if _, statErr := os.Stat(record.Resources); errors.Is(statErr, os.ErrNotExist) {
			cleanupBackups[record.Backup] = struct{}{}
			continue
		}
		if err := restoreRecord(record); err != nil {
			remaining = append(remaining, record)
			restoreErrors = append(restoreErrors, err)
			continue
		}
		cleanupBackups[record.Backup] = struct{}{}
	}
	stored.Records = remaining
	for _, record := range remaining {
		delete(cleanupBackups, record.Backup)
	}
	for backup := range cleanupBackups {
		_ = os.Remove(backup)
	}
	if len(remaining) == 0 {
		_ = os.Remove(filepath.Join(dataDir, MetadataFileName))
		_ = os.Remove(filepath.Join(dataDir, BridgeFileName))
		_ = os.Remove(filepath.Join(dataDir, backupDirectory))
	} else if err := saveMetadata(dataDir, stored); err != nil {
		restoreErrors = append(restoreErrors, err)
	}
	return errors.Join(restoreErrors...)
}

func restoreRecord(record injectionRecord) error {
	resources, err := validateDirectory(record.Resources, "recorded Discord resources")
	if err != nil {
		return err
	}
	backup, err := os.ReadFile(record.Backup)
	if err != nil {
		return fmt.Errorf("read Discord loader backup for %s: %w", resources, err)
	}
	digest := sha256.Sum256(backup)
	if hex.EncodeToString(digest[:]) != record.SHA256 {
		return fmt.Errorf("Discord loader backup checksum mismatch for %s", resources)
	}
	appPath := filepath.Join(resources, appAsarName)
	if current, readErr := os.ReadFile(appPath); readErr == nil {
		currentDigest := sha256.Sum256(current)
		if hex.EncodeToString(currentDigest[:]) == record.SHA256 {
			return nil
		}
		return fmt.Errorf("refusing to overwrite a newer Discord loader in %s", resources)
	}
	if !isOurStub(appPath) {
		return fmt.Errorf("refusing to remove an unrecognized Discord loader in %s", resources)
	}
	temporaryRestore := filepath.Join(resources, "app.asar.discordstream-restoring")
	if err := os.WriteFile(temporaryRestore, backup, 0o600); err != nil {
		return fmt.Errorf("stage restored Discord loader: %w", err)
	}
	temporaryStub := filepath.Join(resources, "app.asar.discordstream-stub")
	if err := os.Rename(appPath, temporaryStub); err != nil {
		_ = os.Remove(temporaryRestore)
		return fmt.Errorf("preserve injected Discord stub: %w", err)
	}
	if err := os.Rename(temporaryRestore, appPath); err != nil {
		_ = os.Rename(temporaryStub, appPath)
		_ = os.Remove(temporaryRestore)
		return fmt.Errorf("restore Discord loader: %w", err)
	}
	_ = os.RemoveAll(temporaryStub)
	return nil
}

func validateDirectory(path, label string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%s directory is empty", label)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve %s directory: %w", label, err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect %s directory: %w", label, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s path is not a directory", label)
	}
	return filepath.Clean(absolute), nil
}

func ensureDataDirectory(path string) (string, error) {
	if path == "" {
		return "", errors.New("BIG DUCKS data directory is empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve BIG DUCKS data directory: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", fmt.Errorf("create BIG DUCKS data directory: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func recognizedLoader(data []byte) bool {
	packageData, packageOK := asarFile(data, "package.json")
	index, indexOK := asarFile(data, "index.js")
	if !packageOK || !indexOK {
		return false
	}
	var packageValue struct {
		Name string `json:"name"`
		Main string `json:"main"`
	}
	if err := json.Unmarshal(packageData, &packageValue); err != nil || packageValue.Name != "discord" || packageValue.Main != "index.js" {
		return false
	}
	match := requireOnlyPattern.FindSubmatch(index)
	if len(match) < 2 {
		return false
	}
	var requiredPath string
	if err := json.Unmarshal(match[1], &requiredPath); err != nil || !filepath.IsAbs(requiredPath) {
		return false
	}
	normalized := strings.ToLower(filepath.Clean(requiredPath))
	for _, mod := range []string{"vencord", "equicord"} {
		suffix := string(os.PathSeparator) + filepath.Join(mod, "dist", "patcher.js")
		if strings.HasSuffix(normalized, suffix) {
			return true
		}
	}
	return false
}

func officialDiscordAsar(data []byte) bool {
	header, _, ok := parseAsarHeader(data)
	if !ok {
		return false
	}
	for _, required := range []string{"bundle.js", "package.json", "splash", "splashScreenPreload.js"} {
		if _, exists := header.Files[required]; !exists {
			return false
		}
	}
	return true
}

type asarEntry struct {
	Size   int64                `json:"size"`
	Offset string               `json:"offset"`
	Files  map[string]asarEntry `json:"files"`
}

type asarHeader struct {
	Files map[string]asarEntry `json:"files"`
}

func parseAsarHeader(data []byte) (asarHeader, int, bool) {
	if len(data) < 16 || binary.LittleEndian.Uint32(data[:4]) != 4 {
		return asarHeader{}, 0, false
	}
	headerPickleLength := int(binary.LittleEndian.Uint32(data[4:8]))
	headerLength := int(binary.LittleEndian.Uint32(data[12:16]))
	contentOffset := 8 + headerPickleLength
	if headerLength < 2 || headerLength > len(data)-16 || contentOffset < 16+headerLength || contentOffset > len(data) {
		return asarHeader{}, 0, false
	}
	var header asarHeader
	if err := json.Unmarshal(data[16:16+headerLength], &header); err != nil || header.Files == nil {
		return asarHeader{}, 0, false
	}
	return header, contentOffset, true
}

func asarFile(data []byte, name string) ([]byte, bool) {
	header, contentOffset, ok := parseAsarHeader(data)
	if !ok {
		return nil, false
	}
	entry, exists := header.Files[name]
	if !exists || entry.Files != nil || entry.Size < 0 {
		return nil, false
	}
	offset, err := strconv.ParseInt(entry.Offset, 10, 64)
	if err != nil || offset < 0 || offset > int64(len(data)) || entry.Size > int64(len(data)) {
		return nil, false
	}
	start := int64(contentOffset) + offset
	end := start + entry.Size
	if start < int64(contentOffset) || end < start || end > int64(len(data)) {
		return nil, false
	}
	return data[start:end], true
}

func recoverInterruptedInstall(resources string) error {
	appPath := filepath.Join(resources, appAsarName)
	temporaryOriginal := filepath.Join(resources, "app.asar.discordstream-installing")
	if _, err := os.Stat(temporaryOriginal); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect interrupted injection transaction: %w", err)
	}
	if info, err := os.Stat(appPath); err == nil {
		if !info.IsDir() || !recoverablePartialStub(appPath) {
			return errors.New("an ambiguous BIG DUCKS integration transaction needs manual repair")
		}
		partialPath := filepath.Join(resources, "app.asar.discordstream-partial")
		if _, partialErr := os.Stat(partialPath); partialErr == nil {
			return errors.New("a previous partial BIG DUCKS integration recovery is still present")
		} else if !errors.Is(partialErr, os.ErrNotExist) {
			return fmt.Errorf("inspect partial injection recovery: %w", partialErr)
		}
		if err := os.Rename(appPath, partialPath); err != nil {
			return fmt.Errorf("preserve interrupted Discord injection stub: %w", err)
		}
		if err := os.Rename(temporaryOriginal, appPath); err != nil {
			_ = os.Rename(partialPath, appPath)
			return fmt.Errorf("restore original after interrupted Discord injection: %w", err)
		}
		_ = os.RemoveAll(partialPath)
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect Discord loader during transaction recovery: %w", err)
	}
	if err := os.Rename(temporaryOriginal, appPath); err != nil {
		return fmt.Errorf("restore interrupted Discord injection transaction: %w", err)
	}
	return nil
}

func recoverablePartialStub(appPath string) bool {
	entries, err := os.ReadDir(appPath)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() || (entry.Name() != "package.json" && entry.Name() != "index.js") {
			return false
		}
		data, readErr := os.ReadFile(filepath.Join(appPath, entry.Name()))
		if readErr != nil {
			return false
		}
		if entry.Name() == "package.json" && len(data) > 0 && !bytes.Equal(data, stubPackageJSON()) {
			return false
		}
		if entry.Name() == "index.js" && len(data) > 0 && !bytes.HasPrefix(data, []byte("// discordstream-electron-bridge-v")) {
			return false
		}
	}
	return true
}

func Repair(resources, dataDir string) error {
	resources, err := validateDirectory(resources, "Discord resources")
	if err != nil {
		return err
	}
	dataDir, err = ensureDataDirectory(dataDir)
	if err != nil {
		return err
	}
	return repairRecord(resources, dataDir)
}

func repairRecord(resources, dataDir string) error {
	index, err := os.ReadFile(filepath.Join(resources, appAsarName, "index.js"))
	if err != nil {
		return fmt.Errorf("read injected Discord loader: %w", err)
	}
	backupPath, owned := ownedStubBackup(index, dataDir)
	if !owned {
		return errors.New("Discord loader is not owned by BIG DUCKS")
	}
	backup, err := os.ReadFile(backupPath)
	if err != nil {
		return fmt.Errorf("read injected Discord backup: %w", err)
	}
	digest := sha256.Sum256(backup)
	digestText := hex.EncodeToString(digest[:])
	if !strings.EqualFold(filepath.Base(backupPath), digestText+".asar") {
		return errors.New("injected Discord backup filename does not match its checksum")
	}
	stored, err := loadMetadata(dataDir)
	if err != nil {
		return err
	}
	stored.Records = replaceRecord(stored.Records, injectionRecord{
		Resources: resources,
		Backup:    backupPath,
		SHA256:    digestText,
	})
	return saveMetadata(dataDir, stored)
}

func rewriteStub(resources, dataDir string) error {
	appPath := filepath.Join(resources, appAsarName)
	index, err := os.ReadFile(filepath.Join(appPath, "index.js"))
	if err != nil {
		return fmt.Errorf("read BIG DUCKS loader before upgrade: %w", err)
	}
	backupPath, owned := ownedStubBackup(index, dataDir)
	if !owned {
		return errors.New("BIG DUCKS loader backup cannot be validated")
	}
	if err := writeAtomic(filepath.Join(appPath, "package.json"), stubPackageJSON(), 0o600); err != nil {
		return fmt.Errorf("upgrade DiscordStream package: %w", err)
	}
	if err := writeAtomic(filepath.Join(appPath, "index.js"), buildStubIndex(filepath.Join(dataDir, BridgeFileName), backupPath), 0o600); err != nil {
		return fmt.Errorf("upgrade DiscordStream entrypoint: %w", err)
	}
	return nil
}

func stubPackageJSON() []byte {
	return []byte(`{"name":"discord","main":"index.js","version":"1.0.0"}`)
}

func buildStubIndex(bridgePath, backupPath string) []byte {
	bridgeJSON, _ := json.Marshal(bridgePath)
	backupJSON, _ := json.Marshal(backupPath)
	return []byte("// " + Marker + "\ntry {\n  require(" + string(bridgeJSON) + ");\n} catch (error) {\n  // The original Discord loader must remain usable if the optional bridge fails.\n}\nrequire(" + string(backupJSON) + ");\n")
}

func validStubPackage(appPath string) bool {
	data, err := os.ReadFile(filepath.Join(appPath, "package.json"))
	return err == nil && bytes.Equal(data, stubPackageJSON())
}

func ownedStubBackup(index []byte, dataDir string) (string, bool) {
	if !bytes.Contains(index, []byte(Marker)) && !bytes.Contains(index, []byte(legacyMarker)) {
		return "", false
	}
	backupPath, err := backupPathFromStub(index)
	if err != nil {
		return "", false
	}
	backupRoot := filepath.Clean(filepath.Join(dataDir, backupDirectory))
	backupPath = filepath.Clean(backupPath)
	relative, err := filepath.Rel(backupRoot, backupPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return "", false
	}
	return backupPath, true
}

func backupPathFromStub(index []byte) (string, error) {
	lines := strings.Split(string(index), "\n")
	for lineIndex := len(lines) - 1; lineIndex >= 0; lineIndex-- {
		line := strings.TrimSpace(lines[lineIndex])
		if !strings.HasPrefix(line, "require(") || !strings.HasSuffix(line, ");") {
			continue
		}
		encoded := strings.TrimSuffix(strings.TrimPrefix(line, "require("), ");")
		var path string
		if err := json.Unmarshal([]byte(encoded), &path); err == nil && filepath.IsAbs(path) {
			return path, nil
		}
	}
	return "", errors.New("injected Discord loader does not contain a valid backup path")
}

func isOurStub(appPath string) bool {
	info, err := os.Stat(appPath)
	if err != nil || !info.IsDir() {
		return false
	}
	index, err := os.ReadFile(filepath.Join(appPath, "index.js"))
	if err != nil || (!bytes.Contains(index, []byte(Marker)) && !bytes.Contains(index, []byte(legacyMarker))) {
		return false
	}
	_, err = backupPathFromStub(index)
	return err == nil
}

func ensureBackup(path string, expected []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if bytes.Equal(existing, expected) {
			return nil
		}
		return errors.New("an injection backup has an unexpected checksum")
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect injection backup: %w", err)
	}
	if err := writeAtomic(path, expected, 0o600); err != nil {
		return fmt.Errorf("write injection backup: %w", err)
	}
	return nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, mode); err != nil {
		return err
	}
	if err := fileutil.Replace(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func loadMetadata(dataDir string) (metadata, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, MetadataFileName))
	if errors.Is(err, os.ErrNotExist) {
		return metadata{}, nil
	}
	if err != nil {
		return metadata{}, fmt.Errorf("read injection metadata: %w", err)
	}
	var stored metadata
	if err := json.Unmarshal(data, &stored); err != nil {
		return metadata{}, fmt.Errorf("decode injection metadata: %w", err)
	}
	return stored, nil
}

func saveMetadata(dataDir string, stored metadata) error {
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return fmt.Errorf("encode injection metadata: %w", err)
	}
	if err := writeAtomic(filepath.Join(dataDir, MetadataFileName), data, 0o600); err != nil {
		return fmt.Errorf("save injection metadata: %w", err)
	}
	return nil
}

func replaceRecord(records []injectionRecord, replacement injectionRecord) []injectionRecord {
	result := make([]injectionRecord, 0, len(records)+1)
	for _, record := range records {
		if !strings.EqualFold(filepath.Clean(record.Resources), filepath.Clean(replacement.Resources)) {
			result = append(result, record)
		}
	}
	return append(result, replacement)
}

func hasRecord(dataDir, resources string) (bool, error) {
	stored, err := loadMetadata(dataDir)
	if err != nil {
		return false, err
	}
	for _, record := range stored.Records {
		if strings.EqualFold(filepath.Clean(record.Resources), filepath.Clean(resources)) {
			return true, nil
		}
	}
	return false, nil
}
