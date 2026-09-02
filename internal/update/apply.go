package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
)

const ApplyRequestFileName = "pending-update.json"

type ApplyRequest struct {
	Version    string `json:"version"`
	TargetPath string `json:"targetPath"`
	StagedPath string `json:"stagedPath"`
	Manifest   []byte `json:"manifest"`
	Signature  string `json:"signature"`
	WaitPIDs   []int  `json:"waitPids,omitempty"`
}

func WriteApplyRequest(dataDir string, request ApplyRequest) (string, error) {
	if dataDir == "" {
		return "", errors.New("update data directory is empty")
	}
	if request.TargetPath == "" || request.StagedPath == "" {
		return "", errors.New("update target and staged paths are required")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("create update data directory: %w", err)
	}
	data, err := json.Marshal(request)
	if err != nil {
		return "", fmt.Errorf("encode update request: %w", err)
	}
	path := filepath.Join(dataDir, ApplyRequestFileName)
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return "", fmt.Errorf("write update request: %w", err)
	}
	if err := fileutil.Replace(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return "", fmt.Errorf("publish update request: %w", err)
	}
	return path, nil
}

func LoadApplyRequest(path string) (ApplyRequest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ApplyRequest{}, fmt.Errorf("read update request: %w", err)
	}
	var request ApplyRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return ApplyRequest{}, fmt.Errorf("decode update request: %w", err)
	}
	if request.TargetPath == "" || request.StagedPath == "" || len(request.Manifest) == 0 || request.Signature == "" {
		return ApplyRequest{}, errors.New("update request is incomplete")
	}
	return request, nil
}

func ApplyFromRequest(ctx context.Context, path, publicKey string) error {
	request, err := LoadApplyRequest(path)
	if err != nil {
		return err
	}
	err = apply(ctx, request, publicKey, waitForProcesses, launchUpdatedExecutable)
	if err == nil {
		_ = os.Remove(path)
	}
	return err
}

func apply(
	ctx context.Context,
	request ApplyRequest,
	publicKey string,
	wait func(context.Context, []int) error,
	launch func(string) error,
) error {
	manifest, err := VerifyManifest(request.Manifest, request.Signature, publicKey)
	if err != nil {
		return err
	}
	if request.Version != "" && request.Version != manifest.Version {
		return errors.New("update request version does not match its signed manifest")
	}
	stagedPath, err := filepath.Abs(request.StagedPath)
	if err != nil {
		return fmt.Errorf("resolve staged update: %w", err)
	}
	targetPath, err := filepath.Abs(request.TargetPath)
	if err != nil {
		return fmt.Errorf("resolve update target: %w", err)
	}
	if filepath.Clean(stagedPath) == filepath.Clean(targetPath) {
		return errors.New("staged update cannot overwrite itself")
	}
	staged, err := os.ReadFile(stagedPath)
	if err != nil {
		return fmt.Errorf("read staged update: %w", err)
	}
	if err := VerifyAsset(manifest, staged); err != nil {
		return err
	}
	if err := wait(ctx, uniquePositivePIDs(request.WaitPIDs)); err != nil {
		return fmt.Errorf("wait for BIG DUCKS processes: %w", err)
	}
	if err := replaceExecutable(stagedPath, targetPath); err != nil {
		return err
	}
	if err := launch(targetPath); err != nil {
		return fmt.Errorf("start updated BIG DUCKS: %w", err)
	}
	return nil
}

func replaceExecutable(stagedPath, targetPath string) error {
	temporary, err := os.CreateTemp(filepath.Dir(targetPath), ".bigducks-update-*.exe")
	if err != nil {
		return fmt.Errorf("create replacement executable: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	source, err := os.Open(stagedPath)
	if err != nil {
		cleanup()
		return fmt.Errorf("open staged executable: %w", err)
	}
	_, copyErr := io.Copy(temporary, source)
	closeSourceErr := source.Close()
	if copyErr != nil || closeSourceErr != nil {
		cleanup()
		if copyErr != nil {
			return fmt.Errorf("copy staged executable: %w", copyErr)
		}
		return fmt.Errorf("close staged executable: %w", closeSourceErr)
	}
	// os.CreateTemp creates the file with 0600; the installed artifact is an
	// executable and must remain runnable on POSIX platforms.
	if err := temporary.Chmod(0o755); err != nil {
		cleanup()
		return fmt.Errorf("mark replacement executable: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("flush replacement executable: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("close replacement executable: %w", err)
	}
	backupPath := targetPath + ".previous"
	if err := fileutil.Replace(targetPath, backupPath); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("back up current executable: %w", err)
	}
	if err := fileutil.Replace(temporaryPath, targetPath); err != nil {
		_ = fileutil.Replace(backupPath, targetPath)
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("install replacement executable: %w", err)
	}
	_ = os.Remove(backupPath)
	return nil
}

func launchUpdatedExecutable(path string) error {
	command := exec.Command(path)
	configureDetachedProcess(command)
	return command.Start()
}

func uniquePositivePIDs(values []int) []int {
	seen := make(map[int]struct{}, len(values))
	result := make([]int, 0, len(values))
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
