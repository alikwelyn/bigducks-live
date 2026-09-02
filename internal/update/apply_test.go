package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyReplacesTargetOnlyAfterSignatureVerification(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	if err := os.WriteFile(target, []byte("old"), 0o700); err != nil {
		t.Fatal(err)
	}
	newExecutable := []byte("new signed executable")
	if err := os.WriteFile(staged, newExecutable, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(newExecutable)
	manifestData, _ := EncodeManifest(Manifest{
		Version: "0.2.0", Asset: WindowsAssetName, Size: int64(len(newExecutable)), SHA256: hex.EncodeToString(digest[:]),
	})
	request := ApplyRequest{
		TargetPath: target, StagedPath: staged, Manifest: manifestData,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestData)),
	}
	launched := ""
	err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(path string) error {
		launched = path
		return nil
	})
	if err != nil {
		t.Fatalf("apply() error = %v", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != string(newExecutable) {
		t.Fatalf("target = %q", got)
	}
	if launched != target {
		t.Fatalf("launched = %q, want %q", launched, target)
	}
}

func TestApplyRejectsTamperedStagedExecutable(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(target, []byte("old"), 0o700)
	_ = os.WriteFile(staged, []byte("tampered"), 0o700)
	digest := sha256.Sum256([]byte("signed"))
	manifestData, _ := EncodeManifest(Manifest{Version: "0.2.0", Asset: WindowsAssetName, Size: 6, SHA256: hex.EncodeToString(digest[:])})
	request := ApplyRequest{
		TargetPath: target, StagedPath: staged, Manifest: manifestData,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestData)),
	}
	if err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(string) error { return nil }); err == nil {
		t.Fatal("tampered staged executable was accepted")
	}
	got, _ := os.ReadFile(target)
	if string(got) != "old" {
		t.Fatalf("target changed to %q", got)
	}
}

func TestApplyRequestRoundTrip(t *testing.T) {
	request := ApplyRequest{TargetPath: `C:\Apps\BigDucks.exe`, StagedPath: `C:\Data\update.exe`, WaitPIDs: []int{10, 20}, Version: "0.2.0", Manifest: []byte("signed manifest"), Signature: "signature"}
	path, err := WriteApplyRequest(t.TempDir(), request)
	if err != nil {
		t.Fatalf("WriteApplyRequest() error = %v", err)
	}
	loaded, err := LoadApplyRequest(path)
	if err != nil {
		t.Fatalf("LoadApplyRequest() error = %v", err)
	}
	if loaded.TargetPath != request.TargetPath || loaded.StagedPath != request.StagedPath || len(loaded.WaitPIDs) != 2 {
		t.Fatalf("loaded request = %#v", loaded)
	}
}

func signedApplyRequest(t *testing.T, privateKey ed25519.PrivateKey, payload []byte, version string) ApplyRequest {
	t.Helper()
	digest := sha256.Sum256(payload)
	manifestData, err := EncodeManifest(Manifest{
		Version: version, Asset: WindowsAssetName, Size: int64(len(payload)), SHA256: hex.EncodeToString(digest[:]),
	})
	if err != nil {
		t.Fatalf("EncodeManifest() error = %v", err)
	}
	return ApplyRequest{
		Manifest:  manifestData,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestData)),
	}
}

func TestApplyRejectsVersionMismatchWithManifest(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(target, []byte("old"), 0o700)
	_ = os.WriteFile(staged, []byte("new"), 0o700)
	request := signedApplyRequest(t, privateKey, []byte("new"), "0.2.0")
	request.TargetPath, request.StagedPath, request.Version = target, staged, "9.9.9"

	if err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(string) error { return nil }); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("apply() error = %v, want version mismatch", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "old" {
		t.Fatalf("target changed to %q", got)
	}
}

func TestApplyRejectsStagedPathEqualToTarget(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	path := filepath.Join(t.TempDir(), "BigDucks.exe")
	_ = os.WriteFile(path, []byte("content"), 0o700)
	request := signedApplyRequest(t, privateKey, []byte("content"), "0.2.0")
	request.TargetPath, request.StagedPath = path, path

	if err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(string) error { return nil }); err == nil || !strings.Contains(err.Error(), "cannot overwrite itself") {
		t.Fatalf("apply() error = %v, want self-overwrite rejection", err)
	}
}

func TestApplyRejectsMissingStagedFile(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	request := signedApplyRequest(t, privateKey, []byte("new"), "0.2.0")
	request.TargetPath = filepath.Join(t.TempDir(), "BigDucks.exe")
	request.StagedPath = filepath.Join(t.TempDir(), "missing.exe")

	if err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(string) error { return nil }); err == nil || !strings.Contains(err.Error(), "read staged update") {
		t.Fatalf("apply() error = %v, want missing staged update", err)
	}
}

func TestApplyRefusesWhenProcessesStillRunning(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(target, []byte("old"), 0o700)
	_ = os.WriteFile(staged, []byte("new"), 0o700)
	request := signedApplyRequest(t, privateKey, []byte("new"), "0.2.0")
	request.TargetPath, request.StagedPath = target, staged

	launched := false
	err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return errors.New("still running") }, func(string) error { launched = true; return nil })
	if err == nil || !strings.Contains(err.Error(), "wait for BIG DUCKS processes") {
		t.Fatalf("apply() error = %v, want process wait failure", err)
	}
	if launched {
		t.Fatal("updated executable was launched while processes were still running")
	}
	if got, _ := os.ReadFile(target); string(got) != "old" {
		t.Fatalf("target changed to %q", got)
	}
}

func TestApplyReportsLaunchFailureAfterReplacement(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(target, []byte("old"), 0o700)
	_ = os.WriteFile(staged, []byte("new"), 0o700)
	request := signedApplyRequest(t, privateKey, []byte("new"), "0.2.0")
	request.TargetPath, request.StagedPath = target, staged

	err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(string) error { return errors.New("boom") })
	if err == nil || !strings.Contains(err.Error(), "start updated BIG DUCKS") {
		t.Fatalf("apply() error = %v, want launch failure", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "new" {
		t.Fatalf("target = %q, want replaced binary", got)
	}
}

func TestApplyRejectsMissingTargetDuringBackup(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(staged, []byte("new"), 0o700)
	request := signedApplyRequest(t, privateKey, []byte("new"), "0.2.0")
	request.TargetPath, request.StagedPath = target, staged

	if err := apply(context.Background(), request, base64.StdEncoding.EncodeToString(publicKey), func(context.Context, []int) error { return nil }, func(string) error { return nil }); err == nil || !strings.Contains(err.Error(), "back up current executable") {
		t.Fatalf("apply() error = %v, want backup failure", err)
	}
	if got, _ := os.ReadFile(staged); string(got) != "new" {
		t.Fatalf("staged file was disturbed: %q", got)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 1 {
		t.Fatalf("temporary files leaked: %v", entries)
	}
}

func TestUniquePositivePIDsFiltersAndDeduplicates(t *testing.T) {
	want := []int{7, 2}
	got := uniquePositivePIDs([]int{7, -1, 0, 7, 2, 7})
	if len(got) != len(want) {
		t.Fatalf("uniquePositivePIDs() = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("uniquePositivePIDs() = %v, want %v", got, want)
		}
	}
}

func TestWriteApplyRequestValidatesInputs(t *testing.T) {
	request := ApplyRequest{TargetPath: "target", StagedPath: "staged"}
	if _, err := WriteApplyRequest("", request); err == nil {
		t.Fatal("WriteApplyRequest() accepted an empty data directory")
	}
	emptyPaths := ApplyRequest{}
	if _, err := WriteApplyRequest(t.TempDir(), emptyPaths); err == nil {
		t.Fatal("WriteApplyRequest() accepted empty target and staged paths")
	}
	request.TargetPath = ""
	if _, err := WriteApplyRequest(t.TempDir(), request); err == nil {
		t.Fatal("WriteApplyRequest() accepted an empty target path")
	}
}

func TestLoadApplyRequestRejectsIncompleteOrMissing(t *testing.T) {
	if _, err := LoadApplyRequest(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("LoadApplyRequest() accepted a missing file")
	}
	path := filepath.Join(t.TempDir(), "incomplete.json")
	if err := os.WriteFile(path, []byte(`{"targetPath":"t","stagedPath":"s"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadApplyRequest(path); err == nil {
		t.Fatal("LoadApplyRequest() accepted an incomplete request")
	}
}

func TestApplyFromRequestRemovesRequestFileOnSuccess(t *testing.T) {
	payload, err := os.ReadFile("/bin/true")
	if err != nil {
		t.Skipf("no harmless executable available: %v", err)
	}
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(target, payload, 0o755)
	_ = os.WriteFile(staged, payload, 0o755)
	request := signedApplyRequest(t, privateKey, payload, "0.2.0")
	request.TargetPath, request.StagedPath = target, staged
	requestPath, err := WriteApplyRequest(directory, request)
	if err != nil {
		t.Fatalf("WriteApplyRequest() error = %v", err)
	}

	if err := ApplyFromRequest(context.Background(), requestPath, base64.StdEncoding.EncodeToString(publicKey)); err != nil {
		t.Fatalf("ApplyFromRequest() error = %v", err)
	}
	if _, err := os.Stat(requestPath); !os.IsNotExist(err) {
		t.Fatalf("request file survived a successful apply: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("Stat(target) error = %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("replaced executable mode = %v, want an executable bit", info.Mode().Perm())
	}
}

func TestApplyFromRequestKeepsRequestOnFailure(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	directory := t.TempDir()
	target := filepath.Join(directory, "BigDucks.exe")
	staged := filepath.Join(directory, "staged.exe")
	_ = os.WriteFile(target, []byte("old"), 0o755)
	_ = os.WriteFile(staged, []byte("tampered"), 0o755)
	request := signedApplyRequest(t, privateKey, []byte("signed payload"), "0.2.0")
	request.TargetPath, request.StagedPath = target, staged
	requestPath, err := WriteApplyRequest(directory, request)
	if err != nil {
		t.Fatalf("WriteApplyRequest() error = %v", err)
	}

	if err := ApplyFromRequest(context.Background(), requestPath, base64.StdEncoding.EncodeToString(publicKey)); err == nil {
		t.Fatal("ApplyFromRequest() accepted a tampered staged executable")
	}
	if _, err := os.Stat(requestPath); err != nil {
		t.Fatalf("request file was removed after a failed apply: %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "old" {
		t.Fatalf("target changed to %q", got)
	}
}
