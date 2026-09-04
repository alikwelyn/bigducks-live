//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/getlantern/systray"
	"golang.org/x/sys/windows"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/discord"
	"github.com/alikwelyn/bigducks-live/internal/hud"
	"github.com/alikwelyn/bigducks-live/internal/logging"
	"github.com/alikwelyn/bigducks-live/internal/startup"
	"github.com/alikwelyn/bigducks-live/internal/supervisor"
	apptray "github.com/alikwelyn/bigducks-live/internal/tray"
	"github.com/alikwelyn/bigducks-live/internal/update"
)

const (
	trayOpenLabel    = "Abrir"
	trayRestartLabel = "Reiniciar"
	trayRepairLabel  = "Corrigir Discord"
	trayQuitLabel    = "Sair"
	trayEnableLabel  = "Ativar"
)

type trayController struct {
	core         *supervisor.Supervisor
	helperPath   string
	dataDir      string
	configPath   string
	logger       *logging.Logger
	closed       chan struct{}
	closeOnce    sync.Once
	shutdownOnce sync.Once

	openItem    *systray.MenuItem
	restartItem *systray.MenuItem
	repairItem  *systray.MenuItem
	quitItem    *systray.MenuItem
	enableItem  *systray.MenuItem
	openOnReady bool
	closing     atomic.Bool
	repairing   atomic.Bool
	updating    atomic.Bool
}

func runTray(config app.Config, _ *startup.Manager, helperPath string, _ bool, openOnReady bool) error {
	logger, err := logging.New(filepath.Join(config.DataDir, app.LogFileName), 256*1024)
	if err != nil {
		return err
	}
	controller := &trayController{
		helperPath:  helperPath,
		logger:      logger,
		dataDir:     config.DataDir,
		configPath:  filepath.Join(config.DataDir, app.ConfigFileName),
		closed:      make(chan struct{}),
		openOnReady: openOnReady,
	}
	controller.core = supervisor.New(supervisor.Options{
		Executable: helperPath,
		DataDir:    config.DataDir,
		Logger:     logger,
	})
	systray.Run(controller.onReady, controller.onExit)
	return nil
}

func (c *trayController) onReady() {
	systray.SetIcon(apptray.Icon())
	systray.SetTooltip("BIG DUCKS LIVE — iniciando proteção")
	c.openItem = systray.AddMenuItem(trayOpenLabel, "Abrir o painel de proteção das lives")
	c.restartItem = systray.AddMenuItem(trayRestartLabel, "Reiniciar somente o núcleo, mantendo o Discord aberto")
	c.repairItem = systray.AddMenuItem(trayRepairLabel, "Fechar e reabrir o Discord pela rota protegida")
	c.quitItem = systray.AddMenuItem(trayQuitLabel, "Encerrar o BIG DUCKS e fechar completamente o Discord")
	c.enableItem = systray.AddMenuItem(trayEnableLabel, "Ativar a proteção quando ela estiver desativada")
	if !c.configDisabled() {
		c.enableItem.Disable()
	}
	c.restartItem.Disable()
	c.repairItem.Disable()
	go c.menuLoop()
	go c.startCore()
	go c.watchForUpdate()
	go c.watchCore()
}

func (c *trayController) watchCore() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if !shouldRestartCore(c.closing.Load(), c.updating.Load(), c.core.Running()) {
				continue
			}
			c.logger.Printf("protection core exited unexpectedly; restarting automatically")
			systray.SetTooltip("BIG DUCKS LIVE — recuperando proteção")
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := c.core.Start(ctx)
			cancel()
			if err != nil {
				c.logger.Printf("automatic protection core restart failed: %v", err)
				systray.SetTooltip("BIG DUCKS LIVE — falha no núcleo")
			} else {
				systray.SetTooltip("BIG DUCKS LIVE — proteção recuperada")
			}
		case <-c.closed:
			return
		}
	}
}

func shouldRestartCore(closing, updating, running bool) bool {
	return !closing && !updating && !running
}

func (c *trayController) watchForUpdate() {
	path := filepath.Join(c.dataDir, update.ApplyRequestFileName)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if _, err := os.Stat(path); err == nil {
				c.beginUpdate(path)
				return
			}
		case <-c.closed:
			return
		}
	}
}

func (c *trayController) beginUpdate(path string) {
	c.updating.Store(true)
	request, err := update.LoadApplyRequest(path)
	if err != nil {
		c.updating.Store(false)
		c.logger.Printf("pending update request is invalid: %v", err)
		_ = os.Remove(path)
		return
	}
	request.WaitPIDs = append(request.WaitPIDs, os.Getpid())
	if _, err := update.WriteApplyRequest(c.dataDir, request); err != nil {
		c.updating.Store(false)
		c.logger.Printf("could not prepare pending update: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	stopErr := c.core.Stop(ctx)
	cancel()
	if stopErr != nil {
		c.logger.Printf("could not stop protection core for update: %v", stopErr)
	}
	command := exec.Command(request.StagedPath, "--apply-update", path)
	command.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
	if err := command.Start(); err != nil {
		c.updating.Store(false)
		c.logger.Printf("could not start signed updater: %v", err)
		_ = c.core.Start(context.Background())
		return
	}
	_ = command.Process.Release()
	c.logger.Printf("installing signed BIG DUCKS %s", request.Version)
	systray.Quit()
}

func (c *trayController) onExit() {
	if c.closing.Load() {
		c.shutdownResources()
		return
	}
	c.closeOnce.Do(func() { close(c.closed) })
	c.stopCore()
}

func (c *trayController) quitEverything() {
	c.shutdownResources()
	systray.Quit()
}

func (c *trayController) shutdownResources() {
	if c == nil {
		return
	}
	c.shutdownOnce.Do(func() {
		c.closing.Store(true)
		c.updating.Store(true)
		c.closeOnce.Do(func() { close(c.closed) })
		if c.openItem != nil {
			c.openItem.Disable()
		}
		if c.restartItem != nil {
			c.restartItem.Disable()
		}
		if c.repairItem != nil {
			c.repairItem.Disable()
		}
		if c.enableItem != nil {
			c.enableItem.Disable()
		}

		hudCtx, cancelHUD := context.WithTimeout(context.Background(), 5*time.Second)
		if err := hud.CloseExisting(hudCtx); err != nil && c.logger != nil {
			c.logger.Printf("could not close HUD before exit: %v", err)
		}
		cancelHUD()

		c.stopCore()
		if identity, err := discord.CurrentProcess(); err == nil && identity.PID > 0 {
			discord.KillProcessTree(int(identity.PID))
		}
	})
}

func (c *trayController) stopCore() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if c.core != nil {
		if err := c.core.Stop(ctx); err != nil && c.logger != nil {
			c.logger.Printf("could not stop protection core before exit: %v", err)
		}
	}
}

func (c *trayController) configDisabled() bool {
	config, err := app.LoadConfig(c.configPath)
	return err == nil && config.Disabled
}

func (c *trayController) enableProtection(item *systray.MenuItem) {
	config, err := app.LoadConfig(c.configPath)
	if err != nil {
		c.logger.Printf("could not load configuration to enable protection: %v", err)
		return
	}
	config.Disabled = false
	if err := app.SaveConfig(c.configPath, config); err != nil {
		c.logger.Printf("could not enable protection: %v", err)
		return
	}
	item.Disable()
	c.restartCore()
}

func (c *trayController) menuLoop() {
	for {
		select {
		case <-c.openItem.ClickedCh:
			c.openHUD()
		case <-c.restartItem.ClickedCh:
			go c.restartCore()
		case <-c.repairItem.ClickedCh:
			go c.repairDiscord()
		case <-c.quitItem.ClickedCh:
			go c.quitEverything()
		case <-c.enableItem.ClickedCh:
			go c.enableProtection(c.enableItem)
		case <-c.closed:
			return
		}
	}
}

func confirmAndRepair(confirm func() bool, repair func(context.Context) error) (bool, error) {
	if confirm == nil || !confirm() {
		return false, nil
	}
	if repair == nil {
		return true, fmt.Errorf("Discord repair callback is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return true, repair(ctx)
}

func (c *trayController) repairDiscord() {
	if c == nil || c.closing.Load() || c.updating.Load() || !c.repairing.CompareAndSwap(false, true) {
		return
	}
	defer c.repairing.Store(false)
	c.repairItem.Disable()
	confirmedRepair := func() bool { return c.confirmRepair() }
	repair := func(ctx context.Context) error {
		client, err := c.core.Client()
		if err != nil {
			return err
		}
		return client.RepairDiscord(ctx)
	}
	confirmed, err := confirmAndRepair(confirmedRepair, repair)
	if err != nil {
		c.logger.Printf("Discord repair failed: %v", err)
		systray.SetTooltip("BIG DUCKS LIVE — falha ao corrigir Discord")
		c.showError("Não foi possível corrigir o Discord", err)
	} else if confirmed && !c.closing.Load() {
		systray.SetTooltip("BIG DUCKS LIVE — Discord corrigido")
	}
	if !c.closing.Load() && !c.updating.Load() {
		c.repairItem.Enable()
	}
}

func (c *trayController) confirmRepair() bool {
	message, _ := windows.UTF16PtrFromString("O Discord será fechado e reaberto pela rota protegida. Continuar?")
	caption, _ := windows.UTF16PtrFromString("Corrigir Discord — BIG DUCKS LIVE")
	const idYes = 6
	result, _ := windows.MessageBox(0, message, caption, windows.MB_ICONQUESTION|windows.MB_YESNO|windows.MB_DEFBUTTON2)
	return result == idYes
}

func (c *trayController) startCore() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := c.core.Start(ctx); err != nil {
		c.logger.Printf("protection core startup failed: %v", err)
		systray.SetTooltip("BIG DUCKS LIVE — falha ao iniciar")
		c.showError("Não foi possível iniciar a proteção", err)
		return
	}
	if c.closing.Load() {
		return
	}
	c.restartItem.Enable()
	if !c.configDisabled() {
		c.repairItem.Enable()
	}
	systray.SetTooltip("BIG DUCKS LIVE — proteção ativa")
	if c.openOnReady {
		c.openHUD()
	}
}

func (c *trayController) restartCore() {
	if c == nil || c.closing.Load() || c.updating.Load() {
		return
	}
	c.restartItem.Disable()
	c.repairItem.Disable()
	systray.SetTooltip("BIG DUCKS LIVE — reiniciando proteção")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := c.core.Restart(ctx)
	if err != nil {
		c.logger.Printf("protection core restart failed: %v", err)
		systray.SetTooltip("BIG DUCKS LIVE — falha no restart")
		c.showError("Não foi possível reiniciar a proteção", err)
	} else {
		c.logger.Printf("protection core restarted from tray without closing Discord")
		systray.SetTooltip("BIG DUCKS LIVE — proteção reiniciada")
	}
	if !c.closing.Load() && !c.updating.Load() {
		c.restartItem.Enable()
		if !c.configDisabled() {
			c.repairItem.Enable()
		}
	}
}

func (c *trayController) openHUD() {
	if hud.ActivateExisting() {
		return
	}
	command := exec.Command(c.helperPath, "--hud")
	if err := command.Start(); err != nil {
		c.showError("Não foi possível abrir o painel", err)
		return
	}
	_ = command.Process.Release()
}

func (c *trayController) showError(title string, err error) {
	message, _ := windows.UTF16PtrFromString(fmt.Sprintf("%s.\n\nDetalhes: %v", title, err))
	caption, _ := windows.UTF16PtrFromString("BIG DUCKS LIVE")
	_, _ = windows.MessageBox(0, message, caption, windows.MB_ICONERROR)
}
