package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
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
