package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/bridge"
	"github.com/alikwelyn/bigducks-live/internal/buildinfo"
	"github.com/alikwelyn/bigducks-live/internal/discord"
	"github.com/alikwelyn/bigducks-live/internal/injection"
	"github.com/alikwelyn/bigducks-live/internal/instance"
	"github.com/alikwelyn/bigducks-live/internal/logging"
	"github.com/alikwelyn/bigducks-live/internal/model"
	"github.com/alikwelyn/bigducks-live/internal/pac"
	"github.com/alikwelyn/bigducks-live/internal/proxy"
	"github.com/alikwelyn/bigducks-live/internal/relay"
	"github.com/alikwelyn/bigducks-live/internal/telemetry"
)

var ErrAlreadyRunning = errors.New("BIG DUCKS já está em execução")

func nativeSampleFromBridgeEvent(event bridge.MediaEvent) (NativeMediaSample, bool) {
	if event.Kind != "native_rtc_snapshot" || event.Native == nil {
		return NativeMediaSample{}, false
	}
	snapshot := event.Native
	return NativeMediaSample{
		Hooked:           snapshot.Hooked,
		StreamConnection: snapshot.StreamConnection,
		StatsAvailable:   snapshot.StatsAvailable,
		DemandActive:     snapshot.DemandActive,
		HasAudioSSRC:     snapshot.HasAudioSSRC,
		HasVideoSSRC:     snapshot.HasVideoSSRC,
		AudioPackets:     snapshot.AudioPackets,
		VideoPackets:     snapshot.VideoPackets,
		AudioBytes:       snapshot.AudioBytes,
		VideoBytes:       snapshot.VideoBytes,
		AudioFrames:      snapshot.AudioFrames,
		VideoFrames:      snapshot.VideoFrames,
		CaptureFrames:    snapshot.CaptureFrames,
		EncodedFrames:    snapshot.EncodedFrames,
		FramesDecoded:    snapshot.FramesDecoded,
		FramesDropped:    snapshot.FramesDropped,
		ReceiverCount:    snapshot.ReceiverCount,
		InputFPS:         snapshot.InputFPS,
		EncodedFPS:       snapshot.EncodedFPS,
	}, true
}

func telemetryEventForMedia(status MediaStatus, mode RoutingMode) (telemetry.Event, bool) {
	state := status.State
	code := telemetry.Code("")
	switch status.Native.State {
	case MediaNativeProbeUnavailable:
		code = telemetry.CodeNativeProbeUnavailable
	case MediaNativeTransmitterStalled:
		code = telemetry.CodeNativeTransmitterStalled
	case MediaNativeReceiverAudioOnly:
		code = telemetry.CodeNativeReceiverAudioOnly
	case MediaNativeReceiverNoPackets:
		code = telemetry.CodeNativeReceiverNoPackets
	case MediaNativeDecoderStalled:
		code = telemetry.CodeNativeDecoderStalled
	case MediaNativeRenderUnknown:
		code = telemetry.CodeNativeRenderUnknown
	case MediaNativeRTCDisconnected:
		code = telemetry.CodeRTCDisconnected
	}
	if code == "" {
		switch status.State {
		case MediaAudioOnly:
			code = telemetry.CodeAudioOnly
		case MediaVideoStalled:
			code = telemetry.CodeVideoStalled
		case MediaReceiverTimeout:
			code = telemetry.CodeReceiverTimeout
		case MediaRTCDisconnected:
			code = telemetry.CodeRTCDisconnected
		}
	}
	if code == "" {
		return telemetry.Event{}, false
	}
	return telemetry.Event{
		Component:      telemetry.ComponentMedia,
		Code:           code,
		State:          string(state),
		Mode:           string(mode),
		StatsAvailable: status.Native.StatsAvailable,
		HasAudioSSRC:   status.Native.HasAudioSSRC,
		HasVideoSSRC:   status.Native.HasVideoSSRC,
		AudioPackets:   status.Native.AudioPackets,
		VideoPackets:   status.Native.VideoPackets,
		AudioBytes:     status.Native.AudioBytes,
		VideoBytes:     status.Native.VideoBytes,
		FramesDecoded:  status.Native.FramesDecoded,
		ReceiverCount:  status.Native.ReceiverCount,
	}, true
}

type RunOptions struct {
	Config          Config
	DryRun          bool
	SkipProxyFetch  bool
	Logger          *logging.Logger
	MutexHeld       bool
	Control         *RuntimeControl
	Attach          bool
	PreserveDiscord bool
}

func Run(ctx context.Context, options RunOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	config := options.Config.normalized()
	if err := bridge.ProtectDataDirectory(config.DataDir); err != nil {
		return fmt.Errorf("protect data directory: %w", err)
	}
	logger := options.Logger
	if logger == nil {
		var err error
		logger, err = logging.New(filepath.Join(config.DataDir, LogFileName), 256*1024)
		if err != nil {
			return err
		}
	}

	if !options.MutexHeld {
		release, alreadyRunning, acquireErr := instance.Acquire()
		if acquireErr != nil {
			return fmt.Errorf("acquire helper mutex: %w", acquireErr)
		}
		defer release()
		if alreadyRunning {
			logger.Printf("another BIG DUCKS instance is already running")
			return ErrAlreadyRunning
		}
	}

	logger.Printf("starting BIG DUCKS LIVE")
	logger.Printf("routing mode: %s", config.RoutingMode)
	control := options.Control
	if control == nil {
		control = NewRuntimeControl()
	}
	statusStore := newRuntimeStatusStore()
	telemetryReporter := telemetry.NewReporter(telemetry.Options{
		Release:  buildinfo.Version,
		CacheDir: filepath.Join(config.DataDir, "telemetry", "core"),
		Mode:     string(config.RoutingMode),
	})
	defer telemetryReporter.Close()
	if config.TelemetryEnabled {
		if err := telemetryReporter.Enable(); err != nil {
			logger.Printf("could not enable telemetry: %v", err)
			statusStore.Update(func(status *RuntimeStatus) {
				status.Telemetry = TelemetryStatus{Enabled: false, LastResult: "enable_failed"}
			})
		} else {
			statusStore.Update(func(status *RuntimeStatus) {
				status.Telemetry = TelemetryStatus{Enabled: true, LastResult: "enabled"}
			})
		}
	}
	control.SetStatus(statusStore.Snapshot())
	var telemetryConfigMu sync.Mutex
	configPath := filepath.Join(config.DataDir, ConfigFileName)
	setTelemetryPreference := func(enabled bool) error {
		telemetryConfigMu.Lock()
		defer telemetryConfigMu.Unlock()
		updated := config
		updated.TelemetryEnabled = enabled
		if err := SaveConfig(configPath, updated); err != nil {
			return err
		}
		config.TelemetryEnabled = enabled
		return nil
	}
	captureCoreFailure := func(code telemetry.Code) {
		telemetryReporter.Capture(telemetry.Event{Component: telemetry.ComponentCore, Code: code, Mode: string(config.RoutingMode)})
	}
	if config.Disabled {
		statusStore.Update(func(status *RuntimeStatus) {
			status.State = RecoveryDisabled
			status.LastMessage = "A proteção está desativada nas configurações"
		})
		control.SetStatus(statusStore.Snapshot())
		unbind := control.Bind(RuntimeBindings{
			EnableTelemetry: func(context.Context) error {
				if err := telemetryReporter.Enable(); err != nil {
					return err
				}
				if err := setTelemetryPreference(true); err != nil {
					_ = telemetryReporter.Disable()
					return err
				}
				statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{Enabled: true, LastResult: "enabled"} })
				return nil
			},
			DisableTelemetry: func(context.Context) error {
				if err := telemetryReporter.Disable(); err != nil {
					return err
				}
				if err := setTelemetryPreference(false); err != nil {
					statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{LastResult: "save_failed"} })
					return err
				}
				statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{LastResult: "disabled"} })
				return nil
			},
			TestTelemetry: func(actionCtx context.Context) error { return telemetryReporter.Test(actionCtx) },
			PurgeTelemetry: func(context.Context) error {
				if err := telemetryReporter.Purge(); err != nil {
					return err
				}
				statusStore.Update(func(status *RuntimeStatus) { status.Telemetry.LastResult = "purged" })
				return nil
			},
			Status: statusStore.Snapshot,
		})
		defer unbind()
		logger.Printf("protection is disabled by configuration")
		return waitForDisabled(runCtx)
	}
	tracker := relay.NewTracker()
	defer tracker.CloseAll()
	var stateSaveMu sync.Mutex

	setupCtx, cancelSetup := context.WithTimeout(runCtx, config.StartupBudget)
	var entries []model.VerifiedEndpoint
	if !options.SkipProxyFetch {
		entries = loadAndVerifyCached(setupCtx, config, logger)
		if len(entries) == 0 {
			entries = fetchAndVerify(setupCtx, config, logger)
		}
		if len(entries) > config.PoolSize {
			entries = entries[:config.PoolSize]
		}
	} else {
		logger.Printf("proxy fetch skipped; gateway will wait for a verified proxy")
	}
	cancelSetup()

	var refresh proxy.RefreshFunc
	if !options.SkipProxyFetch {
		refresh = func(refreshCtx context.Context) ([]model.VerifiedEndpoint, error) {
			refreshed := fetchAndVerify(refreshCtx, config, logger)
			if len(refreshed) == 0 {
				return nil, proxy.ErrNoProxy
			}
			return refreshed, nil
		}
	}
	managed := proxy.NewManagedPool(proxy.ManagedOptions{
		Entries:        entries,
		AttemptTimeout: config.ProbeTimeout / 2,
		Refresh:        refresh,
		Probe: func(probeCtx context.Context, endpoint model.Endpoint) (model.VerifiedEndpoint, error) {
			started := time.Now()
			if config.RoutingMode == RoutingModeFull {
				verified, err := proxy.ProbeFullEndpoint(probeCtx, endpoint, config.HeartbeatTimeout)
				if err != nil {
					return model.VerifiedEndpoint{}, err
				}
				verified.CheckedAt = time.Now().Unix()
				return verified, nil
			}
			verified, err := proxy.ProbeGatewayRegion(probeCtx, endpoint, config.HeartbeatTimeout)
			if err != nil {
				return model.VerifiedEndpoint{}, err
			}
			verified.LatencyMS = int(time.Since(started).Milliseconds())
			return verified, nil
		},
		WaitBudget:       config.RecoveryWait,
		HeartbeatTimeout: config.HeartbeatTimeout,
		PoolSize:         config.PoolSize,
		MinReserves:      config.MinReserves,
		HuntCooldown:     config.HuntCooldown,
		InUse:            tracker.InUse,
		OnDead: func(endpoint model.Endpoint) {
			captureCoreFailure(telemetry.CodeRecoveryFailure)
			closed := tracker.CloseEndpoint(endpoint)
			if closed > 0 {
				statusStore.Update(func(status *RuntimeStatus) {
					status.State = RecoveryReconnecting
					status.LastError = "proxy heartbeat failed"
				})
			}
			logger.Printf("proxy %s failed health check; closed %d gateway tunnel(s)", endpoint.RedactedURL(), closed)
		},
		OnChange: func(updated []model.VerifiedEndpoint) {
			stateSaveMu.Lock()
			if err := proxy.SaveState(filepath.Join(config.DataDir, StateFileName), updated, time.Now()); err != nil {
				logger.Printf("could not save refreshed proxy state: %v", err)
			}
			stateSaveMu.Unlock()
			statusStore.Update(func(status *RuntimeStatus) { status.PoolSize = len(updated) })
			logger.Printf("verified proxy pool refreshed with %d candidate(s)", len(updated))
		},
	})
	if len(entries) > 0 {
		stateSaveMu.Lock()
		if err := proxy.SaveState(filepath.Join(config.DataDir, StateFileName), entries, time.Now()); err != nil {
			logger.Printf("could not save proxy state: %v", err)
		}
		stateSaveMu.Unlock()
		logger.Printf("verified %d public gateway proxy candidates", len(entries))
	} else {
		logger.Printf("no verified public proxy available; direct gateway fallback is disabled")
		statusStore.Update(func(status *RuntimeStatus) { status.State = RecoveryNoProxy })
	}
	statusStore.Update(func(status *RuntimeStatus) { status.PoolSize = len(entries) })
	go managed.Start(runCtx, config.HeartbeatInterval)

	allowlist := model.NewHostAllowlist(config.RoutedHosts)
	allowedSuffixes := append([]string(nil), config.RoutedSuffixes...)
	if config.RoutingMode == RoutingModeFull {
		allowedSuffixes = []string{"discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discordcdn.com"}
	}
	relayTimeout := config.ProbeTimeout * 2
	connector := gatewayConnector{
		pool: managed, tracker: tracker, status: statusStore, logger: logger,
		allowDirectFallback: config.AllowDirectFallback,
		directDial: func(dialCtx context.Context, host string, port int) (net.Conn, error) {
			return (&net.Dialer{Timeout: config.HeartbeatTimeout}).DialContext(dialCtx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		},
	}
	relayServer := &relay.Server{
		Address:         runtimeAddress(config.RelayPort, config.DynamicRuntimePorts),
		Allowlist:       allowlist,
		AllowedSuffixes: allowedSuffixes,
		AllowedPorts:    map[int]bool{443: true},
		Timeout:         relayTimeout,
		Dial:            connector.Dial,
	}
	relayAddress, closeRelay, err := relayServer.ListenAndServe(runCtx)
	if err != nil {
		captureCoreFailure(telemetry.CodeStartupFailure)
		logger.Printf("could not start local relay: %v", err)
		return fmt.Errorf("start protected gateway relay: %w", err)
	}
	defer closeRelay()
	_, relayPortText, err := net.SplitHostPort(relayAddress)
	if err != nil {
		return fmt.Errorf("parse protected gateway relay address: %w", err)
	}
	relayPort, err := strconv.Atoi(relayPortText)
	if err != nil {
		return fmt.Errorf("parse protected gateway relay port: %w", err)
	}
	pacServer := pac.NewServerAt(runtimeAddress(config.PACPort, config.DynamicRuntimePorts), config.RoutedHosts, config.RoutedSuffixes, relayPort)
	pacURL, closePAC, err := pacServer.Start()
	if err != nil {
		captureCoreFailure(telemetry.CodeStartupFailure)
		logger.Printf("could not start local PAC: %v", err)
		return fmt.Errorf("start protected gateway PAC: %w", err)
	}
	defer closePAC()

	bridgeServer := bridge.NewServer(config.DataDir)
	bridgeServer.SetMediaEventHandler(func(event bridge.MediaEvent) {
		if sample, ok := nativeSampleFromBridgeEvent(event); ok {
			statusStore.Update(func(status *RuntimeStatus) {
				status.Media = ReduceNativeMedia(status.Media, sample)
			})
			media := statusStore.Snapshot().Media
			if telemetryEvent, ok := telemetryEventForMedia(media, config.RoutingMode); ok {
				telemetryReporter.Capture(telemetryEvent)
			}
			native := media.Native
			logger.Printf("native media diagnostic: state=%s demand=%t stats=%t audio_packets=%d video_packets=%d decoded=%d receiver_count=%d", native.State, native.DemandActive, native.StatsAvailable, native.AudioPackets, native.VideoPackets, native.FramesDecoded, native.ReceiverCount)
			return
		}
		statusStore.Update(func(status *RuntimeStatus) {
			status.Media = ReduceMedia(status.Media, MediaEvent{Session: event.Session, Kind: event.Kind, At: event.At})
		})
		media := statusStore.Snapshot().Media
		media.Native.State = MediaUnknown
		if telemetryEvent, ok := telemetryEventForMedia(media, config.RoutingMode); ok {
			telemetryReporter.Capture(telemetryEvent)
		}
	})
	bridgeReady := true
	if err := bridgeServer.Start(runCtx); err != nil {
		captureCoreFailure(telemetry.CodeBridgeFailure)
		bridgeReady = false
		logger.Printf("could not start Discord reload bridge: %v", err)
	} else {
		defer bridgeServer.Close()
		bridgeServer.SetTelemetryEnabled(telemetryReporter.Enabled())
	}
	fullProxyURL := ""
	if config.RoutingMode == RoutingModeFull {
		fullProxyURL = "socks5://" + relayAddress
		logger.Printf("full control mode uses the managed local relay; Discord media domains remain direct")
	}
	launchProtectedDiscord := func(startCtx context.Context, force bool) error {
		if !force && !config.AutoStartDiscord {
			return ErrDiscordClosed
		}
		if err := startCtx.Err(); err != nil {
			return err
		}
		discordPath, findErr := discord.FindLatest(config.DiscordRoot)
		if findErr != nil {
			return findErr
		}
		statusStore.Update(func(status *RuntimeStatus) {
			status.State = RecoveryDiscordStarting
			status.LastError = ""
			status.LastMessage = "Abrindo o Discord pela rota protegida"
		})
		if bridgeReady {
			resources := filepath.Join(filepath.Dir(discordPath), "resources")
			injectionResult, injectionErr := ensureInjectionWithRetry(4, func() (injection.Result, error) {
				return injection.Ensure(resources, config.DataDir, bridge.Script())
			})
			if injectionErr != nil {
				logger.Printf("could not install Discord reload bridge before recovery launch: %v", injectionErr)
			} else {
				logger.Printf("Discord injection state: %s%s", injectionResult.State, reasonSuffix(injectionResult.Reason))
			}
		}
		var command *exec.Cmd
		var launchErr error
		if fullProxyURL != "" {
			command, launchErr = discord.LaunchFull(discordPath, fullProxyURL)
		} else {
			command, launchErr = discord.Launch(discordPath, pacURL)
		}
		if launchErr != nil {
			return launchErr
		}
		logger.Printf("Discord started with protected routing during recovery")
		go func() {
			if waitErr := discord.WaitForProcessTreePreserving(context.Background(), command); waitErr != nil {
				logger.Printf("Discord recovery launch exited: %v", waitErr)
			}
		}()
		return nil
	}
	startDiscord := func(startCtx context.Context) error {
		return launchProtectedDiscord(startCtx, false)
	}
	var repairMu sync.Mutex
	repairDiscord := func(repairCtx context.Context) error {
		repairMu.Lock()
		defer repairMu.Unlock()
		err := repairDiscordPolicy(config.AutoStartDiscord, config.Disabled, func() error {
			statusStore.Update(func(status *RuntimeStatus) {
				status.State = RecoveryDiscordStarting
				status.LastError = ""
				status.LastMessage = "Fechando a sessão atual do Discord"
			})
			identity, identityErr := discord.CurrentProcess()
			if identityErr != nil {
				return fmt.Errorf("inspect Discord process: %w", identityErr)
			}
			if identity.PID > 0 {
				logger.Printf("closing Discord process tree for explicit repair (pid %d)", identity.PID)
				discord.KillProcessTree(int(identity.PID))
			}
			waitForDiscordShutdown(repairCtx, logger)
			if discord.IsRunning() {
				return errors.New("Discord did not close before the protected repair deadline")
			}
			if err := launchProtectedDiscord(repairCtx, true); err != nil {
				return fmt.Errorf("launch protected Discord during repair: %w", err)
			}
			logger.Printf("explicit Discord repair completed")
			return nil
		})
		if err != nil {
			statusStore.Update(func(status *RuntimeStatus) {
				status.State = RecoveryFailed
				status.LastError = err.Error()
				status.LastMessage = "Não foi possível corrigir a sessão do Discord"
			})
		}
		return err
	}
	telemetryEnable := func(actionCtx context.Context) error {
		if err := telemetryReporter.Enable(); err != nil {
			statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{LastResult: "enable_failed"} })
			return err
		}
		if err := setTelemetryPreference(true); err != nil {
			_ = telemetryReporter.Disable()
			statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{LastResult: "save_failed"} })
			return err
		}
		if bridgeReady {
			bridgeServer.SetTelemetryEnabled(true)
		}
		statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{Enabled: true, LastResult: "enabled"} })
		return nil
	}
	telemetryDisable := func(actionCtx context.Context) error {
		if err := telemetryReporter.Disable(); err != nil {
			return err
		}
		if err := setTelemetryPreference(false); err != nil {
			statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{LastResult: "save_failed"} })
			return err
		}
		if bridgeReady {
			if err := bridgeServer.DisableTelemetry(actionCtx); err != nil && !errors.Is(err, bridge.ErrUnavailable) {
				return err
			}
		}
		statusStore.Update(func(status *RuntimeStatus) { status.Telemetry = TelemetryStatus{LastResult: "disabled"} })
		return nil
	}
	telemetryTest := func(actionCtx context.Context) error {
		if err := telemetryReporter.Test(actionCtx); err != nil {
			statusStore.Update(func(status *RuntimeStatus) { status.Telemetry.LastResult = "core_test_failed" })
			return err
		}
		if !bridgeReady {
			return bridge.ErrUnavailable
		}
		if err := bridgeServer.TestTelemetry(actionCtx); err != nil {
			statusStore.Update(func(status *RuntimeStatus) { status.Telemetry.LastResult = "bridge_test_failed" })
			return err
		}
		statusStore.Update(func(status *RuntimeStatus) { status.Telemetry.LastResult = "test_sent" })
		return nil
	}
	telemetryPurge := func(actionCtx context.Context) error {
		if err := telemetryReporter.Purge(); err != nil {
			return err
		}
		if bridgeReady {
			if err := bridgeServer.PurgeTelemetry(actionCtx); err != nil && !errors.Is(err, bridge.ErrUnavailable) {
				return err
			}
		}
		statusStore.Update(func(status *RuntimeStatus) { status.Telemetry.LastResult = "purged" })
		return nil
	}
	recovery := NewRecoveryCoordinator(RecoveryCoordinatorOptions{
		Pool: managed, Tunnels: tracker, Bridge: bridgeServer, Status: statusStore, Logger: logger,
		DiscordAlive: discord.IsRunning, StartDiscord: startDiscord,
		Aggressive: config.AggressiveRecovery,
		SecondStage: func(actionCtx context.Context) error {
			if !bridgeReady {
				return bridge.ErrUnavailable
			}
			return bridgeServer.Reload(actionCtx)
		},
	})
	unbind := control.Bind(RuntimeBindings{
		EnableTelemetry:  telemetryEnable,
		DisableTelemetry: telemetryDisable,
		TestTelemetry:    telemetryTest,
		PurgeTelemetry:   telemetryPurge,
		Reconnect: func(actionCtx context.Context) error {
			_, err := recovery.Recover(actionCtx)
			if err != nil {
				captureCoreFailure(telemetry.CodeRecoveryFailure)
			}
			return err
		},
		RepairDiscord: func(actionCtx context.Context) error {
			err := repairDiscord(actionCtx)
			if err != nil {
				captureCoreFailure(telemetry.CodeRecoveryFailure)
			}
			return err
		},
		Reload: func(actionCtx context.Context) error {
			if !bridgeReady {
				return bridge.ErrUnavailable
			}
			return bridgeServer.Reload(actionCtx)
		},
		TestRoute: func(actionCtx context.Context) error {
			if !bridgeReady {
				return bridge.ErrUnavailable
			}
			for _, target := range []string{"https://gateway.discord.gg", "https://gateway-us-east1-b.discord.gg"} {
				route, routeErr := bridgeServer.ResolveProxy(actionCtx, target)
				if routeErr != nil {
					return routeErr
				}
				if !protectedProxyRoute(route, relayAddress) {
					return fmt.Errorf("Discord resolved %s as %q instead of %q", target, route, "SOCKS5 "+relayAddress)
				}
			}
			return nil
		},
		Status: func() RuntimeStatus {
			status := statusStore.Snapshot()
			entries := managed.Snapshot()
			status.PoolSize = len(entries)
			if len(entries) > 0 {
				status.ActiveProxy = entries[0].Endpoint.RedactedURL()
				status.LatencyMS = entries[0].LatencyMS
			}
			status.TunnelCount = tracker.Count()
			status.BridgeConnected = bridgeReady && bridgeServer.Status().Connected
			return status
		},
	})
	defer unbind()

	if config.AutoStartDiscord && discord.IsRunning() && bridgeReady {
		ensureProtectedExistingDiscord(runCtx, config, relayAddress, bridgeServer, logger)
	}

	err = launchDiscord(runCtx, config, pacURL, fullProxyURL, options.DryRun, options.Attach, options.PreserveDiscord, bridgeReady, statusStore, logger)
	if err != nil {
		captureCoreFailure(telemetry.CodeStartupFailure)
	}
	return err
}

func runtimeAddress(port int, dynamic bool) string {
	if dynamic {
		return "127.0.0.1:0"
	}
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

func launchDiscord(ctx context.Context, config Config, pacURL, fullProxyURL string, dryRun, attach, preserveDiscord, bridgeReady bool, statusStore *runtimeStatusStore, logger *logging.Logger) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	discordPath, err := discord.FindLatest(config.DiscordRoot)
	if err != nil {
		return err
	}
	logger.Printf("selected Discord executable: %s", discordPath)
	if dryRun {
		logger.Printf("dry run completed without launching Discord")
		return nil
	}
	running := discord.IsRunning()
	if running && !attach {
		logger.Printf("Discord is already running; monitoring the existing session without claiming protected routing")
		statusStore.Update(func(status *RuntimeStatus) {
			status.State = RecoveryDiscordRunning
			status.LastMessage = "Discord já estava aberto; a proteção aguarda uma sessão iniciada pelo BIG DUCKS"
		})
		return waitForDiscordExit(ctx, statusStore, logger)
	}
	if !running && !config.AutoStartDiscord {
		statusStore.Update(func(status *RuntimeStatus) {
			status.State = RecoveryDiscordClosed
			status.LastMessage = "Aguardando o Discord ser aberto"
		})
		logger.Printf("Discord is closed; automatic launch is disabled")
		return waitForDiscord(ctx, statusStore, logger)
	}
	if bridgeReady && !running {
		resources := filepath.Join(filepath.Dir(discordPath), "resources")
		injectionResult, injectionErr := ensureInjectionWithRetry(4, func() (injection.Result, error) {
			return injection.Ensure(resources, config.DataDir, bridge.Script())
		})
		if injectionErr != nil {
			logger.Printf("could not install Discord reload bridge: %v; continuing with external recovery", injectionErr)
			statusStore.Update(func(status *RuntimeStatus) {
				status.InjectionState = string(injection.StateUnavailable)
				status.RepairRequired = true
				status.LastError = injectionErr.Error()
			})
		} else {
			logger.Printf("Discord injection state: %s%s", injectionResult.State, reasonSuffix(injectionResult.Reason))
			statusStore.Update(func(status *RuntimeStatus) {
				status.InjectionState = string(injectionResult.State)
				status.RepairRequired = injectionResult.RepairRequired || injectionResult.State == injection.StateUnavailable
				if status.RepairRequired {
					status.State = RecoveryRepairRequired
				}
			})
		}
	}
	if running {
		logger.Printf("attached protection core to the running Discord session")
		return waitForDiscordExit(ctx, statusStore, logger)
	}

	var command *exec.Cmd
	if config.RoutingMode == RoutingModeFull && fullProxyURL != "" {
		command, err = discord.LaunchFull(discordPath, fullProxyURL)
	} else if pacURL == "" {
		return errors.New("protected gateway PAC is unavailable; refusing direct Discord launch")
	} else {
		command, err = discord.Launch(discordPath, pacURL)
	}
	if err != nil {
		return err
	}
	if config.RoutingMode == RoutingModeFull && fullProxyURL != "" {
		logger.Printf("Discord started with full control proxy; media domains bypass directly")
	} else if pacURL != "" {
		logger.Printf("Discord started with gateway-only PAC routing")
	}
	wait := discord.WaitForProcessTree
	if preserveDiscord {
		wait = discord.WaitForProcessTreePreserving
	}
	if err := wait(ctx, command); err != nil {
		return fmt.Errorf("Discord exited with an error: %w", err)
	}
	logger.Printf("Discord exited")
	return nil
}

func waitForDiscord(ctx context.Context, statusStore *runtimeStatusStore, logger *logging.Logger) error {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if discord.IsRunning() {
			statusStore.Update(func(status *RuntimeStatus) {
				status.State = RecoveryDiscordRunning
				status.LastMessage = "Discord aberto; a proteção aguarda uma sessão iniciada pelo BIG DUCKS"
			})
		} else {
			statusStore.Update(func(status *RuntimeStatus) {
				status.State = RecoveryDiscordClosed
				status.LastMessage = "Aguardando o Discord ser aberto"
			})
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func waitForDisabled(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

func waitForDiscordExit(ctx context.Context, statusStore *runtimeStatusStore, logger *logging.Logger) error {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if !discord.IsRunning() {
			statusStore.Update(func(status *RuntimeStatus) {
				status.State = RecoveryDiscordClosed
				status.LastMessage = "O Discord foi fechado"
			})
			if logger != nil {
				logger.Printf("Discord exited; protection is now idle")
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func shouldRestartUnprotectedDiscord(running, autoStart, attach, protected bool) bool {
	return running && autoStart && attach && !protected
}

func protectedProxyRoute(route, relayAddress string) bool {
	return relayAddress != "" && strings.Contains(strings.ToUpper(route), strings.ToUpper("SOCKS5 "+relayAddress))
}

func ensureProtectedExistingDiscord(ctx context.Context, config Config, relayAddress string, bridgeServer *bridge.Server, logger *logging.Logger) {
	if !shouldRestartUnprotectedDiscord(discord.IsRunning(), config.AutoStartDiscord, true, false) || bridgeServer == nil {
		return
	}
	checkCtx, cancelCheck := context.WithTimeout(ctx, 10*time.Second)
	defer cancelCheck()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if bridgeServer.Status().Connected {
			probeCtx, cancelProbe := context.WithTimeout(checkCtx, time.Second)
			route, err := bridgeServer.ResolveProxy(probeCtx, "https://gateway.discord.gg")
			cancelProbe()
			if err == nil {
				if protectedProxyRoute(route, relayAddress) {
					logger.Printf("existing Discord session already uses the protected route")
					return
				}
				logger.Printf("existing Discord session is not using the protected route (%q); restarting it with BIG DUCKS routing", route)
				if identity, identityErr := discord.CurrentProcess(); identityErr == nil && identity.PID > 0 {
					discord.KillProcessTree(int(identity.PID))
				}
				waitForDiscordShutdown(checkCtx, logger)
				return
			}
		}
		select {
		case <-checkCtx.Done():
			logger.Printf("could not verify the existing Discord route before relaunch: %v; forcing a protected relaunch", checkCtx.Err())
			if identity, identityErr := discord.CurrentProcess(); identityErr == nil && identity.PID > 0 {
				discord.KillProcessTree(int(identity.PID))
			}
			waitForDiscordShutdown(ctx, logger)
			return
		case <-ticker.C:
		}
	}
}

func waitForDiscordShutdown(ctx context.Context, logger *logging.Logger) {
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for discord.IsRunning() {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			logger.Printf("Discord did not exit before protected relaunch deadline")
			return
		case <-ticker.C:
		}
	}
}

func reasonSuffix(reason string) string {
	if reason == "" {
		return ""
	}
	return " (" + reason + ")"
}

func loadAndVerifyCached(ctx context.Context, config Config, logger *logging.Logger) []model.VerifiedEndpoint {
	entries, err := proxy.LoadState(filepath.Join(config.DataDir, StateFileName), time.Now(), config.CacheTTL)
	if err != nil {
		logger.Printf("could not load proxy state: %v", err)
		return nil
	}
	if len(entries) == 0 {
		return nil
	}
	candidates := make([]model.Endpoint, 0, len(entries))
	for _, entry := range entries {
		candidates = append(candidates, entry.Endpoint)
	}
	probe := proxy.ProbeEndpoint
	if config.RoutingMode == RoutingModeFull {
		probe = proxy.ProbeFullEndpoint
	}
	verified := proxy.SelectVerified(ctx, candidates, config.MaxCandidates, config.ProbeWorkers, func(probeCtx context.Context, endpoint model.Endpoint) (model.VerifiedEndpoint, error) {
		return probe(probeCtx, endpoint, config.ProbeTimeout)
	})
	if len(verified) == 0 {
		logger.Printf("cached proxy pool did not pass re-probing")
	}
	return verified
}

func fetchAndVerify(ctx context.Context, config Config, logger *logging.Logger) []model.VerifiedEndpoint {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, config.ProxySourceURL, nil)
	if err != nil {
		logger.Printf("could not create proxy list request: %v", err)
		return nil
	}
	client := &http.Client{Timeout: config.ProbeTimeout}
	response, err := client.Do(request)
	if err != nil {
		logger.Printf("could not fetch public proxy list: %v", err)
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		logger.Printf("public proxy list returned HTTP %d", response.StatusCode)
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		logger.Printf("could not read public proxy list: %v", err)
		return nil
	}
	candidates, err := proxy.ParseProxyScrape(body, config.ExcludedCountries, config.MaxCandidates)
	if err != nil {
		logger.Printf("could not parse public proxy list: %v", err)
		return nil
	}
	probe := proxy.ProbeEndpoint
	if config.RoutingMode == RoutingModeFull {
		probe = proxy.ProbeFullEndpoint
	}
	verified := proxy.SelectVerified(ctx, candidates, config.MaxCandidates, config.ProbeWorkers, func(probeCtx context.Context, endpoint model.Endpoint) (model.VerifiedEndpoint, error) {
		return probe(probeCtx, endpoint, config.ProbeTimeout)
	})
	return verified
}
