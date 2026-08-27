package update_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/alikwelyn/bigducks-live/internal/update"
)

func TestClientStagesVerifiedLatestRelease(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	executable := []byte("signed BIG DUCKS executable")
	digest := sha256.Sum256(executable)
	manifest := update.Manifest{
		Version: "0.2.0", Asset: update.WindowsAssetName, Size: int64(len(executable)), SHA256: hex.EncodeToString(digest[:]),
	}
	manifestData, _ := update.EncodeManifest(manifest)
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestData))

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/releases/latest":
			_ = json.NewEncoder(response).Encode(map[string]any{
				"tag_name": "v0.2.0", "draft": false, "prerelease": false,
				"assets": []map[string]any{
					{"name": update.ManifestAssetName, "browser_download_url": serverURL(request) + "/manifest", "size": len(manifestData)},
					{"name": update.SignatureAssetName, "browser_download_url": serverURL(request) + "/signature", "size": len(signature)},
					{"name": update.WindowsAssetName, "browser_download_url": serverURL(request) + "/executable", "size": len(executable)},
				},
			})
		case "/manifest":
			_, _ = response.Write(manifestData)
		case "/signature":
			_, _ = response.Write([]byte(signature))
		case "/executable":
			_, _ = response.Write(executable)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	client := update.NewClient(update.ClientOptions{
		LatestReleaseURL: server.URL + "/releases/latest",
		CurrentVersion:   "0.1.0",
		PublicKey:        base64.StdEncoding.EncodeToString(publicKey),
	})
	result, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if !result.Available || result.Manifest.Version != "0.2.0" {
		t.Fatalf("Check() result = %#v", result)
	}
	path, err := client.Stage(context.Background(), result, t.TempDir())
	if err != nil {
		t.Fatalf("Stage() error = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(got) != string(executable) {
		t.Fatalf("staged executable = %q", got)
	}
	if filepath.Ext(path) != ".exe" {
		t.Fatalf("staged path = %q", path)
	}
}

func TestClientRejectsUnsignedOrDowngradeRelease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{
			"tag_name": "v0.0.9", "assets": []any{},
		})
	}))
	defer server.Close()
	client := update.NewClient(update.ClientOptions{
		LatestReleaseURL: server.URL, CurrentVersion: "0.1.0", PublicKey: base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize)),
	})
	result, err := client.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() downgrade error = %v", err)
	}
	if result.Available {
		t.Fatalf("downgrade result = %#v", result)
	}
}

func serverURL(request *http.Request) string {
	return "http://" + request.Host
}
