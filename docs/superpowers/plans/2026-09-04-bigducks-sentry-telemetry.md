# Telemetria opcional Sentry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar telemetria Sentry opt-in no núcleo Go e na bridge principal do Electron, com eventos tipados, sanitização final, controle autenticado e purga somente dos dados locais do BIG DUCKS.

**Architecture:** O pacote `internal/telemetry` será o único ponto que cria o cliente `sentry-go`; ele recebe eventos tipados, aplica uma lista fechada de códigos, limita duplicatas e não existe quando a opção está desligada. A bridge usa `@sentry/electron/main` empacotado no asset JavaScript, inicializa somente após o comando autenticado do núcleo e captura apenas falhas/eventos próprios da bridge. O núcleo é a autoridade da configuração e sincroniza o estado ao conectar.

**Tech Stack:** Go 1.26, `github.com/getsentry/sentry-go v0.49.0`, `@sentry/electron 7.18.0`, esbuild `0.28.2`, JavaScript CommonJS para Electron, HTTP API local autenticada e WebView2 HUD.

---

## Mapa de arquivos

- Criar `internal/telemetry/event.go`: tipos fechados, códigos permitidos e payload seguro.
- Criar `internal/telemetry/sanitize.go`: validação e sanitização final para Sentry.
- Criar `internal/telemetry/sanitize_test.go`: testes de PII e eventos inválidos.
- Criar `internal/telemetry/reporter.go`: lifecycle, deduplicação, flush, disable e purge.
- Criar `internal/telemetry/reporter_test.go`: fake transport e testes de opt-in/falhas.
- Criar `internal/telemetry/sentry_transport.go`: adapter de produção para `sentry-go` e fila própria em `%LOCALAPPDATA%\\DiscordStream\\telemetry\\core`.
- Modificar `go.mod` e `go.sum`: fixar `sentry-go v0.49.0`.
- Modificar `internal/app/config.go`: persistir `telemetryEnabled` com default `false`.
- Modificar `internal/app/config_test.go`: default, ausência em config antiga e round-trip.
- Modificar `internal/app/control.go`: estado e bindings de telemetria.
- Modificar `internal/app/control_test.go`: dispatch dos cinco controles.
- Modificar `internal/app/run.go`: inicializar reporter, sincronizar bridge, persistir enable/disable e reportar falhas permitidas.
- Modificar `internal/app/media.go`: entregar transições agregadas ao reporter sem `Session`/SSRC.
- Modificar `internal/controlapi/server.go`: endpoints autenticados de telemetria.
- Modificar `internal/controlapi/client.go`: métodos do HUD.
- Modificar `internal/controlapi/server_test.go`: autenticação, métodos HTTP e respostas.
- Criar `internal/bridge/assets-src/discord_bridge.js`: fonte não minificada da bridge, migrada do asset atual.
- Criar `scripts/bridge/package.json`, `scripts/bridge/package-lock.json`: dependências fixadas.
- Criar `scripts/bridge/build.mjs`: bundle reproduzível para `internal/bridge/assets/discord_bridge.js`.
- Criar `scripts/bridge/check.mjs`: verifica que o asset commitado é reproduzível.
- Modificar `internal/bridge/assets/discord_bridge.js`: regenerado pelo bundle com Sentry e protocolo de telemetria.
- Modificar `internal/bridge/server.go`: sincronização e comandos de telemetria.
- Criar `internal/bridge/telemetry_protocol_test.go`: testes dos comandos e sincronização.
- Modificar `internal/bridge/server_test.go`: exigir que o asset contenha o protocolo Sentry sem handlers de renderer.
- Modificar `internal/hud/hud_windows.go`: estado e bindings de telemetria.
- Modificar `internal/hud/assets/index.html`: seção “Diagnóstico opcional”.
- Modificar `internal/hud/assets/app.js`: renderização e confirmação das ações.
- Modificar `internal/hud/hud_windows_test.go`: transporte do estado e bindings.
- Modificar `build.ps1`, `.github/workflows/ci.yml` e `.github/workflows/release.yml`: gerar/verificar o bundle antes de testar/buildar.
- Modificar `README.md` e criar `docs/telemetry.md`: opt-in, limites de privacidade e remoção de eventos enviados.

---

### Task 1: Persistir o opt-in de forma segura

**Files:**
- Modify: `internal/app/config.go`
- Modify: `internal/app/config_test.go`

- [ ] **Step 1: Write the failing tests**

```go
func TestDefaultConfigDisablesTelemetry(t *testing.T) {
    if app.DefaultConfig().TelemetryEnabled { t.Fatal("telemetry must be disabled by default") }
}

func TestLoadConfigWithoutTelemetryFieldKeepsItDisabled(t *testing.T) {
    path := filepath.Join(t.TempDir(), "config.json")
    if err := os.WriteFile(path, []byte(`{"routingMode":"gateway"}`), 0o600); err != nil { t.Fatal(err) }
    config, err := app.LoadConfig(path)
    if err != nil { t.Fatal(err) }
    if config.TelemetryEnabled { t.Fatal("legacy config enabled telemetry") }
}

func TestTelemetryConfigRoundTrip(t *testing.T) {
    path := filepath.Join(t.TempDir(), "config.json")
    config := app.DefaultConfig(); config.TelemetryEnabled = true
    if err := app.SaveConfig(path, config); err != nil { t.Fatal(err) }
    loaded, err := app.LoadConfig(path)
    if err != nil { t.Fatal(err) }
    if !loaded.TelemetryEnabled { t.Fatal("telemetry opt-in was not persisted") }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/app -run 'Test(DefaultConfigDisablesTelemetry|LoadConfigWithoutTelemetryFieldKeepsItDisabled|TelemetryConfigRoundTrip)' -count=1`  
Expected: FAIL because `TelemetryEnabled` is not part of `Config`.

- [ ] **Step 3: Add the persisted field**

Add `TelemetryEnabled bool` to `Config` and this field to `persistedConfig`:

```go
TelemetryEnabled bool `json:"telemetryEnabled"`
```

Read it directly from JSON; absence remains `false`. Use the non-omitempty `telemetryEnabled` struct field shown above so every newly written configuration records the safe default explicitly. Do not change any neighboring persisted field or mutate unrelated preferences.

- [ ] **Step 4: Run focused tests and inspect JSON**

Run: `gofmt -w internal/app/config.go internal/app/config_test.go && go test ./internal/app -run 'Telemetry|Config' -count=1`  
Expected: PASS; saved JSON contains `"telemetryEnabled": true` for the opt-in case.

- [ ] **Step 5: Commit**

```bash
git add internal/app/config.go internal/app/config_test.go
git commit -m "feat: persist optional telemetry preference"
```

---

### Task 2: Define closed typed events and the privacy sanitizer

**Files:**
- Create: `internal/telemetry/event.go`
- Create: `internal/telemetry/sanitize.go`
- Create: `internal/telemetry/sanitize_test.go`

- [ ] **Step 1: Write failing sanitizer tests**

```go
func TestSanitizeRejectsIdentifiersAndSecrets(t *testing.T) {
    _, err := telemetry.Sanitize(telemetry.Event{
        Component: telemetry.ComponentMedia,
        Code:      telemetry.CodeAudioOnly,
        State:     "media_audio_only",
        Mode:      "gateway",
        Detail:    "token=secret user=123456789012345678 https://discord.media/x",
    })
    if !errors.Is(err, telemetry.ErrUnsafeEvent) { t.Fatalf("error = %v", err) }
}

func TestSanitizeAllowsOnlyFixedAggregates(t *testing.T) {
    event, err := telemetry.Sanitize(telemetry.Event{
        Component: telemetry.ComponentMedia, Code: telemetry.CodeAudioOnly,
        State: "audio_only", Mode: "gateway", HasAudioSSRC: true,
        HasVideoSSRC: false, AudioPackets: 30960, VideoPackets: 0,
    })
    if err != nil { t.Fatal(err) }
    if event.Code != string(telemetry.CodeAudioOnly) || event.AudioPackets != 30960 {
        t.Fatalf("sanitized event = %#v", event)
    }
    if event.Detail != "" { t.Fatalf("free text survived: %q", event.Detail) }
}

func TestSanitizeRejectsUnknownCodesAndModes(t *testing.T) {
    for _, event := range []telemetry.Event{
        {Component: telemetry.ComponentCore, Code: telemetry.Code("arbitrary")},
        {Component: telemetry.ComponentCore, Code: telemetry.CodeStartupFailure, Mode: "socks5://127.0.0.1:55367"},
    } {
        if _, err := telemetry.Sanitize(event); !errors.Is(err, telemetry.ErrUnsafeEvent) { t.Fatalf("event %#v error = %v", event, err) }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/telemetry -count=1`  
Expected: FAIL because the telemetry package does not exist.

- [ ] **Step 3: Implement the closed event model**

Use no `map[string]any` in the public API. Define:

```go
package telemetry

type Component string
type Code string

const (
    ComponentCore Component = "core"
    ComponentBridge Component = "bridge"
    ComponentMedia Component = "media"

    CodeStartupFailure Code = "startup_failure"
    CodeBridgeFailure Code = "bridge_failure"
    CodeInjectionFailure Code = "injection_failure"
    CodeRecoveryFailure Code = "recovery_failure"
    CodeAudioOnly Code = "audio_only"
    CodeVideoStalled Code = "video_stalled"
    CodeReceiverTimeout Code = "receiver_timeout"
    CodeRTCDisconnected Code = "rtc_disconnected"
    CodeNativeProbeUnavailable Code = "native_probe_unavailable"
    CodeNativeTransmitterStalled Code = "native_transmitter_stalled"
    CodeNativeReceiverNoPackets Code = "native_receiver_no_packets"
    CodeNativeDecoderStalled Code = "native_decoder_stalled"
    CodeNativeRenderUnknown Code = "native_render_unknown"
    CodeTelemetryTest Code = "telemetry_test"
)

type Event struct {
    Component Component
    Code Code
    State string
    Mode string
    Test bool
    StatsAvailable bool
    HasAudioSSRC bool
    HasVideoSSRC bool
    AudioPackets uint64
    VideoPackets uint64
    AudioBytes uint64
    VideoBytes uint64
    FramesDecoded uint64
    ReceiverCount uint64
    DurationBucket string
    Detail string
}

type SafeEvent struct {
    Component string
    Code string
    State string
    Mode string
    Test bool
    StatsAvailable bool
    HasAudioSSRC bool
    HasVideoSSRC bool
    AudioPackets uint64
    VideoPackets uint64
    AudioBytes uint64
    VideoBytes uint64
    FramesDecoded uint64
    ReceiverCount uint64
    DurationBucket string
}
```

The sanitizer must validate component/code/state/mode against closed sets, reject non-empty `Detail`, reject duration values outside `short|medium|long`, and return `SafeEvent` with no user-controlled strings. The final event fields must contain only release, component, code, fixed state/mode tags, booleans and aggregate counters.

- [ ] **Step 4: Run sanitizer tests**

Run: `gofmt -w internal/telemetry && go test ./internal/telemetry -count=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/telemetry/event.go internal/telemetry/sanitize.go internal/telemetry/sanitize_test.go
git commit -m "feat: add typed telemetry privacy sanitizer"
```

---

### Task 3: Implement the opt-in Go reporter with an injectable transport

**Files:**
- Create: `internal/telemetry/reporter.go`
- Create: `internal/telemetry/sentry_transport.go`
- Create: `internal/telemetry/reporter_test.go`
- Modify: `go.mod`
- Modify: `go.sum`

- [ ] **Step 1: Write failing reporter tests**

```go
func TestReporterDoesNotCreateTransportWhileDisabled(t *testing.T) {
    factory := &fakeFactory{}
    reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: t.TempDir()})
    reporter.Capture(telemetry.Event{Component: telemetry.ComponentCore, Code: telemetry.CodeStartupFailure})
    if factory.opens != 0 { t.Fatalf("transport opens = %d", factory.opens) }
}

func TestReporterDeduplicatesMediaEvents(t *testing.T) {
    factory := &fakeFactory{}
    reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: t.TempDir()})
    if err := reporter.Enable(); err != nil { t.Fatal(err) }
    event := telemetry.Event{Component: telemetry.ComponentMedia, Code: telemetry.CodeAudioOnly}
    reporter.Capture(event); reporter.Capture(event)
    if got := factory.client.sent; got != 1 { t.Fatalf("sent = %d, want 1", got) }
}

func TestReporterDisableStopsNewEventsAndPurgesOnlyOwnCache(t *testing.T) {
    cache := t.TempDir()
    marker := filepath.Join(cache, "envelope")
    if err := os.WriteFile(marker, []byte("local"), 0o600); err != nil { t.Fatal(err) }
    factory := &fakeFactory{}
    reporter := telemetry.NewReporter(telemetry.Options{Factory: factory, Release: "0.1.8", CacheDir: cache})
    if err := reporter.Enable(); err != nil { t.Fatal(err) }
    if err := reporter.Disable(); err != nil { t.Fatal(err) }
    reporter.Capture(telemetry.Event{Component: telemetry.ComponentCore, Code: telemetry.CodeStartupFailure})
    if factory.client.sent != 0 { t.Fatalf("sent after disable = %d", factory.client.sent) }
    if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) { t.Fatalf("cache marker error = %v", err) }
}
```

Add these fakes below the tests; they implement the exact interfaces defined in Step 3:

```go
type fakeFactory struct { opens int; client *fakeClient; err error }
type fakeClient struct { sent int; flushed int; closed int; err error }
func (f *fakeFactory) Open(telemetry.Options) (telemetry.Client, error) {
    f.opens++
    if f.err != nil { return nil, f.err }
    f.client = &fakeClient{}
    return f.client, nil
}
func (f *fakeClient) Send(telemetry.SafeEvent) error { if f.err != nil { return f.err }; f.sent++; return nil }
func (f *fakeClient) Flush(context.Context) error { f.flushed++; return f.err }
func (f *fakeClient) Close() error { f.closed++; return nil }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/telemetry -run 'TestReporter' -count=1`  
Expected: FAIL because the reporter and transport interfaces do not exist.

- [ ] **Step 3: Add the lifecycle and interfaces**

Define these exact interfaces and options:

```go
type Client interface {
    Send(SafeEvent) error
    Flush(context.Context) error
    Close() error
}

type Factory interface {
    Open(Options) (Client, error)
}

type Options struct {
    Factory Factory
    Release string
    CacheDir string
    Mode string
}

type Reporter struct {
    // mutex-protected enabled/client/lastSent; no SDK global is used
}

func (r *Reporter) Enable() error
func (r *Reporter) Disable() error
func (r *Reporter) Purge() error
func (r *Reporter) Test(context.Context) error
func (r *Reporter) Capture(Event)
func (r *Reporter) Enabled() bool
```

`Enable` opens the client only once; `Disable` flips the enabled flag before closing so concurrent captures are dropped, closes the client, and purges only `Options.CacheDir`; `Purge` removes/recreates only that directory. `Capture` sanitizes before taking the send path, allows `CodeTelemetryTest` once per explicit `Test` call, and deduplicates non-test media codes for five minutes by component/code. A transport error is returned to `Test` but never panics or stops the core.

- [ ] **Step 4: Implement the `sentry-go` adapter**

Pin the dependency:

```bash
go get github.com/getsentry/sentry-go@v0.49.0
go mod tidy
```

Create the client with:

```go
client, err := sentry.NewClient(sentry.ClientOptions{
    Dsn: dsn,
    Release: options.Release,
    Environment: "production",
    SendDefaultPII: false,
    AttachStacktrace: false,
    EnableTracing: false,
    Transport: sentry.NewHTTPSyncTransport(),
    HTTPTransport: &http.Transport{Proxy: nil},
    BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
        return scrubSentryEvent(event)
    },
})
```

Use a custom transport or the SDK transport with an in-memory bounded buffer; do not use the Discord relay/PAC and do not inherit proxy environment variables. Build each Sentry event from `SafeEvent` as a fixed message `bigducks.<component>.<code>`, fixed tags and numeric/boolean extras. Never call `CaptureException`, add breadcrumbs, attach logs, set a user, or pass the original error/string. Use the DSN constant in `sentry_transport.go`; the reporter is enabled only after explicit config/endpoint action.

- [ ] **Step 5: Run reporter tests and complete Go tests**

Run: `gofmt -w internal/telemetry && go test ./internal/telemetry ./internal/app -count=1`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/telemetry
git commit -m "feat: add opt-in Go Sentry reporter"
```

---

### Task 4: Add RuntimeControl, config mutation and status wiring

**Files:**
- Modify: `internal/app/control.go`
- Modify: `internal/app/control_test.go`
- Modify: `internal/app/run.go`
- Modify: `internal/app/media.go`

- [ ] **Step 1: Write failing control tests**

```go
func TestRuntimeControlTelemetryUsesCurrentBindings(t *testing.T) {
    calls := 0
    control := app.NewRuntimeControl()
    control.Bind(app.RuntimeBindings{
        EnableTelemetry: func(context.Context) error { calls++; return nil },
        DisableTelemetry: func(context.Context) error { calls++; return nil },
        TestTelemetry: func(context.Context) error { calls++; return nil },
        PurgeTelemetry: func(context.Context) error { calls++; return nil },
    })
    if err := control.EnableTelemetry(context.Background()); err != nil { t.Fatal(err) }
    if err := control.DisableTelemetry(context.Background()); err != nil { t.Fatal(err) }
    if err := control.TestTelemetry(context.Background()); err != nil { t.Fatal(err) }
    if err := control.PurgeTelemetry(context.Background()); err != nil { t.Fatal(err) }
    if calls != 4 { t.Fatalf("calls = %d", calls) }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/app -run TestRuntimeControlTelemetryUsesCurrentBindings -count=1`  
Expected: FAIL because the bindings and methods are absent.

- [ ] **Step 3: Add typed status and bindings**

Add:

```go
type TelemetryStatus struct {
    Enabled bool `json:"enabled"`
    LastResult string `json:"lastResult,omitempty"`
}
```

Add `Telemetry TelemetryStatus` to `RuntimeStatus`, plus these functions to `RuntimeBindings` and `RuntimeControl`: `EnableTelemetry`, `DisableTelemetry`, `TestTelemetry`, `PurgeTelemetry`. Nil bindings return `ErrRuntimeUnavailable`, exactly like the existing controls.

- [ ] **Step 4: Initialize the reporter and enforce config ownership**

In `Run`, after `config := options.Config.normalized()` and logger initialization, create the reporter with `CacheDir: filepath.Join(config.DataDir, "telemetry", "core")`. If `config.TelemetryEnabled` is true, call `Enable`; log a local failure and leave the core running if it fails. If false, do not create/open a Sentry client.

Keep a mutex around the in-memory `config` value and persist changes to `filepath.Join(config.DataDir, ConfigFileName)` with `SaveConfig`. Implement endpoint actions with this sequence:

1. enable: call reporter `Enable`; only on success set `TelemetryEnabled=true` and save; sync the bridge;
2. disable: first make reporter reject new captures, set/persist false, tell bridge to disable, then purge the core cache;
3. test: call core `Test`, then bridge test, returning an error if either flush fails;
4. purge: purge core cache and send bridge purge without changing the enabled preference.

No action may modify `AutoStartDiscord`, `Disabled`, `RoutingMode` or proxy state. Attach the reporter to the existing media handler only for transitions; pass fixed component/code and aggregate native fields, never `MediaEvent.Session`.

- [ ] **Step 5: Add reporter calls at explicit failure boundaries**

Report only these points: fatal startup return, bridge start/injection/recovery final failure, and transitions from `ReduceMedia`/native RTC diagnosis into one of the closed failure states. Do not report successful heartbeats, every poll, route changes or raw logs. Deduplicate in the reporter, and keep the local log unchanged for manual diagnosis.

- [ ] **Step 6: Run focused tests and commit**

Run: `gofmt -w internal/app/control.go internal/app/control_test.go internal/app/run.go internal/app/media.go && go test ./internal/app -count=1`  
Expected: PASS.

```bash
git add internal/app/control.go internal/app/control_test.go internal/app/run.go internal/app/media.go
git commit -m "feat: connect telemetry to runtime controls"
```

---

### Task 5: Extend the authenticated local API

**Files:**
- Modify: `internal/controlapi/server.go`
- Modify: `internal/controlapi/client.go`
- Modify: `internal/controlapi/server_test.go`

- [ ] **Step 1: Write failing API tests**

```go
func TestTelemetryEndpointsRequireBearerTokenAndDispatch(t *testing.T) {
    runtime := app.NewRuntimeControl()
    calls := make(map[string]int)
    runtime.Bind(app.RuntimeBindings{
        EnableTelemetry: func(context.Context) error { calls["enable"]++; return nil },
        DisableTelemetry: func(context.Context) error { calls["disable"]++; return nil },
        TestTelemetry: func(context.Context) error { calls["test"]++; return nil },
        PurgeTelemetry: func(context.Context) error { calls["purge"]++; return nil },
        Status: func() app.RuntimeStatus { return app.RuntimeStatus{Telemetry: app.TelemetryStatus{Enabled: false}} },
    })
    server := controlapi.NewServer(controlapi.ServerOptions{DataDir: t.TempDir(), Runtime: runtime})
    if err := server.Start(context.Background()); err != nil { t.Fatal(err) }
    defer server.Close()
    client, err := controlapi.LoadClient(server.ControlPath())
    if err != nil { t.Fatal(err) }
    status, err := client.Status(context.Background())
    if err != nil || status.Telemetry.Enabled { t.Fatalf("status = %#v, error = %v", status, err) }
    actions := []func(context.Context) error{client.EnableTelemetry, client.DisableTelemetry, client.TestTelemetry, client.PurgeTelemetry}
    for _, action := range actions { if err := action(context.Background()); err != nil { t.Fatal(err) } }
    for _, name := range []string{"enable", "disable", "test", "purge"} {
        if calls[name] != 1 { t.Fatalf("%s calls = %d", name, calls[name]) }
    }
    for _, path := range []string{"/v1/telemetry/enable", "/v1/telemetry/disable", "/v1/telemetry/test", "/v1/telemetry/purge"} {
        request, err := http.NewRequest(http.MethodPost, "http://"+server.Address()+path, nil)
        if err != nil { t.Fatal(err) }
        response, err := http.DefaultClient.Do(request)
        if err != nil { t.Fatal(err) }
        response.Body.Close()
        if response.StatusCode != http.StatusUnauthorized { t.Fatalf("unauthenticated %s = %d", path, response.StatusCode) }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/controlapi -run TestTelemetryEndpointsRequireBearerTokenAndDispatch -count=1`  
Expected: FAIL because the routes and client methods do not exist.

- [ ] **Step 3: Register authenticated routes and client methods**

Register:

```go
mux.HandleFunc("/v1/telemetry/enable", s.auth(s.action(s.options.Runtime.EnableTelemetry)))
mux.HandleFunc("/v1/telemetry/disable", s.auth(s.action(s.options.Runtime.DisableTelemetry)))
mux.HandleFunc("/v1/telemetry/test", s.auth(s.action(s.options.Runtime.TestTelemetry)))
mux.HandleFunc("/v1/telemetry/purge", s.auth(s.action(s.options.Runtime.PurgeTelemetry)))
```

Add `EnableTelemetry`, `DisableTelemetry`, `TestTelemetry` and `PurgeTelemetry` methods to `controlapi.Client`, each using POST and the existing bearer token. Preserve the current error/status mapping.

- [ ] **Step 4: Run API tests and commit**

Run: `gofmt -w internal/controlapi && go test ./internal/controlapi -count=1`  
Expected: PASS.

```bash
git add internal/controlapi/server.go internal/controlapi/client.go internal/controlapi/server_test.go
git commit -m "feat: expose authenticated telemetry controls"
```

---

### Task 6: Add bridge synchronization and Electron Sentry source

**Files:**
- Create: `internal/bridge/assets-src/discord_bridge.js`
- Modify: `internal/bridge/server.go`
- Create: `internal/bridge/telemetry_protocol_test.go`
- Modify: `internal/bridge/server_test.go`

- [ ] **Step 1: Move the current asset to source and add protocol tests**

Copy the exact current `internal/bridge/assets/discord_bridge.js` content to `internal/bridge/assets-src/discord_bridge.js` before changing behavior. Add tests that authenticate a client, call `SetTelemetryEnabled(true)`, and assert it receives:

```json
{"type":"telemetry_sync","enabled":true}
```

Then send `{"type":"result","id":...,"ok":true}` for `telemetry_test`, `telemetry_disable` and `telemetry_purge` and assert the corresponding Go methods return nil.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/bridge -run 'Telemetry|EmbeddedScript' -count=1`  
Expected: FAIL because the source file, state synchronization and commands do not exist.

- [ ] **Step 3: Add typed server methods and state synchronization**

Add to `bridge.Server`:

```go
func (s *Server) SetTelemetryEnabled(enabled bool)
func (s *Server) TestTelemetry(context.Context) error
func (s *Server) DisableTelemetry(context.Context) error
func (s *Server) PurgeTelemetry(context.Context) error
```

Store the desired enabled state under the existing mutex. When a client authenticates, send `telemetry_sync` immediately. When `SetTelemetryEnabled` changes the value and a client is connected, send the sync message under the encoder mutex. `TestTelemetry`, `DisableTelemetry` and `PurgeTelemetry` use the existing command/result mechanism. A disconnected bridge returns `ErrUnavailable`; syncing a newly connected client is best effort and must not prevent authentication.

- [ ] **Step 4: Add the Electron main-process telemetry implementation**

In `assets-src/discord_bridge.js`, import `@sentry/electron/main` and `makeNodeTransport` from `@sentry/node` in the bundled source, then keep Sentry completely inactive until `telemetry_sync.enabled === true`. Use:

```js
const SENTRY_DSN = "https://d6d3529330c54bad7b7f266b1d124580@o4512025900810240.ingest.us.sentry.io/4512025910444032";
let telemetryEnabled = false;
let telemetryReady = false;

function configureTelemetry(enabled) {
  if (!enabled) {
    telemetryEnabled = false;
    return Promise.resolve(closeAndPurgeElectronTelemetry());
  }
  if (telemetryReady) { telemetryEnabled = true; return Promise.resolve(); }
  telemetryEnabled = true;
  Sentry.init({
    dsn: SENTRY_DSN,
    release: "bigducks-live@" + safeRelease(),
    sendDefaultPii: false,
    autoSessionTracking: false,
    enableAutoPerformanceTracking: false,
    integrations: [],
    getSessions: () => [],
    transport: makeNodeTransport,
    tracesSampleRate: 0,
    beforeSend(event) { return sanitizeElectronEvent(event); }
  });
  telemetryReady = true;
  return Promise.resolve();
}
```

`safeRelease()` returns only the BIG DUCKS version format. `sanitizeElectronEvent()` removes request data, user, breadcrumbs, contexts, URLs, paths, IP-like strings, tokens, long numeric sequences and exception stacks, then permits only the fixed event message and generated numeric/boolean extras. Call `Sentry.captureMessage` only with `bigducks.<fixed-code>`. Do not use renderer imports, `captureException`, `setUser`, screenshots, profiling, tracing or log attachments.

Use the Node HTTPS transport, not Electron’s `net`/offline transport, so Sentry requests do not use the Discord `session.defaultSession` PAC/SOCKS route. Keep the SDK buffer in memory, create no queue outside `path.join(dataRoot, "telemetry", "electron")`, and make purge remove only that directory. Do not route Sentry through the Discord PAC/SOCKS relay.

- [ ] **Step 5: Add bridge operation capture and protocol handlers**

Capture only explicit bridge failures from `reloadClient`, `closeConnections`, `resolveProxy`, telemetry setup/flush and local socket connect. Use fixed codes and generated booleans; never pass `error.message` to Sentry. `telemetry_test` sends exactly one `telemetry_test` event and waits at most 2 seconds for `Sentry.flush(2000)`. `telemetry_disable` sets `telemetryEnabled=false` before closing and purges the Electron-owned directory. `telemetry_purge` purges without changing the enabled flag. All handlers reply to the Go command and keep the bridge alive after an SDK failure.

- [ ] **Step 6: Run protocol tests and syntax check**

Run: `node --check internal/bridge/assets-src/discord_bridge.js && go test ./internal/bridge -count=1`  
Expected: source syntax and Go protocol tests pass.

- [ ] **Step 7: Commit**

```bash
git add internal/bridge/assets-src/discord_bridge.js internal/bridge/server.go internal/bridge/telemetry_protocol_test.go internal/bridge/server_test.go
git commit -m "feat: synchronize Electron telemetry opt-in"
```

---

### Task 7: Make the JavaScript bundle reproducible and embedded

**Files:**
- Create: `scripts/bridge/package.json`
- Create: `scripts/bridge/package-lock.json`
- Create: `scripts/bridge/build.mjs`
- Create: `scripts/bridge/check.mjs`
- Modify: `internal/bridge/assets/discord_bridge.js`
- Modify: `internal/bridge/server_test.go`
- Modify: `build.ps1`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add fixed Node dependencies**

Create:

```json
{
  "name": "bigducks-bridge-build",
  "private": true,
  "type": "module",
  "scripts": {"build": "node build.mjs", "check": "node check.mjs"},
  "dependencies": {"@sentry/electron": "7.18.0"},
  "devDependencies": {"esbuild": "0.28.2"}
}
```

Run `npm install --package-lock-only --ignore-scripts` in `scripts/bridge` and retain the generated lockfile. No package is installed in the Discord directory.

- [ ] **Step 2: Add the deterministic bundle command**

`build.mjs` must resolve paths from `import.meta.url`, bundle `../../internal/bridge/assets-src/discord_bridge.js` to `../../internal/bridge/assets/discord_bridge.js`, use `platform: "node"`, `format: "cjs"`, `target: "node22"`, `bundle: true`, `minify: false`, `sourcemap: false`, and externalize only Electron built-ins that the Discord process provides. The output must keep the existing `"use strict"` behavior and contain no absolute local paths.

`check.mjs` must run the same build into a temporary file, compare bytes with the committed asset, and exit nonzero with the first differing path if they differ. It must also fail if the asset contains `@sentry/electron/renderer`, `captureException`, `setUser`, `process.env`, `Authorization`, `token=` or a Windows user path.

- [ ] **Step 3: Generate the embedded asset and add contract assertions**

Run: `npm ci --ignore-scripts && npm run build && npm run check` from `scripts/bridge`. Extend `TestEmbeddedScriptTargetsOnlyDiscordClientWindows` to require `telemetry_sync`, `telemetry_test`, `telemetry_disable`, `telemetry_purge`, `@sentry/electron/main`-equivalent bundled code, and to reject renderer-specific imports/handlers.

- [ ] **Step 4: Integrate bundle verification into builds**

At the start of `build.ps1`, before `go test ./...`, run:

```powershell
Push-Location (Join-Path $PSScriptRoot "scripts\bridge")
try { npm ci --ignore-scripts; npm run build; npm run check }
finally { Pop-Location }
```

Add equivalent `npm ci`, `npm run build`, and `npm run check` steps before Go tests in CI and before the release build. The release must fail if the generated asset diverges.

- [ ] **Step 5: Run Node and Go checks**

Run: `node scripts/bridge/check.mjs && go test ./internal/bridge -count=1`  
Expected: reproducibility check and bridge tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/bridge internal/bridge/assets/discord_bridge.js internal/bridge/server_test.go build.ps1 .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "build: bundle Electron telemetry reproducibly"
```

---

### Task 8: Add HUD controls with explicit confirmation

**Files:**
- Modify: `internal/hud/hud_windows.go`
- Modify: `internal/hud/assets/index.html`
- Modify: `internal/hud/assets/app.js`
- Modify: `internal/hud/hud_windows_test.go`

- [ ] **Step 1: Write failing HUD tests**

Add `encoding/json`, `strings` and `github.com/alikwelyn/bigducks-live/internal/app` to the Windows test imports, then add:

```go
func TestStatusViewCarriesTelemetryState(t *testing.T) {
    view := StatusView{Telemetry: app.TelemetryStatus{Enabled: true, LastResult: "sent"}}
    data, err := json.Marshal(view)
    if err != nil { t.Fatal(err) }
    if !strings.Contains(string(data), `"telemetry":{"enabled":true,"lastResult":"sent"}`) {
        t.Fatalf("status view = %s", data)
    }
}
```

Also add the following asset assertion to `internal/hud/assets_test.go`:

```go
func TestPageContainsTelemetryControls(t *testing.T) {
    page := hud.PageHTML()
    for _, required := range []string{"telemetry-title", "telemetry-enable", "telemetry-test", "telemetry-disable", "bigDucksTelemetryEnable"} {
        if !strings.Contains(page, required) { t.Fatalf("HUD page does not contain %q", required) }
    }
}
```

The controller binding map must expose `bigDucksTelemetryEnable`, `bigDucksTelemetryDisable`, `bigDucksTelemetryTest`, and `bigDucksTelemetryPurge`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `GOOS=windows GOARCH=amd64 go test ./internal/hud -run 'Telemetry|telemetry' -count=1`  
Expected: FAIL because the view field and bindings are absent.

- [ ] **Step 3: Add status and bindings**

Add `Telemetry app.TelemetryStatus json:"telemetry"` to `StatusView`, copy `status.Telemetry` in `controller.status`, and bind the four methods to `controlapi.Client` calls using the existing `action` helper. Use timeouts of 8 seconds for enable/disable/purge and 12 seconds for test.

- [ ] **Step 4: Add the compact HUD section**

Add to `index.html`:

```html
<section class="telemetry-card" aria-labelledby="telemetry-title">
  <div><p class="label">DIAGNÓSTICO OPCIONAL</p><h2 id="telemetry-title">Telemetria Sentry</h2>
  <p id="telemetry-detail">Desativada por padrão. Sem tokens, mensagens, IPs, IDs ou logs completos.</p></div>
  <div class="telemetry-actions">
    <button id="telemetry-enable" class="button secondary" type="button">Ativar</button>
    <button id="telemetry-test" class="button secondary" type="button">Enviar teste</button>
    <button id="telemetry-disable" class="button secondary" type="button">Desativar e apagar dados locais</button>
  </div>
</section>
```

In `app.js`, render enabled/disabled state, disable “Ativar” when already active, require `window.confirm("Desativar a telemetria e apagar somente os dados locais do BIG DUCKS?")` before disable, and state clearly that events already enviados must be removed through the Sentry Dashboard/API. Do not expose DSN or raw error text.

- [ ] **Step 5: Run Windows HUD tests and commit**

Run: `gofmt -w internal/hud/hud_windows.go internal/hud/hud_windows_test.go && GOOS=windows GOARCH=amd64 go test ./internal/hud -count=1`  
Expected: PASS.

```bash
git add internal/hud/hud_windows.go internal/hud/assets/index.html internal/hud/assets/app.js internal/hud/hud_windows_test.go
git commit -m "feat: add optional telemetry controls to HUD"
```

---

### Task 9: Document privacy and integrate explicit media events

**Files:**
- Create: `docs/telemetry.md`
- Modify: `README.md`
- Modify: `internal/app/run.go`
- Modify: `internal/app/media.go`
- Modify: `internal/app/media_test.go`

- [ ] **Step 1: Write failing media-report test**

Add `github.com/alikwelyn/bigducks-live/internal/telemetry` to the imports of `internal/app/media_test.go`, then add:

```go
type mediaCapture struct { events []telemetry.Event }
func (c *mediaCapture) Capture(event telemetry.Event) { c.events = append(c.events, event) }

func TestMediaFailureReportsOnlyOnTransition(t *testing.T) {
    capture := &mediaCapture{}
    before := MediaStatus{}
    after := ReduceMedia(before, MediaEvent{Session: "discord-session-secret", Kind: "stream_start"})
    reportMediaTransition(capture, before, after)
    before = after
    after = ReduceMedia(before, MediaEvent{Session: "discord-session-secret", Kind: "audio_packet"})
    reportMediaTransition(capture, before, after)
    before = after
    after = ReduceMedia(before, MediaEvent{Session: "discord-session-secret", Kind: "audio_packet"})
    reportMediaTransition(capture, before, after)
    if len(capture.events) != 1 || capture.events[0].Code != telemetry.CodeAudioOnly {
        t.Fatalf("captured events = %#v", capture.events)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/app -run TestMediaFailureReportsOnlyOnTransition -count=1`  
Expected: FAIL because media reduction is not connected to a reporter.

- [ ] **Step 3: Wire fixed media events**

When a media state changes into `MediaAudioOnly`, `MediaVideoStalled`, `MediaReceiverTimeout`, `MediaRTCDisconnected` or the native RTC diagnosis states, call this typed helper:

```go
func reportMediaTransition(reporter interface{ Capture(telemetry.Event) }, before, after MediaStatus) {
    if reporter == nil || before.State == after.State { return }
    code, ok := map[MediaState]telemetry.Code{
        MediaAudioOnly: telemetry.CodeAudioOnly, MediaVideoStalled: telemetry.CodeVideoStalled,
        MediaReceiverTimeout: telemetry.CodeReceiverTimeout, MediaRTCDisconnected: telemetry.CodeRTCDisconnected,
        MediaNativeReceiverAudioOnly: telemetry.CodeAudioOnly,
        MediaNativeReceiverNoPackets: telemetry.CodeNativeReceiverNoPackets,
        MediaNativeDecoderStalled: telemetry.CodeNativeDecoderStalled,
        MediaNativeTransmitterStalled: telemetry.CodeNativeTransmitterStalled,
        MediaNativeProbeUnavailable: telemetry.CodeNativeProbeUnavailable,
        MediaNativeRenderUnknown: telemetry.CodeNativeRenderUnknown,
        MediaNativeRTCDisconnected: telemetry.CodeRTCDisconnected,
    }[after.State]
    if !ok { return }
    reporter.Capture(telemetry.Event{Component: telemetry.ComponentMedia, Code: code, State: string(after.State)})
}
```

Call it after each reduction. Do not include `MediaStatus.Session`, `MediaEvent.Session`, stream keys, SSRC values, URLs or log text. Rely on reporter deduplication and keep the existing status events/logging.

- [ ] **Step 4: Write documentation**

`docs/telemetry.md` must state:

1. disabled by default and enabled only by HUD/config;
2. exact event components/codes and aggregate fields;
3. no tokens, IPs, URLs, paths, messages, Discord IDs, user/guild/channel/stream IDs or SSRC values;
4. bridge runs only in Discord’s main process and does not instrument renderers;
5. Sentry traffic bypasses Discord routing;
6. disable blocks new events and purges only `%LOCALAPPDATA%\\DiscordStream\\telemetry`;
7. already-sent events require Sentry Dashboard/API deletion;
8. how to reproduce the current audio-without-video case and correlate native RTC diagnosis.

Update README with the default-off behavior and the HUD location, without embedding the DSN.

- [ ] **Step 5: Run tests and documentation checks**

Run: `gofmt -w internal/app/run.go internal/app/media.go internal/app/media_test.go && go test ./internal/app -count=1 && rg -n "desativada|SSRC|Dashboard|renderer|DiscordStream" docs/telemetry.md`  
Expected: PASS and all privacy/recovery terms are present.

- [ ] **Step 6: Commit**

```bash
git add docs/telemetry.md README.md internal/app/run.go internal/app/media.go internal/app/media_test.go
git commit -m "docs: describe optional telemetry and media events"
```

---

### Task 10: Final verification and release gate

**Files:**
- No source changes unless a command below identifies a concrete defect.

- [ ] **Step 1: Rebuild and verify JavaScript**

Run:

```bash
cd scripts/bridge
npm ci --ignore-scripts
npm run build
npm run check
cd ../..
node --check internal/bridge/assets/discord_bridge.js
```

Expected: lockfile install, deterministic bundle check and syntax check all exit 0.

- [ ] **Step 2: Run Go quality gates**

Run:

```bash
gofmt -w internal
 go test ./...
go vet ./...
git diff --check
```

Expected: all commands exit 0 and `git diff --check` emits no output.

- [ ] **Step 3: Build Windows x64**

Run: `pwsh -NoProfile -File .\build.ps1 -Version 0.1.8 -OutputDirectory dist\telemetry`  
Expected: `dist/telemetry/BigDucks.exe` is generated and the script prints a SHA-256 line.

- [ ] **Step 4: Verify default-off behavior without network**

Run: `go test ./... -run 'Telemetry|telemetry' -count=1` and inspect the tests to ensure no test uses the production DSN or opens a network connection unless explicitly requested by a manual test.  
Expected: all tests use fake transports and the default configuration creates no Sentry client.

If any verification command fails, stop before claiming completion, isolate the concrete failing behavior, add a red test, and make a separate corrective commit before rerunning the full gate.

Do not claim that events reached Sentry until the opt-in manual test performs a real flush and the Sentry project shows the two test events. Events already sent are deleted through the Sentry Dashboard/API, not by the local purge command.
