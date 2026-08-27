package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/alikwelyn/bigducks-live/internal/update"
)

func main() {
	version := flag.String("version", "", "release version without the v prefix")
	assetPath := flag.String("asset", "", "path to the Windows executable")
	outputDir := flag.String("output", ".", "directory for manifest.json and manifest.sig")
	generateFor := flag.String("generate-key-for", "", "GitHub owner/repository where the private signing key will be stored")
	flag.Parse()

	var err error
	if *generateFor != "" {
		err = generateSigningKey(*generateFor)
	} else {
		err = signRelease(*version, *assetPath, *outputDir)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generateSigningKey(repository string) error {
	if !strings.Contains(repository, "/") {
		return errors.New("repository must use owner/name")
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("generate Ed25519 key: %w", err)
	}
	encodedPrivate := base64.StdEncoding.EncodeToString(privateKey)
	command := exec.Command("gh", "secret", "set", "UPDATE_SIGNING_KEY", "--repo", repository)
	command.Stdin = strings.NewReader(encodedPrivate)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("store GitHub Actions signing key: %w", err)
	}
	fmt.Println(base64.StdEncoding.EncodeToString(publicKey))
	return nil
}

func signRelease(version, assetPath, outputDir string) error {
	if version == "" || assetPath == "" {
		return errors.New("-version and -asset are required")
	}
	privateKeyData, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("UPDATE_SIGNING_KEY")))
	if err != nil || len(privateKeyData) != ed25519.PrivateKeySize {
		return errors.New("UPDATE_SIGNING_KEY must contain a base64 Ed25519 private key")
	}
	asset, err := os.ReadFile(assetPath)
	if err != nil {
		return fmt.Errorf("read release executable: %w", err)
	}
	digest := sha256.Sum256(asset)
	manifestData, err := update.EncodeManifest(update.Manifest{
		Version: strings.TrimPrefix(version, "v"), Asset: update.WindowsAssetName,
		Size: int64(len(asset)), SHA256: hex.EncodeToString(digest[:]),
	})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return err
	}
	manifestPath := filepath.Join(outputDir, update.ManifestAssetName)
	signaturePath := filepath.Join(outputDir, update.SignatureAssetName)
	if err := os.WriteFile(manifestPath, manifestData, 0o600); err != nil {
		return err
	}
	signature := ed25519.Sign(ed25519.PrivateKey(privateKeyData), manifestData)
	encodedSignature := base64.StdEncoding.EncodeToString(signature) + "\n"
	if err := os.WriteFile(signaturePath, []byte(encodedSignature), 0o600); err != nil {
		return err
	}
	return nil
}
