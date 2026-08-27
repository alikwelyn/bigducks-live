package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	WindowsAssetName   = "BigDucks-windows-amd64.exe"
	ManifestAssetName  = "manifest.json"
	SignatureAssetName = "manifest.sig"
)

type Manifest struct {
	Version string `json:"version"`
	Asset   string `json:"asset"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

func EncodeManifest(manifest Manifest) ([]byte, error) {
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func VerifyManifest(data []byte, signatureBase64, publicKeyBase64 string) (Manifest, error) {
	publicKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(publicKeyBase64))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return Manifest{}, errors.New("update public key is invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signatureBase64))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Manifest{}, errors.New("update signature is invalid")
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), data, signature) {
		return Manifest{}, errors.New("update manifest signature did not match")
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode update manifest: %w", err)
	}
	if err := validateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func VerifyAsset(manifest Manifest, data []byte) error {
	if err := validateManifest(manifest); err != nil {
		return err
	}
	if int64(len(data)) != manifest.Size {
		return fmt.Errorf("update size = %d, want %d", len(data), manifest.Size)
	}
	digest := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), manifest.SHA256) {
		return errors.New("update SHA-256 did not match the signed manifest")
	}
	return nil
}

func IsNewer(candidate, current string) bool {
	next, ok := parseVersion(candidate)
	if !ok {
		return false
	}
	present, ok := parseVersion(current)
	if !ok {
		return false
	}
	for index := range next {
		if next[index] != present[index] {
			return next[index] > present[index]
		}
	}
	return false
}

func validateManifest(manifest Manifest) error {
	if _, ok := parseVersion(manifest.Version); !ok {
		return fmt.Errorf("invalid update version %q", manifest.Version)
	}
	if manifest.Asset != WindowsAssetName {
		return fmt.Errorf("unexpected update asset %q", manifest.Asset)
	}
	if manifest.Size < 1 || manifest.Size > 100*1024*1024 {
		return fmt.Errorf("invalid update size %d", manifest.Size)
	}
	digest, err := hex.DecodeString(manifest.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("invalid update SHA-256")
	}
	return nil
}

func parseVersion(value string) ([3]int, bool) {
	var result [3]int
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	if strings.ContainsAny(value, "+-") {
		return result, false
	}
	parts := strings.Split(value, ".")
	if len(parts) != len(result) {
		return result, false
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return result, false
		}
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return result, false
		}
		result[index] = number
	}
	return result, true
}
