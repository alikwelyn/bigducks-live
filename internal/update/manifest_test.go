package update_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/update"
)

func TestVerifyManifestAcceptsSignedMatchingAsset(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	payload := []byte("new executable")
	digest := sha256.Sum256(payload)
	manifest := update.Manifest{
		Version: "1.2.0", Asset: update.WindowsAssetName, Size: int64(len(payload)), SHA256: hex.EncodeToString(digest[:]),
	}
	encoded, err := update.EncodeManifest(manifest)
	if err != nil {
		t.Fatalf("EncodeManifest() error = %v", err)
	}
	signature := ed25519.Sign(privateKey, encoded)
	verified, err := update.VerifyManifest(encoded, base64.StdEncoding.EncodeToString(signature), base64.StdEncoding.EncodeToString(publicKey))
	if err != nil {
		t.Fatalf("VerifyManifest() error = %v", err)
	}
	if verified != manifest {
		t.Fatalf("verified manifest = %#v", verified)
	}
	if err := update.VerifyAsset(verified, payload); err != nil {
		t.Fatalf("VerifyAsset() error = %v", err)
	}
}

func TestVerifyManifestRejectsTamperingAndDowngrades(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	manifest := update.Manifest{Version: "1.2.0", Asset: update.WindowsAssetName, Size: 3, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	encoded, _ := update.EncodeManifest(manifest)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, encoded))
	encoded[len(encoded)-2] ^= 1
	if _, err := update.VerifyManifest(encoded, signature, base64.StdEncoding.EncodeToString(publicKey)); err == nil {
		t.Fatal("tampered manifest was accepted")
	}
	if update.IsNewer("1.1.9", "1.2.0") {
		t.Fatal("downgrade was considered newer")
	}
	if !update.IsNewer("1.2.1", "1.2.0") {
		t.Fatal("new patch release was not considered newer")
	}
}

func TestVerifyAssetRejectsWrongHashOrSize(t *testing.T) {
	manifest := update.Manifest{Version: "1.2.0", Asset: update.WindowsAssetName, Size: 4, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	if err := update.VerifyAsset(manifest, []byte("bad")); err == nil {
		t.Fatal("asset with wrong size and hash was accepted")
	}
}
