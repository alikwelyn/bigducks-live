"use strict";

if (!global.__discordStreamBridgeLoaded) {
  global.__discordStreamBridgeLoaded = true;

  const fs = require("fs");
  const net = require("net");
  const path = require("path");
  const { app, BrowserWindow, session } = require("electron");
  const Sentry = require("@sentry/electron/main");
  const { makeNodeTransport } = require("@sentry/node");

  const clientURL = /^https:\/\/(?:canary|ptb\.)?discord\.com\/(?:app|channels|login)/;
  const dataRoot = process.env.LOCALAPPDATA || app.getPath("userData");
  const BIG_DUCKS_RELEASE = __BIG_DUCKS_RELEASE__;
  const telemetryCachePath = path.join(dataRoot, "DiscordStream", "telemetry", "electron");
  const telemetryCodes = new Set([
    "bridge_failure", "audio_only", "video_stalled", "receiver_timeout",
    "rtc_disconnected", "native_probe_unavailable", "native_transmitter_stalled",
    "native_receiver_no_packets", "native_decoder_stalled", "native_render_unknown",
    "telemetry_test"
  ]);
  let telemetryEnabled = false;
  let telemetryReady = false;
  const telemetryLastSentAt = new Map();

  function safeRelease() {
    return /^\d+\.\d+\.\d+$/.test(BIG_DUCKS_RELEASE) ? BIG_DUCKS_RELEASE : "0.0.0";
  }

  function purgeElectronTelemetry() {
    try { fs.rmSync(telemetryCachePath, { recursive: true, force: true }); }
    catch (_) {}
  }

  function sanitizeElectronEvent(event) {
    if (!event || typeof event !== "object") return null;
    if (typeof event.message !== "string" || !/^bigducks\.(bridge|media)\.[a-z0-9_]+$/.test(event.message)) return null;
    event.request = undefined;
    event.user = undefined;
    event.breadcrumbs = undefined;
    event.exception = undefined;
    event.attachments = undefined;
    event.contexts = event.contexts && typeof event.contexts.diagnostic === "object"
      ? { diagnostic: event.contexts.diagnostic } : {};
    event.extra = undefined;
    event.tags = event.tags && typeof event.tags === "object" ? {
      component: typeof event.tags.component === "string" ? event.tags.component : "bridge",
      code: typeof event.tags.code === "string" && telemetryCodes.has(event.tags.code) ? event.tags.code : "bridge_failure"
    } : { component: "bridge" };
    return event;
  }

  function captureBridgeEvent(code, values) {
    if (!telemetryEnabled || !telemetryReady || !telemetryCodes.has(code)) return;
    if (code !== "telemetry_test") {
      const previous = telemetryLastSentAt.get(code) || 0;
      if (Date.now() - previous < 300000) return;
      telemetryLastSentAt.set(code, Date.now());
    }
    const diagnostic = {};
    if (values && typeof values === "object") {
      for (const key of ["operationFailed", "flushFailed", "connected", "nativeProbe"]) {
        if (typeof values[key] === "boolean") diagnostic[key] = values[key];
      }
    }
    try {
      Sentry.withScope(scope => {
        scope.setTag("component", "bridge");
        scope.setTag("code", code);
        scope.setContext("diagnostic", diagnostic);
        Sentry.captureMessage("bigducks.bridge." + code);
      });
    } catch (_) {}
  }

  function closeAndPurgeElectronTelemetry() {
    const closing = telemetryReady && typeof Sentry.close === "function" ? Sentry.close(2000) : Promise.resolve(true);
    telemetryReady = false;
    return Promise.resolve(closing).then(() => { purgeElectronTelemetry(); });
  }

  function configureTelemetry(enabled) {
    if (!enabled) {
      telemetryEnabled = false;
      return closeAndPurgeElectronTelemetry();
    }
    if (telemetryReady) {
      telemetryEnabled = true;
      return Promise.resolve();
    }
    try {
      fs.mkdirSync(telemetryCachePath, { recursive: true, mode: 0o700 });
      Sentry.init({
        dsn: "https://d6d3529330c54bad7b7f266b1d124580@o4512025900810240.ingest.us.sentry.io/4512025910444032",
        release: "bigducks-live@" + safeRelease(),
        sendDefaultPii: false,
        autoSessionTracking: false,
        enableAutoPerformanceTracking: false,
        integrations: [],
        getSessions: () => [],
        transport: makeNodeTransport,
        tracesSampleRate: 0,
        beforeSend: sanitizeElectronEvent
      });
      telemetryEnabled = true;
      telemetryReady = true;
      return Promise.resolve();
    } catch (error) {
      telemetryEnabled = false;
      telemetryReady = false;
      captureBridgeEvent("bridge_failure", { operationFailed: true });
      return Promise.reject(error);
    }
  }

  async function testElectronTelemetry(id) {
    if (!telemetryEnabled || !telemetryReady) return reply(id, false, "Telemetry is disabled");
    try {
      captureBridgeEvent("telemetry_test", { connected: true });
      const flushed = await Sentry.flush(2000);
      if (flushed === false) return reply(id, false, "Telemetry flush timed out");
      reply(id, true, "");
    } catch (_) {
      reply(id, false, "Telemetry test failed");
    }
  }

  async function disableElectronTelemetry(id) {
    try {
      await configureTelemetry(false);
      reply(id, true, "");
    } catch (_) {
      reply(id, false, "Telemetry disable failed");
    }
  }

  async function purgeElectronTelemetryCommand(id) {
    purgeElectronTelemetry();
    reply(id, true, "");
  }

  const controlPath = path.join(dataRoot, "DiscordStream", "bridge-control.json");
  let retryDelay = 500;
  let retryTimer = null;
  let socket = null;
  let buffer = "";
  let nativeProbeTimer = null;
  let nativeProbeRunning = false;
  let nativeLastSentAt = 0;
  let nativeLastSnapshot = null;
  const nativeWindows = new WeakSet();
  const nativeVoiceWorld = 999;
  const nativePreloadID = "big-ducks-native-rtc";

  const nativePreloadSource = `(() => {
    if (globalThis.__BIG_DUCKS_NATIVE_RTC_PROBE__) return;
    const state = { installed: false, hooked: false, nextId: 1, connections: [] };
    globalThis.__BIG_DUCKS_NATIVE_RTC_PROBE__ = state;
    const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
    const counter = value => {
      const result = finite(value);
      return result !== null && result >= 0 && result <= Number.MAX_SAFE_INTEGER ? result : null;
    };
    const has = value => value !== undefined && value !== null && value !== "";
    const asObject = raw => {
      if (typeof raw === "string") { try { return JSON.parse(raw); } catch (_) { return null; } }
      return raw && typeof raw === "object" ? raw : null;
    };
    const normalize = raw => {
      const root = asObject(raw);
      const candidates = [];
      const add = value => { if (value && typeof value === "object") candidates.push(value); };
      add(root);
      ["inbound", "outbound", "receiver", "received", "video", "audio", "screenshare"].forEach(key => add(root && root[key]));
      ["audio", "video"].forEach(kind => {
        ["inbound", "outbound", "receiver", "received", "video", "audio"].forEach(parent => add(root && root[parent] && root[parent][kind]));
      });
      const pick = keys => {
        for (const candidate of candidates) for (const key of keys) {
          if (candidate[key] !== undefined) return candidate[key];
        }
        return null;
      };
      return {
        available: root !== null,
        audioPackets: counter(pick(["audioPackets", "packetsReceivedAudio", "packetsReceived"])),
        videoPackets: counter(pick(["videoPackets", "packetsReceivedVideo", "packetsReceived"])),
        audioBytes: counter(pick(["audioBytes", "bytesReceivedAudio", "bytesReceived"])),
        videoBytes: counter(pick(["videoBytes", "bytesReceivedVideo", "bytesReceived"])),
        audioFrames: counter(pick(["audioFrames", "framesReceivedAudio"])),
        videoFrames: counter(pick(["videoFrames", "framesReceived", "framesReceivedVideo"])),
        captureFrames: counter(pick(["captureFrames", "inputFrames", "pipewireFrames", "x11Frames"])),
        encodedFrames: counter(pick(["encodedFrames", "framesEncoded"])),
        framesDecoded: counter(pick(["framesDecoded", "framesDecodedVideo"])),
        framesDropped: counter(pick(["framesDropped", "framesDroppedVideo"])),
        receiverCount: counter(pick(["receiverCount", "receivedReceiverCount"])),
        hasAudioSsrc: has(pick(["audioSsrc", "audioSSRC", "ssrcAudio"])),
        hasVideoSsrc: has(pick(["videoSsrc", "videoSSRC", "ssrcVideo", "ssrc"])),
        width: counter(pick(["width", "frameWidth"])),
        height: counter(pick(["height", "frameHeight"])),
        inputFPS: finite(pick(["inputFrameRate", "inputFPS"])),
        encodedFPS: finite(pick(["encodeFrameRate", "encodedFPS"]))
      };
    };
    const register = (kind, creator, connection) => {
      if (!connection || (typeof connection !== "object" && typeof connection !== "function")) return connection;
      if (state.connections.some(item => item.connection === connection)) return connection;
      const record = { id: state.nextId++, kind, creator, connection, createdAt: Date.now(), destroyed: false };
      state.connections.push(record);
      if (state.connections.length > 16) state.connections.shift();
      try {
        if (typeof connection.destroy === "function") {
          const destroy = connection.destroy;
          connection.destroy = function () { record.destroyed = true; return destroy.apply(this, arguments); };
        }
      } catch (_) {}
      return connection;
    };
    const hook = voice => {
      if (!voice || state.hooked) return voice;
      let found = false;
      ["createVoiceConnectionWithOptions", "createOwnStreamConnectionWithOptions"].forEach(name => {
        const original = voice[name];
        if (typeof original !== "function") return;
        found = true;
        voice[name] = function () {
          const kind = name === "createOwnStreamConnectionWithOptions" ? "stream" : "voice";
          return register(kind, name, original.apply(this, arguments));
        };
      });
      try {
        const OriginalVoiceConnection = voice.VoiceConnection;
        if (typeof OriginalVoiceConnection === "function") {
          function BigDucksVoiceConnection() {
            const instance = Reflect.construct(OriginalVoiceConnection, arguments, BigDucksVoiceConnection);
            if (!state.connections.some(item => item.connection === instance)) register("unknown", "VoiceConnection", instance);
            return instance;
          }
          Object.setPrototypeOf(BigDucksVoiceConnection, OriginalVoiceConnection);
          BigDucksVoiceConnection.prototype = OriginalVoiceConnection.prototype;
          voice.VoiceConnection = BigDucksVoiceConnection;
          found = true;
        }
      } catch (_) {}
      state.hooked = found;
      return voice;
    };
    const install = () => {
      try {
        const modules = window.DiscordNative && window.DiscordNative.nativeModules;
        if (!modules || typeof modules.requireModule !== "function") return setTimeout(install, 100);
        if (state.installed) return;
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
    const sample = async record => {
      if (record.destroyed || !record.connection) return { available: false };
      const method = record.kind === "stream"
        ? (record.connection.getFilteredStats || record.connection.getStats)
        : (record.connection.getStats || record.connection.getFilteredStats);
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
          const filtered = method === record.connection.getFilteredStats;
          const returned = filtered ? method.call(record.connection, 2, finish) : method.call(record.connection, finish);
          if (returned && typeof returned.then === "function") returned.then(finish, () => finish(null));
        } catch (_) { finish(null); }
      });
    };
    globalThis.__BIG_DUCKS_NATIVE_RTC_SUMMARY__ = async () => ({
      installed: state.installed,
      hooked: state.hooked,
      connections: await Promise.all(state.connections.map(async record => ({
        kind: record.kind,
        ageMs: Date.now() - record.createdAt,
        destroyed: record.destroyed,
        stats: await sample(record)
      })))
    });
    install();
  })();`;

  const pageProbeSource = `(() => {
    if (window.__BIG_DUCKS_PAGE_MEDIA_PROBE__) return;
    const state = { demandKnown: false, demandActive: false, demandAt: 0, mediaSocketAt: 0 };
    window.__BIG_DUCKS_PAGE_MEDIA_PROBE__ = state;
    const walk = value => {
      if (typeof value === "number") return value > 0;
      if (!value || typeof value !== "object") return false;
      return Object.values(value).some(walk);
    };
    const inspect = args => {
      try {
        const text = Array.from(args).filter(value => typeof value === "string").join(" ");
        const marker = "Remote media sink wants:";
        const at = text.indexOf(marker);
        if (at < 0) return;
        const payload = JSON.parse(text.slice(at + marker.length).trim());
        state.demandKnown = true;
        state.demandActive = walk(payload && (payload.pixelCounts || payload));
        if (state.demandActive) state.demandAt = Date.now();
      } catch (_) {}
    };
    ["log", "info", "debug"].forEach(method => {
      const original = console[method];
      if (typeof original !== "function") return;
      console[method] = function () { inspect(arguments); return original.apply(this, arguments); };
    });
    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === "function") {
      const BigDucksWebSocket = function () {
        try {
          const url = String(arguments[0] || "");
          if (new URL(url, location.href).hostname.endsWith(".discord.media")) state.mediaSocketAt = Date.now();
        } catch (_) {}
        return Reflect.construct(OriginalWebSocket, arguments, BigDucksWebSocket);
      };
      BigDucksWebSocket.prototype = OriginalWebSocket.prototype;
      Object.setPrototypeOf(BigDucksWebSocket, OriginalWebSocket);
      window.WebSocket = BigDucksWebSocket;
    }
    window.__BIG_DUCKS_PAGE_MEDIA_SUMMARY__ = () => ({
      demandKnown: state.demandKnown,
      demandActive: state.demandActive,
      demandAgeMs: state.demandAt ? Date.now() - state.demandAt : -1,
      mediaSocketSeen: state.mediaSocketAt > 0,
      mediaSocketAgeMs: state.mediaSocketAt ? Date.now() - state.mediaSocketAt : -1
    });
  })();`;

  function sendMessage(message) {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(JSON.stringify(message) + "\n");
      return true;
    } catch (_) {
      return false;
    }
  }

  function reply(id, ok, error, value) {
    if (!socket || socket.destroyed) return;
    socket.write(JSON.stringify({ type: "result", id, ok, error: error || "", value: value || "" }) + "\n");
  }

  const bridgeMediaEvents = new Map([
    ["stream-view-low-fps", "video_stalled"],
    ["video-stream-receiver-ready-timeout", "receiver_timeout"],
    ["audio-only", "audio_only"],
    ["rtc-disconnected", "rtc_disconnected"]
  ]);

  // Client patches can report media health without exposing the bridge socket.
  global.__BIG_DUCKS_REPORT_MEDIA_EVENT = function reportMediaEvent(event, session, native) {
    if (typeof event !== "string") return false;
    const code = bridgeMediaEvents.get(event);
    if (code) captureBridgeEvent(code, {});
    return sendMessage({
      type: "media_event",
      event,
      session: typeof session === "string" ? session : "",
      native: native && typeof native === "object" ? native : undefined,
      at: new Date().toISOString()
    });
  };

  function clientWindows() {
    return BrowserWindow.getAllWindows().filter(win => {
      try { return !win.isDestroyed() && clientURL.test(win.webContents.getURL()); }
      catch (_) { return false; }
    });
  }

  function installPageProbe(win) {
    if (!win || nativeWindows.has(win)) return;
    nativeWindows.add(win);
    const inject = () => {
      if (win.isDestroyed()) return;
      win.webContents.executeJavaScript(pageProbeSource, true).catch(() => {});
    };
    win.webContents.on("dom-ready", inject);
    win.webContents.on("did-finish-load", inject);
    inject();
  }

  function boundedCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function nativeWireSnapshot(summary, page) {
    const connections = Array.isArray(summary && summary.connections) ? summary.connections : [];
    const active = connections.filter(connection => connection && connection.destroyed !== true);
    active.sort((left, right) => (left.kind === "stream" ? 0 : 1) - (right.kind === "stream" ? 0 : 1));
    const connection = active[0] || null;
    const stats = connection && connection.stats && typeof connection.stats === "object" ? connection.stats : {};
    return {
      hooked: summary && summary.hooked === true,
      streamConnection: !!(connection && connection.kind === "stream"),
      statsAvailable: stats.available === true,
      demandActive: page && page.demandKnown === true ? page.demandActive === true : !!(connection && connection.kind === "stream"),
      hasAudioSsrc: stats.hasAudioSsrc === true,
      hasVideoSsrc: stats.hasVideoSsrc === true,
      audioPackets: boundedCount(stats.audioPackets),
      videoPackets: boundedCount(stats.videoPackets),
      audioBytes: boundedCount(stats.audioBytes),
      videoBytes: boundedCount(stats.videoBytes),
      audioFrames: boundedCount(stats.audioFrames),
      videoFrames: boundedCount(stats.videoFrames),
      captureFrames: boundedCount(stats.captureFrames),
      encodedFrames: boundedCount(stats.encodedFrames),
      framesDecoded: boundedCount(stats.framesDecoded),
      framesDropped: boundedCount(stats.framesDropped),
      receiverCount: boundedCount(stats.receiverCount),
      width: boundedCount(stats.width),
      height: boundedCount(stats.height),
      inputFPS: typeof stats.inputFPS === "number" && Number.isFinite(stats.inputFPS) && stats.inputFPS >= 0 ? stats.inputFPS : 0,
      encodedFPS: typeof stats.encodedFPS === "number" && Number.isFinite(stats.encodedFPS) && stats.encodedFPS >= 0 ? stats.encodedFPS : 0
    };
  }

  function nativeSignature(snapshot) {
    return [
      snapshot.hooked, snapshot.streamConnection, snapshot.statsAvailable,
      snapshot.demandActive, snapshot.hasAudioSsrc, snapshot.hasVideoSsrc,
      snapshot.receiverCount > 0, snapshot.videoPackets > 0, snapshot.framesDecoded > 0,
      snapshot.captureFrames > 0, snapshot.encodedFrames > 0
    ].join(":");
  }

  function sendNativeSnapshot(snapshot) {
    const now = Date.now();
    const signature = nativeSignature(snapshot);
    if (signature === nativeLastSnapshot && now - nativeLastSentAt < 30000) return;
    nativeLastSnapshot = signature;
    nativeLastSentAt = now;
    sendMessage({ type: "media_event", event: "native_rtc_snapshot", native: snapshot, at: new Date().toISOString() });
  }

  async function pollNativeRTC() {
    if (nativeProbeRunning) return;
    const windows = clientWindows();
    if (!windows.length) return;
    nativeProbeRunning = true;
    try {
      const results = await Promise.all(windows.map(async win => {
        try {
          const native = await win.webContents.executeJavaScriptInIsolatedWorld(
            nativeVoiceWorld,
            [{ code: "globalThis.__BIG_DUCKS_NATIVE_RTC_SUMMARY__ ? globalThis.__BIG_DUCKS_NATIVE_RTC_SUMMARY__() : null" }],
            true
          );
          const page = await win.webContents.executeJavaScript(
            "window.__BIG_DUCKS_PAGE_MEDIA_SUMMARY__ ? window.__BIG_DUCKS_PAGE_MEDIA_SUMMARY__() : null", true
          );
          return { native, page };
        } catch (_) { return null; }
      }));
      const result = results.find(value => value && value.native && value.native.hooked);
      if (result) sendNativeSnapshot(nativeWireSnapshot(result.native, result.page));
    } finally {
      nativeProbeRunning = false;
    }
  }

  function registerNativePreload() {
    const preloadPath = path.join(dataRoot, "native_rtc_probe.js");
    try {
      fs.mkdirSync(path.dirname(preloadPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(preloadPath, nativePreloadSource, { mode: 0o600 });
    } catch (error) {
      console.error("[BIG DUCKS] native RTC preload write failed", error);
      return;
    }
    try {
      const target = session.defaultSession;
      if (typeof target.registerPreloadScript === "function") {
        void target.registerPreloadScript({ type: "frame", id: nativePreloadID, filePath: preloadPath }).catch(() => {});
      } else if (typeof target.setPreloads === "function") {
        const preloads = typeof target.getPreloads === "function" ? target.getPreloads() : [];
        if (!preloads.includes(preloadPath)) target.setPreloads(preloads.concat(preloadPath));
      }
    } catch (error) {
      console.error("[BIG DUCKS] native RTC preload registration failed", error);
    }
  }

  async function closeConnections(id) {
    try {
      await session.defaultSession.closeAllConnections();
      reply(id, true, "");
    } catch (error) {
      captureBridgeEvent("bridge_failure", { operationFailed: true });
      reply(id, false, error instanceof Error ? error.message : String(error));
    }
  }

  async function resolveProxy(id, url) {
    try {
      if (typeof url !== "string" || !/^https:\/\//.test(url)) {
        return reply(id, false, "Invalid proxy resolution URL");
      }
      const value = await session.defaultSession.resolveProxy(url);
      reply(id, true, "", typeof value === "string" ? value : String(value));
    } catch (error) {
      captureBridgeEvent("bridge_failure", { operationFailed: true });
      reply(id, false, error instanceof Error ? error.message : String(error));
    }
  }

  function reloadClient(id) {
    try {
      const win = BrowserWindow.getAllWindows().find(candidate =>
        !candidate.isDestroyed() && clientURL.test(candidate.webContents.getURL())
      );
      if (!win) return reply(id, false, "Discord client window was not found");
      win.webContents.reload();
      reply(id, true, "");
    } catch (error) {
      captureBridgeEvent("bridge_failure", { operationFailed: true });
      reply(id, false, error instanceof Error ? error.message : String(error));
    }
  }

  function handleLine(line) {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message.type === "reload" && Number.isSafeInteger(message.id)) reloadClient(message.id);
      else if (message.type === "close_connections" && Number.isSafeInteger(message.id)) void closeConnections(message.id);
      else if (message.type === "resolve_proxy" && Number.isSafeInteger(message.id)) void resolveProxy(message.id, message.url);
      else if (message.type === "telemetry_sync") {
        void configureTelemetry(message.enabled === true).catch(() => {});
      } else if (message.type === "telemetry_test" && Number.isSafeInteger(message.id)) {
        void testElectronTelemetry(message.id);
      } else if (message.type === "telemetry_disable" && Number.isSafeInteger(message.id)) {
        void disableElectronTelemetry(message.id);
      } else if (message.type === "telemetry_purge" && Number.isSafeInteger(message.id)) {
        void purgeElectronTelemetryCommand(message.id);
      }
    } catch (_) {
      // Ignore malformed local messages and keep the bridge available.
    }
  }

  function scheduleReconnect() {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  }

  function connect() {
    let control;
    try {
      control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
      if (typeof control.address !== "string" || typeof control.token !== "string") {
        return scheduleReconnect();
      }
    } catch (_) {
      return scheduleReconnect();
    }

    const match = /^127\.0\.0\.1:(\d+)$/.exec(control.address);
    if (!match) return scheduleReconnect();
    buffer = "";
    socket = net.createConnection({ host: "127.0.0.1", port: Number(match[1]) });
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      retryDelay = 500;
      socket.write(JSON.stringify({ type: "hello", token: control.token }) + "\n");
    });
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    });
    socket.on("error", () => {
      captureBridgeEvent("bridge_failure", { operationFailed: true });
    });
    socket.on("close", () => {
      captureBridgeEvent("bridge_failure", { connected: false });
      socket = null;
      scheduleReconnect();
    });
  }

  app.whenReady().then(() => {
    registerNativePreload();
    for (const win of clientWindows()) installPageProbe(win);
    app.on("browser-window-created", (_event, win) => installPageProbe(win));
    nativeProbeTimer = setInterval(() => { void pollNativeRTC(); }, 5000);
    connect();
  }).catch(scheduleReconnect);
}
