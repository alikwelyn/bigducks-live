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
	"github.com/alikwelyn/bigducks-live/internal/logging"
	"github.com/alikwelyn/bigducks-live/internal/startup"
	"github.com/alikwelyn/bigducks-live/internal/supervisor"
	apptray "github.com/alikwelyn/bigducks-live/internal/tray"
	"github.com/alikwelyn/bigducks-live/internal/update"
)

type trayController struct {
	core       *supervisor.Supervisor
	helperPath string
	dataDir    string
	logger     *logging.Logger
	closed     chan struct{}
	closeOnce  sync.Once

	openItem    *systray.MenuItem
	restartItem *systray.MenuItem
	quitItem    *systray.MenuItem
	openOnReady bool
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
	c.openItem = systray.AddMenuItem("Abrir BIG DUCKS", "Abrir o painel de proteção das lives")
	c.restartItem = systray.AddMenuItem("Reiniciar proteção", "Reiniciar somente o núcleo, mantendo o Discord aberto")
	systray.AddSeparator()
	c.quitItem = systray.AddMenuItem("Sair", "Encerrar o BIG DUCKS sem fechar o Discord")
	c.restartItem.Disable()
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
			if c.updating.Load() || c.core.Running() {
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
	c.closeOnce.Do(func() { close(c.closed) })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.core.Stop(ctx); err != nil {
		c.logger.Printf("could not stop protection core cleanly: %v", err)
	}
}

func (c *trayController) menuLoop() {
	for {
		select {
		case <-c.openItem.ClickedCh:
			c.openHUD()
		case <-c.restartItem.ClickedCh:
			go c.restartCore()
		case <-c.quitItem.ClickedCh:
			systray.Quit()
		case <-c.closed:
			return
		}
	}
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
	c.restartItem.Enable()
	systray.SetTooltip("BIG DUCKS LIVE — proteção ativa")
	if c.openOnReady {
		c.openHUD()
	}
}

func (c *trayController) restartCore() {
	c.restartItem.Disable()
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
	c.restartItem.Enable()
}

func (c *trayController) openHUD() {
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
