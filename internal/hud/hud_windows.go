//go:build windows

package hud

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"sync"
	"time"

	webview "github.com/jchv/go-webview2"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/bridge"
	"github.com/alikwelyn/bigducks-live/internal/buildinfo"
	"github.com/alikwelyn/bigducks-live/internal/controlapi"
	"github.com/alikwelyn/bigducks-live/internal/update"
)

type StatusView struct {
	State           string             `json:"state"`
	Media           app.MediaStatus    `json:"media"`
	PoolSize        int                `json:"poolSize"`
	TunnelCount     int                `json:"tunnelCount"`
	BridgeConnected bool               `json:"bridgeConnected"`
	InjectionState  string             `json:"injectionState"`
	RepairRequired  bool               `json:"repairRequired"`
	LastError       string             `json:"lastError"`
	LastMessage     string             `json:"lastMessage"`
	ActiveProxy     string             `json:"activeProxy"`
	LatencyMS       int                `json:"latencyMS"`
	RecentEvents    []app.RuntimeEvent `json:"recentEvents"`
}

type controller struct {
	dataDir    string
	view       webview.WebView
	mu         sync.Mutex
	result     update.Result
	checking   bool
	updateView UpdateView
}

type UpdateView struct {
	Available bool   `json:"available"`
	Checking  bool   `json:"checking"`
	Error     bool   `json:"error"`
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Message   string `json:"message"`
}

const (
	HUDWidth        = 1180
	HUDHeight       = 700
	zoomGuardScript = `(function () {
  const keys = new Set(["+", "=", "-", "_", "0", "Add", "Subtract"]);
  document.addEventListener("keydown", function (event) {
    if (event.ctrlKey && keys.has(event.key)) event.preventDefault();
  }, {capture: true});
  document.addEventListener("wheel", function (event) {
    if (event.ctrlKey) event.preventDefault();
  }, {capture: true, passive: false});
})();`
)

func Run(dataDir string) error {
	return runSingleHUD(acquireHUD, ActivateExisting, func() error {
		return runWindow(dataDir)
	})
}

func runWindow(dataDir string) (err error) {
	if dataDir == "" {
		return errors.New("HUD data directory is empty")
	}
	if err := bridge.ProtectDataDirectory(dataDir); err != nil {
		return err
	}
	cachePath := hudCachePath(dataDir, os.Getpid())
	cleanupStaleCaches(filepath.Dir(cachePath), os.Getpid(), 7*24*time.Hour)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("initialize WebView2 HUD: %v\n%s", recovered, debug.Stack())
		}
	}()
	view := webview.NewWithOptions(webview.WebViewOptions{
		Debug:     false,
		DataPath:  cachePath,
		AutoFocus: true,
		WindowOptions: webview.WindowOptions{
			Title: HUDWindowTitle, Width: HUDWidth, Height: HUDHeight, IconId: 1, Center: true,
		},
	})
	if view == nil {
		return errors.New("WebView2 Runtime is unavailable")
	}
	defer view.Destroy()
	fitAndCenterHUD(view)
	view.Init(zoomGuardScript)
	control := &controller{
		dataDir:    dataDir,
		view:       view,
		updateView: UpdateView{Current: buildinfo.Version},
	}
	bindings := map[string]any{
		"bigDucksStatus":        control.status,
		"bigDucksReconnect":     control.reconnect,
		"bigDucksTestRoute":     control.testRoute,
		"bigDucksReload":        control.reload,
		"bigDucksOpenLog":       control.openLog,
		"bigDucksCheckUpdate":   control.checkUpdate,
		"bigDucksUpdateStatus":  control.updateStatus,
		"bigDucksInstallUpdate": control.installUpdate,
		"bigDucksClose":         control.close,
	}
	for name, binding := range bindings {
		if bindErr := view.Bind(name, binding); bindErr != nil {
			return fmt.Errorf("bind HUD action %s: %w", name, bindErr)
		}
	}
	view.SetHtml(PageHTML())
	view.Run()
	return nil
}

func hudCachePath(dataDir string, processID int) string {
	return filepath.Join(dataDir, "hud-cache", strconv.Itoa(processID))
}

func cleanupStaleCaches(root string, currentProcessID int, maximumAge time.Duration) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	deadline := time.Now().Add(-maximumAge)
	current := strconv.Itoa(currentProcessID)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == current {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(deadline) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, entry.Name()))
	}
}

func startAsyncUpdateCheck(check func() UpdateView, deliver func(UpdateView)) {
	go func() {
		deliver(check())
	}()
}

func (c *controller) checkUpdate() UpdateView {
	c.mu.Lock()
	if c.checking {
		view := c.updateView
		c.mu.Unlock()
		return view
	}
	pending := UpdateView{
		Checking: true,
		Current:  buildinfo.Version,
		Message:  "Consultando a versão assinada mais recente…",
	}
	c.checking = true
	c.updateView = pending
	c.mu.Unlock()
	startAsyncUpdateCheck(c.checkUpdateNow, c.finishUpdateCheck)
	return pending
}

func (c *controller) checkUpdateNow() UpdateView {
	if buildinfo.UpdatePublicKey == "" {
		return UpdateView{Error: true, Current: buildinfo.Version, Message: "Atualizações assinadas ainda não estão configuradas nesta build."}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client := c.updateClient()
	result, err := client.Check(ctx)
	if err != nil {
		return UpdateView{Error: true, Current: buildinfo.Version, Message: err.Error()}
	}
	c.mu.Lock()
	c.result = result
	c.mu.Unlock()
	if !result.Available {
		return UpdateView{Current: buildinfo.Version, Message: "Você já está usando a versão mais recente."}
	}
	return UpdateView{Available: true, Current: buildinfo.Version, Latest: result.Manifest.Version, Message: "Uma atualização assinada está pronta."}
}

func (c *controller) finishUpdateCheck(view UpdateView) {
	c.mu.Lock()
	c.checking = false
	c.updateView = view
	c.mu.Unlock()
}

func (c *controller) updateStatus() UpdateView {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.updateView
}

func (c *controller) installUpdate() error {
	c.mu.Lock()
	result := c.result
	c.mu.Unlock()
	if !result.Available {
		return errors.New("verifique se há uma atualização disponível antes de instalar")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	stagedPath, err := c.updateClient().Stage(ctx, result, c.dataDir)
	if err != nil {
		return err
	}
	targetPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("find BIG DUCKS executable: %w", err)
	}
	_, err = update.WriteApplyRequest(c.dataDir, update.ApplyRequest{
		Version: result.Manifest.Version, TargetPath: targetPath, StagedPath: stagedPath,
		Manifest: result.ManifestRaw, Signature: result.Signature, WaitPIDs: []int{os.Getpid()},
	})
	return err
}

func (c *controller) close() {
	if c != nil && c.view != nil {
		c.view.Terminate()
	}
}

func (c *controller) updateClient() *update.Client {
	return update.NewClient(update.ClientOptions{CurrentVersion: buildinfo.Version, PublicKey: buildinfo.UpdatePublicKey})
}

func (c *controller) status() StatusView {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := c.client()
	if err != nil {
		return StatusView{State: string(app.RecoveryStopped), LastError: err.Error()}
	}
	status, err := client.Status(ctx)
	if err != nil {
		return StatusView{State: string(app.RecoveryStopped), LastError: err.Error()}
	}
	return StatusView{
		State: string(status.State), Media: status.Media, PoolSize: status.PoolSize, TunnelCount: status.TunnelCount,
		BridgeConnected: status.BridgeConnected, InjectionState: status.InjectionState,
		RepairRequired: status.RepairRequired, LastError: status.LastError, LastMessage: status.LastMessage,
		ActiveProxy: status.ActiveProxy, LatencyMS: status.LatencyMS,
		RecentEvents: append([]app.RuntimeEvent(nil), status.RecentEvents...),
	}
}

func (c *controller) reconnect() error {
	return c.action(20*time.Second, (*controlapi.Client).Reconnect)
}

func (c *controller) testRoute() error {
	return c.action(8*time.Second, (*controlapi.Client).TestRoute)
}

func (c *controller) reload() error {
	return c.action(8*time.Second, (*controlapi.Client).Reload)
}

func (c *controller) openLog() error {
	path := filepath.Join(c.dataDir, app.LogFileName)
	if err := bridge.ProtectDataDirectory(c.dataDir); err != nil {
		return err
	}
	if err := exec.Command("notepad.exe", path).Start(); err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	return nil
}

func (c *controller) action(timeout time.Duration, action func(*controlapi.Client, context.Context) error) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return action(client, ctx)
}

func (c *controller) client() (*controlapi.Client, error) {
	return controlapi.LoadClient(filepath.Join(c.dataDir, controlapi.ControlFileName))
}
