//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/app"
	"github.com/alikwelyn/bigducks-live/internal/bridge"
	"github.com/alikwelyn/bigducks-live/internal/buildinfo"
	"github.com/alikwelyn/bigducks-live/internal/controlapi"
	"github.com/alikwelyn/bigducks-live/internal/discord"
	"github.com/alikwelyn/bigducks-live/internal/hud"
	"github.com/alikwelyn/bigducks-live/internal/injection"
	"github.com/alikwelyn/bigducks-live/internal/instance"
	"github.com/alikwelyn/bigducks-live/internal/logging"
	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/startup"
	"github.com/alikwelyn/bigducks-live/internal/update"
)

type mode int

const (
	modeRun mode = iota
	modeStartup
	modeStatus
	modeUninstall
	modeCore
	modeHUD
	modeApplyUpdate
)

type options struct {
	mode           mode
	routingMode    app.RoutingMode
	installStartup bool
	applyRequest   string
}

func parseArgs(args []string) (options, error) {
	selected := modeRun
	selectedExplicitly := false
	var routingMode app.RoutingMode
	installStartup := true
	applyRequest := ""
	for index := 0; index < len(args); index++ {
		arg := args[index]
		var value mode
		switch arg {
		case "--startup":
			value = modeStartup
		case "--status":
			value = modeStatus
		case "--uninstall":
			value = modeUninstall
		case "--core":
			value = modeCore
		case "--hud":
			value = modeHUD
		case "--apply-update":
			value = modeApplyUpdate
			if index+1 >= len(args) {
				return options{}, errors.New("--apply-update requires a request path")
			}
			index++
			applyRequest = args[index]
		case "--full-proxy":
			if routingMode != "" {
				return options{}, errors.New("only one routing mode may be selected")
			}
			routingMode = app.RoutingModeFull
			continue
		case "--gateway-only":
			if routingMode != "" {
				return options{}, errors.New("only one routing mode may be selected")
			}
			routingMode = app.RoutingModeGateway
			continue
		case "--no-install":
			installStartup = false
			continue
		default:
			return options{}, fmt.Errorf("unknown argument %q", arg)
		}
		if selectedExplicitly {
			return options{}, errors.New("only one mode may be selected")
		}
		selected = value
		selectedExplicitly = true
	}
	if !installStartup && selected != modeRun {
		return options{}, errors.New("--no-install is only valid when starting Discord")
	}
	return options{mode: selected, routingMode: routingMode, installStartup: installStartup, applyRequest: applyRequest}, nil
}

func main() {
	parsed, err := parseArgs(os.Args[1:])
	if err != nil {
		reportError(err)
		os.Exit(2)
		return
	}
	if err := execute(parsed); err != nil {
		if errors.Is(err, app.ErrAlreadyRunning) {
			return
		}
		reportError(err)
		os.Exit(1)
	}
}

func execute(options options) error {
	if options.mode == modeApplyUpdate {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		return update.ApplyFromRequest(ctx, options.applyRequest, buildinfo.UpdatePublicKey)
	}
	config := app.DefaultConfig()
	configPath := filepath.Join(config.DataDir, app.ConfigFileName)
	loaded, err := app.LoadConfig(configPath)
	if err != nil {
		return err
	}
	config = loaded
	if err := bridge.ProtectDataDirectory(config.DataDir); err != nil {
		return err
	}
	if options.routingMode != "" {
		config.RoutingMode = options.routingMode
	}
	if options.mode == modeRun || options.mode == modeStartup {
		if err := app.SaveConfig(configPath, config); err != nil {
			return err
		}
	}

	helperPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("find helper executable: %w", err)
	}
	helperPath, err = filepath.Abs(helperPath)
	if err != nil {
		return fmt.Errorf("resolve helper executable: %w", err)
	}
	if options.mode == modeCore {
		return runCore(config)
	}
	if options.mode == modeHUD {
		return hud.Run(config.DataDir)
	}
	mutexHeld := false
	if options.mode == modeRun || options.mode == modeStartup || options.mode == modeUninstall {
		release, alreadyRunning, acquireErr := instance.Acquire()
		if acquireErr != nil {
			return fmt.Errorf("acquire helper mutex: %w", acquireErr)
		}
		defer release()
		if alreadyRunning {
			return app.ErrAlreadyRunning
		}
		mutexHeld = true
	}
	manager, err := startup.NewPlatformManager(helperPath)
	if err != nil {
		return err
	}
	defer manager.Close()

	switch options.mode {
	case modeStatus:
		return showStatus(config, manager, helperPath)
	case modeUninstall:
		if discord.IsRunning() {
			return errors.New("feche o Discord completamente antes de desinstalar o BIG DUCKS")
		}
		if err := repairInjectionMetadataIfNeeded(config); err != nil {
			return err
		}
		if err := injection.RestoreAll(config.DataDir); err != nil {
			return fmt.Errorf("restore Discord injection: %w", err)
		}
		if err := manager.Uninstall(); err != nil {
			return err
		}
		writeDiagnostic("inicialização automática do BIG DUCKS removida")
		return nil
	case modeRun:
		if options.installStartup {
			if err := manager.Install(); err != nil {
				return err
			}
		} else {
			writeDiagnostic("BIG DUCKS iniciado sem instalar a inicialização automática")
		}
	}

	if options.mode == modeRun || options.mode == modeStartup {
		return runTray(config, manager, helperPath, mutexHeld, options.mode == modeRun)
	}
	return nil
}

func runCore(config app.Config) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime := app.NewRuntimeControl()
	server := controlapi.NewServer(controlapi.ServerOptions{DataDir: config.DataDir, Runtime: runtime, Shutdown: cancel})
	if err := server.Start(ctx); err != nil {
		return err
	}
	defer server.Close()
	err := app.Run(ctx, app.RunOptions{
		Config: config, MutexHeld: true, Control: runtime, Attach: true, PreserveDiscord: true,
	})
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func repairInjectionMetadataIfNeeded(config app.Config) error {
	seen := make(map[string]struct{})
	resourcesPaths := make([]string, 0, 4)
	addResources := func(resources string) {
		info, err := os.Stat(resources)
		if err != nil || !info.IsDir() {
			return
		}
		clean := filepath.Clean(resources)
		key := strings.ToLower(clean)
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		resourcesPaths = append(resourcesPaths, clean)
	}
	if entries, err := os.ReadDir(config.DiscordRoot); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(strings.ToLower(entry.Name()), "app-") {
				addResources(filepath.Join(config.DiscordRoot, entry.Name(), "resources"))
			}
		}
	}
	if discordPath, err := discord.FindLatest(config.DiscordRoot); err == nil {
		addResources(filepath.Join(filepath.Dir(discordPath), "resources"))
	}
	for _, resources := range resourcesPaths {
		state, err := injection.Inspect(resources, config.DataDir)
		if err != nil {
			return fmt.Errorf("inspect Discord injection before uninstall: %w", err)
		}
		if state.State != injection.StateOurs || !state.RepairRequired {
			continue
		}
		if err := injection.Repair(resources, config.DataDir); err != nil {
			return fmt.Errorf("repair Discord injection metadata before uninstall: %w", err)
		}
	}
	return nil
}

func showStatus(config app.Config, manager *startup.Manager, helperPath string) error {
	result, err := buildStatus(config, manager, helperPath)
	if err != nil {
		return err
	}
	writeDiagnostic(result)
	if logger, loggerErr := logging.New(filepath.Join(config.DataDir, app.LogFileName), 256*1024); loggerErr == nil {
		logger.Printf("status:\n%s", result)
	}
	return nil
}

func buildStatus(config app.Config, manager *startup.Manager, helperPath string) (string, error) {
	startupStatus, err := manager.Status()
	if err != nil {
		return "", err
	}
	discordPath, discordErr := discord.FindLatest(config.DiscordRoot)
	statePath := filepath.Join(config.DataDir, app.StateFileName)
	poolAge := "none"
	if state, readErr := os.ReadFile(statePath); readErr == nil {
		var stored model.State
		if json.Unmarshal(state, &stored) == nil && stored.UpdatedAt > 0 {
			poolAge = time.Since(time.Unix(stored.UpdatedAt, 0)).Round(time.Second).String()
		}
	}
	lastResult := readLastLogLine(filepath.Join(config.DataDir, app.LogFileName))
	lines := []string{
		fmt.Sprintf("installed: %t", startupStatus.Installed),
		fmt.Sprintf("disabled: %t", config.Disabled),
		"routing_mode: " + string(config.RoutingMode),
		"helper: " + helperPath,
	}
	if discordErr != nil {
		lines = append(lines, "discord: unavailable ("+discordErr.Error()+")")
	} else {
		lines = append(lines, "discord: "+discordPath)
		injectionStatus, injectionErr := injection.Inspect(filepath.Join(filepath.Dir(discordPath), "resources"), config.DataDir)
		if injectionErr != nil {
			lines = append(lines, "injection: unavailable ("+injectionErr.Error()+")")
		} else {
			lines = append(lines, "injection: "+string(injectionStatus.State))
		}
	}
	lines = append(lines, "verified_pool_age: "+poolAge, "last_result: "+lastResult)
	return strings.Join(lines, "\n"), nil
}

func readLastLogLine(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "no log yet"
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		separator := strings.IndexByte(line, ' ')
		if separator < 1 {
			continue
		}
		if _, err := time.Parse(time.RFC3339Nano, line[:separator]); err != nil {
			continue
		}
		if strings.HasSuffix(line, " status:") {
			continue
		}
		return line
	}
	return "no result yet"
}

func writeDiagnostic(value any) {
	if text, ok := value.(string); ok {
		fmt.Println(text)
		return
	}
	fmt.Println(value)
}

func reportError(err error) {
	if err == nil {
		return
	}
	config := app.DefaultConfig()
	if logger, loggerErr := logging.New(filepath.Join(config.DataDir, app.LogFileName), 256*1024); loggerErr == nil {
		logger.Printf("error: %v", err)
	}
	writeDiagnostic(err)
}
