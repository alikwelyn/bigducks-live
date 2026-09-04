# Diagnóstico nativo do RTC do Go Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrumentar o caminho nativo do `discord_voice` em modo somente leitura para identificar se o vídeo falha na captura, encode, transporte, descriptografia, decode ou renderização.

**Architecture:** Um preload idempotente será registrado no Electron antes das janelas do Discord e envolverá apenas os factories do módulo nativo `discord_voice`. A bridge no processo principal consultará o mundo isolado 999, correlacionará o resumo com demanda de mídia/WebSockets e enviará ao núcleo somente eventos agregados e sem PII. A redução exigirá amostras consecutivas e não executará recuperação automática.

**Tech Stack:** Go 1.26, testes Go, JavaScript CommonJS executado pelo Electron, `executeJavaScriptInIsolatedWorld`, preload de sessão Electron e protocolo TCP autenticado existente.

---

## Mapa de arquivos

- Criar `internal/bridge/native_rtc.go`: tipos Go sanitizados e redução de amostras nativas.
- Criar `internal/bridge/native_rtc_test.go`: testes da validação e classificação.
- Modificar `internal/bridge/server.go`: aceitar o payload `native` no evento de mídia e entregá-lo ao núcleo após validação.
- Modificar `internal/bridge/media_event_test.go`: testar snapshot nativo recebido pela bridge.
- Modificar `internal/bridge/assets/discord_bridge.js`: registrar preload, instalar probe no mundo principal, consultar o mundo 999 e emitir snapshots agregados.
- Modificar `internal/bridge/server_test.go`: validar que o asset contém o caminho nativo e que o registro acontece antes da conexão do Discord.
- Modificar `internal/app/media.go`: armazenar o último diagnóstico nativo e classificar somente após amostras consecutivas.
- Modificar `internal/app/media_test.go`: cobrir áudio sem vídeo, sem pacotes, decoder parado e amostra isolada.
- Modificar `internal/app/run.go`: ligar os eventos nativos à redução de mídia e ao log local, sem disparar ações.
- Modificar `internal/hud/assets/app.js` e `internal/hud/assets/index.html`: exibir a classificação nativa na área técnica, sem exibir SSRC ou identificadores.
- Modificar `internal/hud/hud_windows.go`: transportar `MediaStatus` para o HUD.
- Modificar `docs/como-funciona.md` ou criar `docs/native-rtc-diagnostics.md`: documentar como reproduzir e interpretar a coleta.

---

### Task 1: Fixar os tipos seguros do snapshot nativo

**Files:**
- Create: `internal/bridge/native_rtc.go`
- Test: `internal/bridge/native_rtc_test.go`

- [ ] **Step 1: Write the failing tests**

```go
func TestNormalizeNativeSnapshotKeepsOnlySafeAggregates(t *testing.T) {
    snapshot, err := bridge.NormalizeNativeSnapshot(map[string]any{
        "hooked": true,
        "streamConnection": true,
        "statsAvailable": true,
        "hasAudioSsrc": true,
        "videoSsrc": "123456789012345678",
        "audioPackets": float64(30960),
        "videoPackets": float64(0),
        "framesDecoded": float64(0),
        "userId": "123456789012345678",
        "url": "wss://secret.discord.media/?token=secret",
    })
    if err != nil { t.Fatal(err) }
    if !snapshot.HasAudioSSRC || snapshot.HasVideoSSRC {
        t.Fatalf("ssrc presence = %#v", snapshot)
    }
    if snapshot.AudioPackets != 30960 || snapshot.VideoPackets != 0 {
        t.Fatalf("counters = %#v", snapshot)
    }
    if snapshot.RawShape != "" { t.Fatalf("raw shape leaked: %q", snapshot.RawShape) }
}

func TestNormalizeNativeSnapshotRejectsUnboundedOrInvalidCounters(t *testing.T) {
    _, err := bridge.NormalizeNativeSnapshot(map[string]any{
        "audioPackets": float64(-1),
        "videoPackets": float64(9007199254740992),
    })
    if !errors.Is(err, bridge.ErrInvalidNativeSnapshot) { t.Fatalf("error = %v", err) }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/bridge -run 'TestNormalizeNativeSnapshot' -count=1`  
Expected: FAIL because `NormalizeNativeSnapshot`, `NativeSnapshot` and `ErrInvalidNativeSnapshot` do not exist.

- [ ] **Step 3: Implement the minimal typed contract**

```go
package bridge

import (
    "errors"
    "fmt"
    "math"
)

var ErrInvalidNativeSnapshot = errors.New("invalid native RTC snapshot")

type NativeSnapshot struct {
    Hooked           bool   `json:"hooked"`
    StreamConnection bool   `json:"streamConnection"`
    StatsAvailable   bool   `json:"statsAvailable"`
    DemandActive     bool   `json:"demandActive"`
    HasAudioSSRC     bool   `json:"hasAudioSsrc"`
    HasVideoSSRC     bool   `json:"hasVideoSsrc"`
    AudioPackets     uint64 `json:"audioPackets"`
    VideoPackets     uint64 `json:"videoPackets"`
    AudioBytes       uint64 `json:"audioBytes"`
    VideoBytes       uint64 `json:"videoBytes"`
    AudioFrames      uint64 `json:"audioFrames"`
    VideoFrames      uint64 `json:"videoFrames"`
    CaptureFrames    uint64 `json:"captureFrames"`
    EncodedFrames    uint64 `json:"encodedFrames"`
    FramesDecoded    uint64 `json:"framesDecoded"`
    FramesDropped    uint64 `json:"framesDropped"`
    ReceiverCount    uint64 `json:"receiverCount"`
    Width            uint32 `json:"width"`
    Height           uint32 `json:"height"`
    InputFPS         float64 `json:"inputFPS"`
    EncodedFPS       float64 `json:"encodedFPS"`
    RawShape         string `json:"-"`
}

func NormalizeNativeSnapshot(raw map[string]any) (NativeSnapshot, error) {
    var out NativeSnapshot
    if raw == nil { return out, fmt.Errorf("%w: nil", ErrInvalidNativeSnapshot) }
    out.Hooked = boolValue(raw["hooked"])
    out.StreamConnection = boolValue(raw["streamConnection"])
    out.StatsAvailable = boolValue(raw["statsAvailable"])
    out.DemandActive = boolValue(raw["demandActive"])
    out.HasAudioSSRC = boolValue(raw["hasAudioSsrc"])
    out.HasVideoSSRC = boolValue(raw["hasVideoSsrc"])
    counters := []struct{ key string; dst *uint64 }{
        {"audioPackets", &out.AudioPackets}, {"videoPackets", &out.VideoPackets},
        {"audioBytes", &out.AudioBytes}, {"videoBytes", &out.VideoBytes},
        {"audioFrames", &out.AudioFrames}, {"videoFrames", &out.VideoFrames},
        {"captureFrames", &out.CaptureFrames}, {"encodedFrames", &out.EncodedFrames},
        {"framesDecoded", &out.FramesDecoded}, {"framesDropped", &out.FramesDropped},
        {"receiverCount", &out.ReceiverCount},
    }
    for _, item := range counters {
        value, present := raw[item.key]
        if !present { continue }
        number, ok := safeUint(value)
        if !ok { return NativeSnapshot{}, fmt.Errorf("%w: %s", ErrInvalidNativeSnapshot, item.key) }
        *item.dst = number
    }
    if value, present := raw["inputFPS"]; present {
        out.InputFPS, present = safeFloat(value); if !present { return NativeSnapshot{}, fmt.Errorf("%w: inputFPS", ErrInvalidNativeSnapshot) }
    }
    if value, present := raw["encodedFPS"]; present {
        out.EncodedFPS, present = safeFloat(value); if !present { return NativeSnapshot{}, fmt.Errorf("%w: encodedFPS", ErrInvalidNativeSnapshot) }
    }
    return out, nil
}

func boolValue(value any) bool { result, _ := value.(bool); return result }
func safeUint(value any) (uint64, bool) {
    number, ok := value.(float64)
    return uint64(number), ok && number >= 0 && number <= math.MaxInt53 && math.Trunc(number) == number
}
func safeFloat(value any) (float64, bool) {
    number, ok := value.(float64)
    return number, ok && math.IsNaN(number) == false && math.IsInf(number, 0) == false && number >= 0 && number <= 100000
}
```

The implementation must not copy unknown keys or retain raw JSON. Boolean SSRC fields are the only accepted SSRC representation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `gofmt -w internal/bridge/native_rtc.go internal/bridge/native_rtc_test.go && go test ./internal/bridge -run 'TestNormalizeNativeSnapshot' -count=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/bridge/native_rtc.go internal/bridge/native_rtc_test.go
git commit -m "feat: define safe native RTC snapshot"
```

---

### Task 2: Extend and validate the authenticated bridge protocol

**Files:**
- Modify: `internal/bridge/server.go`
- Modify: `internal/bridge/media_event_test.go`
- Test: `internal/bridge/native_rtc_test.go`

- [ ] **Step 1: Write the failing protocol test**

```go
func TestServerReceivesValidatedNativeSnapshot(t *testing.T) {
    dataDir := t.TempDir()
    server := bridge.NewServer(dataDir)
    events := make(chan bridge.MediaEvent, 1)
    server.SetMediaEventHandler(func(event bridge.MediaEvent) { events <- event })
    if err := server.Start(context.Background()); err != nil { t.Fatal(err) }
    defer server.Close()
    data, err := os.ReadFile(filepath.Join(dataDir, bridge.ControlFileName))
    if err != nil { t.Fatal(err) }
    var control bridge.ControlFile
    if err := json.Unmarshal(data, &control); err != nil { t.Fatal(err) }
    conn, err := net.Dial("tcp", control.Address)
    if err != nil { t.Fatal(err) }
    defer conn.Close()
    encoder := json.NewEncoder(conn)
    if err := encoder.Encode(map[string]any{"type": "hello", "token": control.Token}); err != nil { t.Fatal(err) }
    deadline := time.Now().Add(time.Second)
    for !server.Status().Connected && time.Now().Before(deadline) { time.Sleep(time.Millisecond) }
    if !server.Status().Connected { t.Fatal("bridge did not connect") }
    if err := encoder.Encode(map[string]any{
        "type": "media_event", "event": "native_rtc_snapshot",
        "native": map[string]any{
            "audioPackets": float64(20), "videoPackets": float64(0),
            "hasAudioSsrc": true, "hasVideoSsrc": false,
            "videoSsrc": "123456789012345678", "url": "wss://secret/?token=secret",
        },
    }); err != nil { t.Fatal(err) }
    select {
    case event := <-events:
        if event.Native == nil || !event.Native.HasAudioSSRC || event.Native.HasVideoSSRC || event.Native.AudioPackets != 20 {
            t.Fatalf("native event = %#v", event.Native)
        }
    case <-time.After(time.Second):
        t.Fatal("native event was not delivered")
    }
}
```

The `NativeSnapshot` type contains no raw payload field, so the test proves the injected SSRC and URL are discarded.

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/bridge -run TestServerReceivesValidatedNativeSnapshot -count=1`  
Expected: FAIL because `MediaEvent` and `protocolMessage` do not carry `Native`.

- [ ] **Step 3: Add the typed protocol field and validation**

```go
type MediaEvent struct {
    Session string
    Kind    string
    At      time.Time
    Native  *NativeSnapshot
}

type protocolMessage struct {
    // existing fields remain unchanged
    Native map[string]any `json:"native,omitempty"`
}
```

In `handleClient`, accept only `native_rtc_snapshot` as the event that may contain `Native`, call `NormalizeNativeSnapshot`, and drop malformed snapshots without disconnecting the authenticated bridge. For all other event names, set `Native` to nil. Preserve existing media event behavior and do not forward `Session` to telemetry.

- [ ] **Step 4: Run the focused and complete bridge tests**

Run: `gofmt -w internal/bridge/server.go internal/bridge/media_event_test.go internal/bridge/native_rtc_test.go && go test ./internal/bridge -count=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/bridge/server.go internal/bridge/media_event_test.go internal/bridge/native_rtc_test.go
git commit -m "feat: validate native RTC bridge events"
```

---

### Task 3: Add pure native-media classification with consecutive samples

**Files:**
- Modify: `internal/app/media.go`
- Modify: `internal/app/media_test.go`

- [ ] **Step 1: Write failing reducer tests**

```go
func TestReduceNativeMediaRequiresTwoAudioOnlySamples(t *testing.T) {
    status := app.ReduceNativeMedia(app.MediaStatus{}, app.NativeMediaSample{
        DemandActive: true, StatsAvailable: true, HasAudioSSRC: true,
        AudioPackets: 10, VideoPackets: 0, FramesDecoded: 0,
    })
    if status.State != app.MediaUnknown { t.Fatalf("first sample state = %s", status.State) }
    status = app.ReduceNativeMedia(status, app.NativeMediaSample{
        DemandActive: true, StatsAvailable: true, HasAudioSSRC: true,
        AudioPackets: 20, VideoPackets: 0, FramesDecoded: 0,
    })
    if status.State != app.MediaNativeReceiverAudioOnly { t.Fatalf("state = %s", status.State) }
}

func TestReduceNativeMediaDistinguishesDecoderStallFromNoVideoPackets(t *testing.T) {
    status := app.ReduceNativeMedia(app.MediaStatus{}, app.NativeMediaSample{
        DemandActive: true, StatsAvailable: true, VideoPackets: 10, FramesDecoded: 0,
    })
    status = app.ReduceNativeMedia(status, app.NativeMediaSample{
        DemandActive: true, StatsAvailable: true, VideoPackets: 20, FramesDecoded: 0,
    })
    if status.State != app.MediaNativeDecoderStalled { t.Fatalf("state = %s", status.State) }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/app -run 'TestReduceNativeMedia' -count=1`  
Expected: FAIL because the new sample type and states do not exist.

- [ ] **Step 3: Implement the minimal state machine**

Add states and fields in `internal/app/media.go`:

```go
const (
    MediaNativeProbeUnavailable MediaState = "native_probe_unavailable"
    MediaNativeTransmitterStalled MediaState = "native_transmitter_stalled"
    MediaNativeReceiverAudioOnly MediaState = "native_receiver_audio_only"
    MediaNativeReceiverNoPackets MediaState = "native_receiver_no_packets"
    MediaNativeDecoderStalled MediaState = "native_decoder_stalled"
    MediaNativeRenderUnknown MediaState = "native_render_unknown"
    MediaNativeRTCDisconnected MediaState = "native_rtc_disconnected"
)

type NativeMediaSample struct {
    Hooked, StreamConnection, StatsAvailable, DemandActive bool
    HasAudioSSRC, HasVideoSSRC bool
    AudioPackets, VideoPackets, AudioBytes, VideoBytes uint64
    AudioFrames, VideoFrames, CaptureFrames, EncodedFrames uint64
    FramesDecoded, FramesDropped, ReceiverCount uint64
    InputFPS, EncodedFPS float64
}
```

Add `Native NativeMediaStatus` to `MediaStatus`, where `NativeMediaStatus` stores the last safe counters and `Consecutive int`. `ReduceNativeMedia` must:

1. clear consecutive count when demand is false or stats are unavailable;
2. compare counters with the previous sample;
3. return unknown on the first eligible sample;
4. classify transmitter stalled when a stream has demand, input/encode fields are present and neither input nor encoded counters progress;
5. classify receiver no-packets when demand is active, audio/video SSRC state is known, and neither media packet counter progresses;
6. classify receiver audio-only when audio progresses and video has no SSRC or no video packet progress;
7. classify decoder stalled when video packets/bytes progress but decoded frames do not;
8. never classify from a single sample.

The function must copy only the typed sample and must not accept JSON or strings.

- [ ] **Step 4: Run focused and existing media tests**

Run: `gofmt -w internal/app/media.go internal/app/media_test.go && go test ./internal/app -run 'Media|media' -count=1`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/app/media.go internal/app/media_test.go
git commit -m "feat: classify native RTC media failures"
```

---

### Task 4: Install the isolated-world native probe in the bridge

**Files:**
- Modify: `internal/bridge/assets/discord_bridge.js`
- Modify: `internal/bridge/server_test.go`

- [ ] **Step 1: Add asset contract tests first**

```go
func TestEmbeddedScriptContainsNativeRTCProbe(t *testing.T) {
    script := string(bridge.Script())
    for _, required := range []string{
        "registerPreloadScript", "big-ducks-native-rtc", "executeJavaScriptInIsolatedWorld",
        "discord_voice", "createVoiceConnectionWithOptions",
        "createOwnStreamConnectionWithOptions", "getFilteredStats", "Remote media sink wants:",
        "hasVideoSsrc", "framesDecoded",
    } {
        if !strings.Contains(script, required) { t.Fatalf("missing %q", required) }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/bridge -run TestEmbeddedScriptContainsNativeRTCProbe -count=1`  
Expected: FAIL because the current asset has no native probe.

- [ ] **Step 3: Add the idempotent preload and safe normalizer**

At the beginning of the bridge asset, before the existing `app.whenReady().then(connect)`, add a self-contained preload source with these exact responsibilities:

```js
const VOICE_WORLD_ID = 999;
const VOICE_PRELOAD_ID = "big-ducks-native-rtc";
const voicePreloadSource = `(() => {
  if (globalThis.__BIG_DUCKS_NATIVE_RTC_PROBE__) return;
  const state = { installed: false, hooked: false, nextId: 1, connections: [] };
  globalThis.__BIG_DUCKS_NATIVE_RTC_PROBE__ = state;
  const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  const counter = value => {
    const result = finite(value);
    return result !== null && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? result : null;
  };
  const has = value => value !== undefined && value !== null && value !== "";
  const normalize = raw => ({
    available: !!raw,
    audioPackets: counter(raw && (raw.audioPackets ?? raw.packetsReceivedAudio)),
    videoPackets: counter(raw && (raw.videoPackets ?? raw.packetsReceivedVideo)),
    audioBytes: counter(raw && (raw.audioBytes ?? raw.bytesReceivedAudio)),
    videoBytes: counter(raw && (raw.videoBytes ?? raw.bytesReceivedVideo)),
    audioFrames: counter(raw && raw.audioFrames),
    videoFrames: counter(raw && (raw.videoFrames ?? raw.framesReceived)),
    captureFrames: counter(raw && (raw.captureFrames ?? raw.pipewireFrames)),
    encodedFrames: counter(raw && (raw.encodedFrames ?? raw.framesEncoded)),
    framesDecoded: counter(raw && (raw.framesDecoded ?? raw.framesDecodedVideo)),
    framesDropped: counter(raw && (raw.framesDropped ?? raw.framesDroppedVideo)),
    receiverCount: counter(raw && raw.receiverCount),
    hasAudioSsrc: has(raw && (raw.audioSsrc ?? raw.audioSSRC)),
    hasVideoSsrc: has(raw && (raw.videoSsrc ?? raw.videoSSRC)),
    width: counter(raw && (raw.width ?? raw.frameWidth)),
    height: counter(raw && (raw.height ?? raw.frameHeight)),
    inputFPS: finite(raw && raw.inputFrameRate),
    encodedFPS: finite(raw && raw.encodeFrameRate)
  });
  const register = (kind, creator, conn) => {
    if (!conn || (typeof conn !== "object" && typeof conn !== "function")) return conn;
    if (state.connections.some(item => item.conn === conn)) return conn;
    state.connections.push({ id: state.nextId++, kind, creator, conn, createdAt: Date.now(), destroyed: false });
    if (state.connections.length > 16) state.connections.shift();
    return conn;
  };
  const hook = voice => {
    if (!voice || state.hooked) return voice;
    ["createVoiceConnectionWithOptions", "createOwnStreamConnectionWithOptions"].forEach(name => {
      const original = voice[name];
      if (typeof original !== "function") return;
      voice[name] = function () {
        const kind = name === "createOwnStreamConnectionWithOptions" ? "stream" : "voice";
        return register(kind, name, original.apply(this, arguments));
      };
    });
    state.hooked = true;
    return voice;
  };
  const install = () => {
    try {
      const modules = window.DiscordNative && window.DiscordNative.nativeModules;
      if (!modules || typeof modules.requireModule !== "function") return setTimeout(install, 100);
      const original = modules.requireModule;
      modules.requireModule = function () {
        const module = original.apply(this, arguments);
        if (arguments[0] === "discord_voice") hook(module);
        return module;
      };
      try { hook(original.call(modules, "discord_voice")); } catch (_) {}
      state.installed = true;
    } catch (_) { setTimeout(install, 250); }
  };
  const sample = async connection => {
    if (connection.destroyed || !connection.conn) return { available: false };
    const method = connection.conn.getFilteredStats || connection.conn.getStats;
    if (typeof method !== "function") return { available: false };
    return await new Promise(resolve => {
      let done = false;
      let timer = null;
      const finish = raw => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve(normalize(raw));
      };
      timer = setTimeout(() => finish(null), 2000);
      try {
        const returned = method === connection.conn.getFilteredStats
          ? method.call(connection.conn, 2, finish)
          : method.call(connection.conn, finish);
        if (returned && typeof returned.then === "function") returned.then(finish, () => finish(null));
      } catch (_) { finish(null); }
    });
  };
  globalThis.__BIG_DUCKS_NATIVE_RTC_SUMMARY__ = async () => ({
    installed: state.installed, hooked: state.hooked,
    connections: await Promise.all(state.connections.map(async connection => ({
      kind: connection.kind, ageMs: Date.now() - connection.createdAt,
      destroyed: connection.destroyed, stats: await sample(connection)
    })))
  });
  install();
})();`;

function registerNativePreload() {
  const preloadPath = path.join(dataRoot, "native_rtc_probe.js");
  try { fs.writeFileSync(preloadPath, voicePreloadSource, { mode: 0o600 }); }
  catch (error) { console.error("[BIG DUCKS] native RTC preload write failed", error); return; }
  try {
    const target = session.defaultSession;
    if (typeof target.registerPreloadScript === "function") {
      void target.registerPreloadScript({ type: "frame", id: VOICE_PRELOAD_ID, filePath: preloadPath });
    } else if (typeof target.setPreloads === "function") {
      const preloads = typeof target.getPreloads === "function" ? target.getPreloads() : [];
      if (!preloads.includes(preloadPath)) target.setPreloads(preloads.concat(preloadPath));
    }
  } catch (error) { console.error("[BIG DUCKS] native RTC preload registration failed", error); }
}
```

The implementation must preserve the original function `this`, arguments, return value and exception behavior. The `getFilteredStats` path must call `getFilteredStats(2, callback)` and support both callback and Promise forms. Any raw return object is immediately normalized and discarded.

- [ ] **Step 4: Add main-world demand/socket probe and bridge polling**

Add an idempotent `installPageProbe(win)` called for every Discord client window on `browser-window-created` and `did-finish-load`. It must observe `Remote media sink wants:` via wrapped `console.log/info/debug`, record only `demandActive` and timestamp age, and mark only whether a `*.discord.media` WebSocket was seen. The bridge polls:

```js
win.webContents.executeJavaScriptInIsolatedWorld(
  VOICE_WORLD_ID,
  [{ code: "window.__BIG_DUCKS_NATIVE_RTC_SUMMARY__ ? window.__BIG_DUCKS_NATIVE_RTC_SUMMARY__() : null" }],
  true
)
```

Every 5 seconds, choose the client window with an active stream/voice connection and emit at most one `native_rtc_snapshot` per 30 seconds or on a classification-changing transition. The outgoing object contains only the fields from `NativeSnapshot`; no `session`, URL, host, stream key, user ID, guild ID, channel ID or SSRC value is sent.

- [ ] **Step 5: Run asset tests and syntax check**

Run: `node --check internal/bridge/assets/discord_bridge.js && go test ./internal/bridge -count=1`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/bridge/assets/discord_bridge.js internal/bridge/server_test.go
git commit -m "feat: probe native Discord voice media"
```

---

### Task 5: Connect native events to local media status and logs

**Files:**
- Modify: `internal/app/run.go`
- Modify: `internal/app/media.go`
- Modify: `internal/app/media_test.go`

- [ ] **Step 1: Write the failing conversion test**

Add this test to `internal/app/media_test.go` in package `app`:

```go
func TestReduceNativeMediaStoresOnlyBridgeAggregates(t *testing.T) {
    first := ReduceNativeMedia(MediaStatus{}, NativeMediaSample{
        DemandActive: true, StatsAvailable: true, HasAudioSSRC: true,
        AudioPackets: 10, VideoPackets: 0,
    })
    second := ReduceNativeMedia(first, NativeMediaSample{
        DemandActive: true, StatsAvailable: true, HasAudioSSRC: true,
        AudioPackets: 20, VideoPackets: 0,
    })
    if second.Native.AudioPackets != 20 || second.Native.VideoPackets != 0 {
        t.Fatalf("native aggregates = %#v", second.Native)
    }
}

// NativeMediaStatus deliberately has no Session field; the type check above is
// the complete contract used by the bridge-to-app conversion.
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/app -run TestReduceNativeMediaStoresOnlyBridgeAggregates -count=1`  
Expected: FAIL because `NativeMediaStatus` and `LastSession` do not exist.

- [ ] **Step 3: Wire only typed aggregates**

In `internal/app/run.go`, convert `bridge.NativeSnapshot` into `NativeMediaSample` and call `ReduceNativeMedia`. Keep the existing `ReduceMedia` path for legacy events. Log transitions with a safe line such as:

```go
logger.Printf("native media diagnostic: state=%s demand=%t stats=%t audio_packets=%d video_packets=%d decoded=%d receiver_count=%d", state, sample.DemandActive, sample.StatsAvailable, sample.AudioPackets, sample.VideoPackets, sample.FramesDecoded, sample.ReceiverCount)
```

Do not include `Session`, endpoint, SSRC, raw shape or errors from Discord. Do not call `Reconnect`, `Reload`, `CloseConnections` or any recovery method from this handler.

- [ ] **Step 4: Run the complete Go suite**

Run: `gofmt -w internal/app/run.go internal/app/media.go internal/app/media_test.go && go test ./...`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/app/run.go internal/app/media.go internal/app/media_test.go
git commit -m "feat: record native RTC diagnosis in core status"
```

---

### Task 6: Expose the safe diagnosis in the HUD

**Files:**
- Modify: `internal/hud/hud_windows.go`
- Modify: `internal/hud/assets/app.js`
- Modify: `internal/hud/assets/index.html`
- Modify: `internal/hud/hud_windows_test.go` or `internal/hud/close_windows_test.go`

- [ ] **Step 1: Write the failing HUD test**

```go
func TestStatusViewIncludesNativeMediaDiagnosis(t *testing.T) {
    status := app.RuntimeStatus{Media: app.MediaStatus{State: app.MediaNativeReceiverAudioOnly}}
    view := statusViewFromRuntime(status)
    if view.Media.State != string(app.MediaNativeReceiverAudioOnly) { t.Fatalf("media = %#v", view.Media) }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/hud -run TestStatusViewIncludesNativeMediaDiagnosis -count=1`  
Expected: FAIL because `StatusView` has no media field.

- [ ] **Step 3: Add the view field and safe rendering**

Add `Media app.MediaStatus json:"media"` to `StatusView` and populate it in `controller.status`. In `app.js`, add one line to the technical output:

```js
`diagnóstico RTC nativo: ${status.media?.state || "não informado"}`,
```

Add a short explanatory paragraph in `index.html`: “O diagnóstico nativo é somente leitura; nenhum SSRC ou identificador Discord é exibido.” Do not add controls that imply recovery.

- [ ] **Step 4: Run Windows-targeted tests**

Run: `GOOS=windows GOARCH=amd64 go test ./internal/hud ./internal/bridge`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/hud/hud_windows.go internal/hud/assets/app.js internal/hud/assets/index.html internal/hud/*_test.go
git commit -m "feat: show native RTC diagnosis in HUD"
```

---

### Task 7: Document reproduction and A/B evidence collection

**Files:**
- Create: `docs/native-rtc-diagnostics.md`
- Modify: `README.md`

- [ ] **Step 1: Write the documentation test/checklist**

Verify the document contains the exact commands:

```text
/v1/status
Abrir uma live com Discord 1.0.9255
Abrir a mesma live com Discord 1.0.9256
estado vanilla
estado injetado
```

- [ ] **Step 2: Write the reproduction guide**

Document:

1. enable only the existing BIG DUCKS protection, with automatic recovery disabled;
2. reproduce once as viewer and once as transmitter;
3. save `discordstream.log` and the native media state sequence;
4. compare `demandActive`, `receiverCount`, SSRC-presence booleans, packet counters and decoded frames;
5. repeat on 1.0.9255 and 1.0.9256, vanilla and injected;
6. interpret pre-packet, post-packet and post-decoder outcomes;
7. do not treat endpoint, PAC, region or proxy changes as a fix until the A/B result isolates them.

Document that logs may contain technical local details but the bridge payload is intentionally aggregate-only.

- [ ] **Step 3: Run documentation and repository checks**

Run: `git diff --check && rg -n "SSRC|receiverCount|framesDecoded|1\.0\.9255|1\.0\.9256" docs/native-rtc-diagnostics.md`  
Expected: `git diff --check` succeeds and all search terms are present.

- [ ] **Step 4: Commit**

```bash
git add docs/native-rtc-diagnostics.md README.md
git commit -m "docs: explain native RTC diagnosis workflow"
```

---

### Task 8: Final verification and explicit no-fix gate

**Files:**
- No source changes unless a verification failure identifies a concrete defect.

- [ ] **Step 1: Run formatting, tests and vet**

Run:

```bash
gofmt -w internal/bridge internal/app internal/hud
 go test ./...
go vet ./...
git diff --check
```

Expected: all commands exit 0 and `git diff --check` prints no output.

- [ ] **Step 2: Build Windows x64**

Run: `pwsh -NoProfile -File .\build.ps1 -Version 0.1.8 -OutputDirectory dist\diagnostic`  
Expected: the script generates `dist/diagnostic/BigDucks.exe` and prints a SHA-256 line.

- [ ] **Step 3: Verify the release asset contract**

Run: `node --check internal/bridge/assets/discord_bridge.js && git status --short`  
Expected: JavaScript syntax passes; only intentionally uncommitted release artifacts, if any, are shown.

If any verification command fails, stop before claiming completion, isolate the concrete failing behavior, add a red test, and make a separate corrective commit before rerunning the full gate.

Do not implement endpoint changes, proxy changes, codec changes, DAVE changes or automatic recovery in this plan. After a real reproduction produces the A/B evidence, create a separate design and plan for the smallest confirmed correction.
