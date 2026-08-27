package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/fileutil"
)

const LatestReleaseURL = "https://api.github.com/repos/alikwelyn/bigducks-live/releases/latest"

type ClientOptions struct {
	LatestReleaseURL string
	CurrentVersion   string
	PublicKey        string
	HTTPClient       *http.Client
}

type Client struct {
	latestReleaseURL string
	currentVersion   string
	publicKey        string
	httpClient       *http.Client
}

type Result struct {
	Available   bool     `json:"available"`
	Manifest    Manifest `json:"manifest"`
	DownloadURL string   `json:"-"`
	ManifestRaw []byte   `json:"-"`
	Signature   string   `json:"-"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type releaseResponse struct {
	TagName    string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Assets     []releaseAsset `json:"assets"`
}

func NewClient(options ClientOptions) *Client {
	if options.LatestReleaseURL == "" {
		options.LatestReleaseURL = LatestReleaseURL
	}
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		latestReleaseURL: options.LatestReleaseURL,
		currentVersion:   options.CurrentVersion,
		publicKey:        options.PublicKey,
		httpClient:       options.HTTPClient,
	}
}

func (c *Client) Check(ctx context.Context) (Result, error) {
	if c == nil || c.httpClient == nil || c.currentVersion == "" || c.publicKey == "" {
		return Result{}, errors.New("update client is not configured")
	}
	var release releaseResponse
	if err := c.getJSON(ctx, c.latestReleaseURL, &release); err != nil {
		return Result{}, fmt.Errorf("check latest release: %w", err)
	}
	if release.Draft || release.Prerelease {
		return Result{}, nil
	}
	candidate := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
	if !IsNewer(candidate, c.currentVersion) {
		return Result{}, nil
	}
	manifestAsset, ok := findReleaseAsset(release.Assets, ManifestAssetName)
	if !ok {
		return Result{}, fmt.Errorf("release %s does not include %s", release.TagName, ManifestAssetName)
	}
	signatureAsset, ok := findReleaseAsset(release.Assets, SignatureAssetName)
	if !ok {
		return Result{}, fmt.Errorf("release %s does not include %s", release.TagName, SignatureAssetName)
	}
	executableAsset, ok := findReleaseAsset(release.Assets, WindowsAssetName)
	if !ok {
		return Result{}, fmt.Errorf("release %s does not include %s", release.TagName, WindowsAssetName)
	}
	manifestData, err := c.download(ctx, manifestAsset.BrowserDownloadURL, 64*1024)
	if err != nil {
		return Result{}, fmt.Errorf("download update manifest: %w", err)
	}
	signatureData, err := c.download(ctx, signatureAsset.BrowserDownloadURL, 4*1024)
	if err != nil {
		return Result{}, fmt.Errorf("download update signature: %w", err)
	}
	manifest, err := VerifyManifest(manifestData, string(signatureData), c.publicKey)
	if err != nil {
		return Result{}, err
	}
	if manifest.Version != candidate {
		return Result{}, fmt.Errorf("signed version %s does not match release %s", manifest.Version, release.TagName)
	}
	if manifest.Size != executableAsset.Size {
		return Result{}, fmt.Errorf("signed size %d does not match release asset size %d", manifest.Size, executableAsset.Size)
	}
	return Result{
		Available: true, Manifest: manifest, DownloadURL: executableAsset.BrowserDownloadURL,
		ManifestRaw: append([]byte(nil), manifestData...), Signature: strings.TrimSpace(string(signatureData)),
	}, nil
}

func (c *Client) Stage(ctx context.Context, result Result, dataDir string) (string, error) {
	if !result.Available || result.DownloadURL == "" {
		return "", errors.New("no update is available to stage")
	}
	if err := validateManifest(result.Manifest); err != nil {
		return "", err
	}
	payload, err := c.download(ctx, result.DownloadURL, result.Manifest.Size)
	if err != nil {
		return "", fmt.Errorf("download update executable: %w", err)
	}
	if err := VerifyAsset(result.Manifest, payload); err != nil {
		return "", err
	}
	updatesDir := filepath.Join(dataDir, "updates", result.Manifest.Version)
	if err := os.MkdirAll(updatesDir, 0o700); err != nil {
		return "", fmt.Errorf("create update staging directory: %w", err)
	}
	temporary, err := os.CreateTemp(updatesDir, "BigDucks-*.exe.tmp")
	if err != nil {
		return "", fmt.Errorf("create staged update: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if _, err := temporary.Write(payload); err != nil {
		cleanup()
		return "", fmt.Errorf("write staged update: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return "", fmt.Errorf("flush staged update: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return "", fmt.Errorf("close staged update: %w", err)
	}
	destination := filepath.Join(updatesDir, WindowsAssetName)
	if err := fileutil.Replace(temporaryPath, destination); err != nil {
		_ = os.Remove(temporaryPath)
		return "", fmt.Errorf("publish staged update: %w", err)
	}
	return destination, nil
}

func (c *Client) getJSON(ctx context.Context, url string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "BIG-DUCKS-LIVE-updater")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 32*1024))
		return fmt.Errorf("server returned %s", response.Status)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(target); err != nil {
		return err
	}
	return nil
}

func (c *Client) download(ctx context.Context, url string, maximum int64) ([]byte, error) {
	if maximum < 1 || maximum > 100*1024*1024 {
		return nil, errors.New("download size limit is invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "BIG-DUCKS-LIVE-updater")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned %s", response.Status)
	}
	if response.ContentLength > maximum {
		return nil, fmt.Errorf("download is larger than the allowed %d bytes", maximum)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, fmt.Errorf("download is larger than the allowed %d bytes", maximum)
	}
	return data, nil
}

func findReleaseAsset(assets []releaseAsset, name string) (releaseAsset, bool) {
	for _, asset := range assets {
		if asset.Name == name && asset.BrowserDownloadURL != "" {
			return asset, true
		}
	}
	return releaseAsset{}, false
}
