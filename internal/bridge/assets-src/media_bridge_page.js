// BIG DUCKS media bridge — renderer/page context spike.
//
// Goal: prove that the frames Discord draws for a remote Go Live stream can be
// taken over, so a peer-to-peer transport (orange) can feed the native Discord
// viewer instead of the SFU. This file is injected into the Discord renderer's
// main world by discord_bridge.js and is also safe to paste into Discord's
// DevTools console as a standalone probe:
//
//   paste this file, then run  __BIG_DUCKS_MEDIA__.setAutoTest(true)
//   open a Go Live stream and watch the canvas get replaced by a test pattern.
//
// Everything is defensive: a missing Discord internal is reported in the
// summary instead of throwing, so the bridge can always fail open.
(() => {
  "use strict";

  if (globalThis.__BIG_DUCKS_MEDIA__ && typeof globalThis.__BIG_DUCKS_MEDIA__.dispose === "function") {
    try {
      globalThis.__BIG_DUCKS_MEDIA__.dispose();
    } catch (_) {}
  }

  const state = {
    startedAt: new Date().toISOString(),
    voice: null,
    engine: false,
    enginePath: "",
    engineError: "",
    sinkHook: false,
    sinkHookCalls: 0,
    nextFrameCalls: 0,
    directVideoCalls: 0,
    putImageDataHook: false,
    repaintLoop: false,
    directVideo: false,
    testPattern: false,
    permissive: true,
    autoTest: false,
    observedFrames: 0,
    substitutedFrames: 0,
    repaintedFrames: 0,
    lastFrameAt: 0,
    lastError: "",
    store: null,
    stores: null,
    webpackCache: null,
    disposed: false,
    rescanned: false,
    srcObjectHook: false,
    viewerOverride: false,
    viewerStream: null,
    viewerSwaps: 0,
    auto: true,
    autoApplied: false,
    disableDave: true,
    xhrHook: false,
    experimentRewrites: 0,
    incomingVideoForced: false,
    videoGuardCleared: false,
    dispatcherFound: false,
    goLivePatched: false,
    goLiveError: "",
    enginePatched: false,
    configPatched: false,
    forceGoLive: false,
    forceCodec: null,
    originals: {},
    sinks: new Map()
  };

  let originalPutImageData = null;

  const patternCache = new Map();

  const BARS = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [24, 24, 24]
  ];

  function buildPattern(width, height) {
    const w = Math.max(2, Math.min((width | 0) || 1280, 4096));
    const h = Math.max(2, Math.min((height | 0) || 720, 2160));
    const key = w + "x" + h;
    const cached = patternCache.get(key);
    if (cached) {
      return cached;
    }
    let data;
    try {
      data = new Uint8ClampedArray(w * h * 4);
    } catch (error) {
      state.lastError = "pattern alloc: " + String(error);
      return null;
    }
    const barWidth = Math.max(1, Math.floor(w / BARS.length));
    for (let y = 0; y < h; y++) {
      const rowBase = y * w;
      for (let x = 0; x < w; x++) {
        const index = (rowBase + x) * 4;
        const bar = BARS[Math.min(BARS.length - 1, Math.floor(x / barWidth))];
        data[index] = bar[0];
        data[index + 1] = bar[1];
        data[index + 2] = bar[2];
        data[index + 3] = 255;
      }
    }
    // One Discord-blurple scanline in the middle so the replacement is obvious.
    const midY = (h >> 1) * w;
    for (let x = 0; x < w; x++) {
      const index = (midY + x) * 4;
      data[index] = 88;
      data[index + 1] = 101;
      data[index + 2] = 242;
      data[index + 3] = 255;
    }
    let image = null;
    try {
      image = new ImageData(data, w, h);
    } catch (_) {
      image = { width: w, height: h, data: data };
    }
    patternCache.set(key, image);
    return image;
  }

  function isSinkCanvas(canvas) {
    if (!canvas) {
      return false;
    }
    if (canvas.__bigDucksSink === true) {
      return true;
    }
    if (!state.permissive) {
      return false;
    }
    const w = canvas.width | 0;
    const h = canvas.height | 0;
    return w >= 320 && h >= 180;
  }

  function canvasForSink(sinkId) {
    try {
      const direct = document.getElementById(String(sinkId));
      if (direct) {
        return direct;
      }
    } catch (_) {}
    try {
      const popouts = window.popouts;
      if (popouts && typeof popouts.values === "function") {
        for (const popout of popouts.values()) {
          const found = popout && popout.document && popout.document.getElementById(String(sinkId));
          if (found) {
            return found;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function trackCanvas(canvas, sinkId, streamId) {
    if (!canvas) {
      return;
    }
    canvas.__bigDucksSink = true;
    canvas.__bigDucksStreamId = String(streamId);
    const record = state.sinks.get(String(sinkId));
    if (record) {
      record.canvas = true;
    }
    if (state.autoTest && !state.testPattern) {
      state.testPattern = true;
    }
    ensureRepaintLoop();
  }

  function registerSink(sinkId, streamId) {
    let record = state.sinks.get(String(sinkId));
    if (!record) {
      record = {
        sinkId: String(sinkId),
        streamId: String(streamId),
        frames: 0,
        lastAt: 0,
        canvas: false
      };
      state.sinks.set(String(sinkId), record);
    }
    const canvas = canvasForSink(sinkId);
    if (canvas) {
      trackCanvas(canvas, sinkId, streamId);
    }
    if (state.autoTest && !state.testPattern) {
      state.testPattern = true;
    }
    return record;
  }

  function installPutImageDataHook() {
    if (state.putImageDataHook) {
      return true;
    }
    const proto = globalThis.CanvasRenderingContext2D && globalThis.CanvasRenderingContext2D.prototype;
    if (!proto || typeof proto.putImageData !== "function") {
      return false;
    }
    originalPutImageData = proto.putImageData;
    state.originals.putImageData = proto.putImageData;
    proto.putImageData = function (imageData, dx, dy) {
      try {
        if (state.testPattern && isSinkCanvas(this.canvas)) {
          const record = this.canvas && state.sinks.get(String(this.canvas.id));
          if (record) {
            record.frames += 1;
            record.lastAt = Date.now();
          }
          state.observedFrames += 1;
          state.lastFrameAt = Date.now();
          const replacement = buildPattern(this.canvas ? this.canvas.width : 0, this.canvas ? this.canvas.height : 0);
          if (replacement) {
            state.substitutedFrames += 1;
            return originalPutImageData.call(this, replacement, dx, dy);
          }
        }
      } catch (error) {
        state.lastError = String(error);
      }
      return originalPutImageData.apply(this, arguments);
    };
    state.putImageDataHook = true;
    return true;
  }

  function ensureRepaintLoop() {
    if (state.repaintLoop) {
      return;
    }
    state.repaintLoop = true;
    const step = () => {
      if (state.disposed) {
        return;
      }
      if (state.testPattern && originalPutImageData) {
        for (const record of state.sinks.values()) {
          const canvas = canvasForSink(record.sinkId);
          if (!canvas || !canvas.width || !canvas.height) {
            continue;
          }
          try {
            const context = canvas.getContext("2d");
            if (!context) {
              continue;
            }
            const replacement = buildPattern(canvas.width, canvas.height);
            if (replacement) {
              originalPutImageData.call(context, replacement, 0, 0);
              state.repaintedFrames += 1;
              state.lastFrameAt = Date.now();
            }
          } catch (_) {}
        }
      }
      globalThis.requestAnimationFrame(step);
    };
    globalThis.requestAnimationFrame(step);
  }

  function installEngineHooks(voice) {
    if (!voice || state.engine) {
      return false;
    }
    try {
      if (typeof voice.addVideoOutputSink === "function") {
        const originalAdd = voice.addVideoOutputSink;
        state.originals.addVideoOutputSink = originalAdd;
        voice.addVideoOutputSink = function (sinkId, streamId, frameCallback) {
          state.sinkHookCalls += 1;
          registerSink(sinkId, streamId);
          return originalAdd.apply(this, arguments);
        };
        state.sinkHook = true;
      }
      if (typeof voice.getNextVideoOutputFrame === "function") {
        const originalNext = voice.getNextVideoOutputFrame;
        state.originals.getNextVideoOutputFrame = originalNext;
        voice.getNextVideoOutputFrame = function (streamId) {
          state.nextFrameCalls += 1;
          if (state.testPattern) {
            const frame = buildPattern(1280, 720);
            if (frame) {
              state.substitutedFrames += 1;
              return Promise.resolve({
                width: frame.width,
                height: frame.height,
                data: new Uint8ClampedArray(frame.data.buffer)
              });
            }
          }
          return originalNext.apply(this, arguments);
        };
      }
      if (typeof voice.addDirectVideoOutputSink === "function") {
        const originalDirect = voice.addDirectVideoOutputSink;
        state.originals.addDirectVideoOutputSink = originalDirect;
        voice.addDirectVideoOutputSink = function () {
          state.directVideo = true;
          state.directVideoCalls += 1;
          return originalDirect.apply(this, arguments);
        };
      }
      // DAVE (E2EE) is the last blocker for stream video: the sender encodes and
      // encrypts frames but the receiver has no cryptor, so video never arrives
      // and the 20s receiver timeout fires. Advertise protocol version 0 on new
      // voice/stream connections so media flows without E2EE.
      if (typeof voice.createVoiceConnectionWithOptions === "function") {
        const originalCreate = voice.createVoiceConnectionWithOptions;
        state.originals.createVoiceConnectionWithOptions = originalCreate;
        const createWrapper = function (userId, options, callback) {
          if (state.disableDave && options && typeof options === "object") {
            try {
              options.max_dave_protocol_version = 0;
            } catch (_) {}
          }
          return originalCreate.apply(this, arguments);
        };
        voice.createVoiceConnectionWithOptions = createWrapper;
        if (typeof voice.createOwnStreamConnectionWithOptions === "function") {
          voice.createOwnStreamConnectionWithOptions = createWrapper;
        }
      }
      state.voice = voice;
      state.engine = true;
      return true;
    } catch (error) {
      state.engineError = String(error);
      return false;
    }
  }

  function acquireEngine() {
    const candidates = [globalThis, globalThis.window];
    for (const scope of candidates) {
      try {
        const native = scope && scope.DiscordNative && scope.DiscordNative.nativeModules;
        if (native && typeof native.requireModule === "function") {
          const voice = native.requireModule("discord_voice");
          if (voice) {
            state.enginePath = "DiscordNative.nativeModules.requireModule";
            return voice;
          }
        }
      } catch (error) {
        state.engineError = String(error);
      }
    }
    return null;
  }

  function moduleKeys() {
    try {
      const voice = state.voice || acquireEngine();
      if (!voice) {
        return [];
      }
      return Object.keys(voice).filter(key => /stream|video|sink|frame|golive|desktop|render|image|direct/i.test(key));
    } catch (_) {
      return [];
    }
  }

  function storeName(value) {
    try {
      const proto = Object.getPrototypeOf(value);
      const hasOwnName = !!proto && Object.getOwnPropertyNames(proto).indexOf("getName") !== -1;
      const looksLikeStore = value && value.constructor && typeof value.constructor.name === "string" && /Store$/.test(value.constructor.name);
      if (!hasOwnName && !looksLikeStore) {
        return null;
      }
      return typeof value.getName === "function" ? value.getName() : null;
    } catch (_) {
      return null;
    }
  }

  function safeCall(value, method, argument) {
    try {
      if (!value || typeof value[method] !== "function") {
        return { ok: false };
      }
      return { ok: true, value: value[method](argument) };
    } catch (_) {
      return { ok: false };
    }
  }

  function candidateObjects(value) {
    const out = [];
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return out;
    }
    out.push(value);
    try {
      if (value.__esModule && value.default) {
        out.push(value.default);
      }
    } catch (_) {}
    let keys = [];
    try {
      keys = Object.keys(value);
    } catch (_) {}
    for (const key of keys) {
      let nested = null;
      try {
        nested = value[key];
      } catch (_) {
        continue;
      }
      if (nested && (typeof nested === "object" || typeof nested === "function") && nested !== value) {
        out.push(nested);
      }
    }
    return out;
  }

  const STORE_DEFS = [
    {
      name: "MediaEngineStore",
      match: function (value) {
        try {
          const proto = Object.getPrototypeOf(value);
          if (proto && typeof proto.supportsInApp === "function" && typeof proto.supports === "function" && typeof value.getMediaEngine === "function") {
            return true;
          }
        } catch (_) {}
        return false;
      }
    },
    {
      name: "ExperimentStore",
      match: function (value) {
        return storeName(value) === "ExperimentStore" ||
          (typeof value.getAllExperimentAssignments === "function" && typeof value.getGuildExperiments === "function" && safeCall(value, "getAllExperimentAssignments").ok);
      }
    },
    { name: "PermissionStore", match: function (value) { return storeName(value) === "PermissionStore"; } },
    { name: "ApplicationStreamingStore", match: function (value) { return storeName(value) === "ApplicationStreamingStore"; } },
    { name: "ChannelRTCStore", match: function (value) { return storeName(value) === "ChannelRTCStore"; } },
    { name: "RTCConnectionStore", match: function (value) { return storeName(value) === "RTCConnectionStore"; } },
    { name: "VoiceStateStore", match: function (value) { return storeName(value) === "VoiceStateStore"; } },
    { name: "CodecConnection", match: function (value) { try { const proto = typeof value === "function" ? value.prototype : Object.getPrototypeOf(value); return !!proto && typeof proto.getCodecOptions === "function"; } catch (_) { return false; } } },
    { name: "AppConfigStore", match: function (value) { return typeof value.useConfig === "function" && safeCall(value, "getConfig", { location: "handleScreenshareUnavailable" }).ok; } },
    { name: "WindowVisibilityVideoManager", match: function (value) { return storeName(value) === "WindowVisibilityVideoManager"; } },
    { name: "UserStore", match: function (value) { return storeName(value) === "UserStore"; } }
  ];

  function findStores() {
    if (state.stores) {
      return state.stores;
    }
    const found = {};
    try {
      const names = ["webpackChunkdiscord_app", "webpackChunkdiscord_desktop_core"];
      let chunk = null;
      for (const name of names) {
        if (globalThis[name] && typeof globalThis[name].push === "function") {
          chunk = globalThis[name];
          break;
        }
      }
      if (!chunk) {
        state.stores = found;
        return found;
      }
      chunk.push([
        [Symbol("bigducks-media")],
        {},
        (require) => {
          const cache = require && require.c;
          if (!cache) {
            return;
          }
          for (const id of Object.keys(cache)) {
            let value = null;
            try {
              const module = cache[id];
              value = module && module.exports;
              if (value && value.__esModule && value.default) {
                value = value.default;
              }
            } catch (_) {
              continue;
            }
            if (!value || typeof value !== "object") {
              continue;
            }
            for (const candidate of candidateObjects(value)) {
              for (const def of STORE_DEFS) {
                if (found[def.name]) {
                  continue;
                }
                try {
                  if (def.match(candidate)) {
                    found[def.name] = candidate;
                  }
                } catch (_) {}
              }
            }
          }
        }
      ]);
    } catch (error) {
      state.lastError = String(error);
    }
    state.stores = found;
    return found;
  }

  function findMediaStore() {
    return findStores().MediaEngineStore || null;
  }

  function collectConnections() {
    const out = [];
    try {
      const store = findMediaStore();
      if (!store) {
        return out;
      }
      const engine = store.getMediaEngine();
      if (!engine || !engine.connections) {
        return out;
      }
      const connectionSet = engine.connections;
      const list = typeof connectionSet[Symbol.iterator] === "function" ? Array.from(connectionSet) : [];
      for (const connection of list) {
        let methods = [];
        try {
          methods = Object.getOwnPropertyNames(Object.getPrototypeOf(connection) || {})
            .filter(key => /stream|video|sink|golive|desktop|frame|render/i.test(key));
        } catch (_) {}
        out.push({
          context: connection && connection.context,
          userId: connection && connection.userId,
          streamUserId: connection && connection.streamUserId,
          destroyed: connection && connection.destroyed === true,
          hasSetGoLiveSource: !!(connection && typeof connection.setGoLiveSource === "function"),
          hasSetStream: !!(connection && typeof connection.setStream === "function"),
          methods: methods
        });
      }
    } catch (error) {
      state.lastError = String(error);
    }
    return out;
  }

  function engineKeys() {
    try {
      const store = findMediaStore();
      if (!store) {
        return [];
      }
      const engine = store.getMediaEngine();
      return engine ? Object.keys(engine) : [];
    } catch (error) {
      state.lastError = String(error);
      return [];
    }
  }

  function experiments() {
    const out = { found: false, user: null, guild: null, registered: null, errors: [] };
    try {
      const store = findStores().ExperimentStore;
      if (!store) {
        out.errors.push("ExperimentStore not found");
        return out;
      }
      out.found = true;
      try {
        out.user = store.getAllExperimentAssignments();
      } catch (error) {
        out.errors.push("user: " + String(error));
      }
      try {
        out.guild = store.getGuildExperiments();
      } catch (error) {
        out.errors.push("guild: " + String(error));
      }
      try {
        const registered = store.getRegisteredExperiments();
        out.registered = registered ? Object.keys(registered) : null;
      } catch (error) {
        out.errors.push("registered: " + String(error));
      }
    } catch (error) {
      out.errors.push(String(error));
    }
    return out;
  }

  function experimentNames() {
    const out = {};
    try {
      const store = findStores().ExperimentStore;
      if (!store) {
        return out;
      }
      const assignments = store.getAllExperimentAssignments() || {};
      let registered = {};
      try {
        registered = store.getRegisteredExperiments() || {};
      } catch (_) {}
      for (const id of Object.keys(assignments)) {
        const descriptor = registered[id] || {};
        out[id] = {
          bucket: assignments[id],
          name: descriptor.name || descriptor.description || null,
          kind: descriptor.kind || null
        };
      }
    } catch (error) {
      state.lastError = String(error);
    }
    return out;
  }

  function callStats(connection) {
    return new Promise((resolve) => {
      try {
        if (!connection || typeof connection.getStats !== "function") {
          resolve(null);
          return;
        }
        let done = false;
        const finish = (value) => {
          if (!done) {
            done = true;
            resolve(value || null);
          }
        };
        setTimeout(() => finish(null), 3000);
        if (connection.getStats.length === 0) {
          const returned = connection.getStats();
          if (returned && typeof returned.then === "function") {
            returned.then(finish, () => finish(null));
          } else {
            finish(returned);
          }
        } else {
          connection.getStats(finish);
        }
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function rtcStats() {
    const out = { rtc: null, connections: [], errors: [] };
    try {
      const store = findStores().RTCConnectionStore;
      if (store) {
        const pick = (name) => {
          try {
            return typeof store[name] === "function" ? store[name]() : null;
          } catch (_) {
            return null;
          }
        };
        out.rtc = {
          hostname: pick("getHostname"),
          quality: pick("getQuality"),
          mediaSessionId: pick("getMediaSessionId"),
          connected: pick("isConnected"),
          packetStats: pick("getPacketStats"),
          voiceStateStats: pick("getVoiceStateStats"),
          lastVideoSinkWantAt: pick("getLastNonZeroRemoteVideoSinkWantsTime")
        };
      }
    } catch (error) {
      out.errors.push("rtc: " + String(error));
    }
    try {
      const store = findStores().MediaEngineStore;
      const engine = store ? store.getMediaEngine() : null;
      const list = engine && engine.connections ? Array.from(engine.connections) : [];
      for (const connection of list) {
        const stats = await callStats(connection);
        out.connections.push({
          context: connection && connection.context,
          streamUserId: connection && connection.streamUserId,
          destroyed: connection && connection.destroyed,
          stats: stats
        });
      }
    } catch (error) {
      out.errors.push("connections: " + String(error));
    }
    return out;
  }

  function rescanStores() {
    state.stores = null;
    return findStores();
  }

  function findCodecPrototype() {
    let connection = findStores().CodecConnection;
    if (!connection && !state.rescanned) {
      state.rescanned = true;
      rescanStores();
      connection = findStores().CodecConnection;
    }
    try {
      if (connection) {
        const proto = typeof connection === "function" ? connection.prototype : Object.getPrototypeOf(connection);
        if (proto && typeof proto.getCodecOptions === "function") {
          return proto;
        }
      }
    } catch (_) {}
    try {
      const store = findStores().MediaEngineStore;
      const engine = store ? store.getMediaEngine() : null;
      const list = engine && engine.connections ? Array.from(engine.connections) : [];
      for (const conn of list) {
        const proto = Object.getPrototypeOf(conn);
        if (proto && typeof proto.getCodecOptions === "function") {
          return proto;
        }
      }
    } catch (_) {}
    return null;
  }

  function setVideoCodec(name) {
    state.forceCodec = name || null;
    const out = { requested: state.forceCodec, settings: null, codecHook: false };
    try {
      const store = findStores().MediaEngineStore;
      if (store) {
        if (state.forceCodec === "H264") {
          if (typeof store.setH265Enabled === "function") store.setH265Enabled(false);
          if (typeof store.setH264Enabled === "function") store.setH264Enabled(true);
          out.settings = "H264";
        } else if (state.forceCodec === "H265") {
          if (typeof store.setH265Enabled === "function") store.setH265Enabled(true);
          out.settings = "H265";
        }
      }
    } catch (_) {}
    try {
      const proto = findCodecPrototype();
      if (proto) {
        if (!state.originals.getCodecOptions) {
          state.originals.getCodecOptions = proto.getCodecOptions;
          proto.getCodecOptions = function () {
            const result = state.originals.getCodecOptions.apply(this, arguments);
            try {
              if (state.forceCodec && result && Array.isArray(result.videoDecoders)) {
                const match = result.videoDecoders.find(function (codec) {
                  return codec && (codec.name === state.forceCodec || codec.codec === state.forceCodec);
                });
                if (match) result.videoEncoder = match;
              }
            } catch (_) {}
            return result;
          };
        }
        out.codecHook = true;
      }
    } catch (_) {}
    return out;
  }

  function scanWebpack() {
    if (state.webpackCache) {
      return state.webpackCache;
    }
    const store = findMediaStore();
    state.webpackCache = {
      mediaEngineStore: !!store,
      chunks: store ? 1 : 0
    };
    return state.webpackCache;
  }

  const GOLIVE_FEATURES = ["VIDEO", "DESKTOP_CAPTURE", "HYBRID_VIDEO", "ELECTRON_VIDEO"];

  // The Go Live button is gated by
  //   canGoLive = supportsInApp(VIDEO) && supportsInApp(DESKTOP_CAPTURE)
  // and supportsInApp(VIDEO) resolves to the remote-config
  //   getConfig({ location: "MediaEngineStore.supportsInApp" }).videoEnabled
  // plus the engine's appSupported flags. Forcing those two methods to report
  // support for the video features is the whole client-side unlock.
  function patchMediaEngineStore() {
    if (state.goLivePatched) {
      return true;
    }
    const store = findStores().MediaEngineStore;
    if (!store) {
      state.goLiveError = "MediaEngineStore not found";
      return false;
    }
    const proto = Object.getPrototypeOf(store);
    if (!proto) {
      state.goLiveError = "MediaEngineStore prototype missing";
      return false;
    }
    let patched = false;
    for (const method of ["supports", "supportsInApp"]) {
      try {
        const original = proto[method];
        if (typeof original !== "function") {
          continue;
        }
        state.originals[method] = original;
        proto[method] = function (feature) {
          if (state.forceGoLive && GOLIVE_FEATURES.indexOf(feature) !== -1) {
            return true;
          }
          return original.apply(this, arguments);
        };
        patched = true;
      } catch (_) {}
    }
    state.goLivePatched = patched;
    state.goLiveError = patched ? "" : "supports methods not found on prototype";
    return patched;
  }

  function patchConfigStore() {
    if (state.configPatched) {
      return true;
    }
    const store = findStores().AppConfigStore;
    if (!store) {
      return false;
    }
    let holder = store;
    let original = store.getConfig;
    if (typeof original !== "function") {
      const proto = Object.getPrototypeOf(store);
      if (proto && typeof proto.getConfig === "function") {
        holder = proto;
        original = proto.getConfig;
      } else {
        return false;
      }
    }
    state.originals.configGetConfig = { holder: holder, original: original };
    holder.getConfig = function (options) {
      const result = original.call(this, options);
      if (state.forceGoLive && result && typeof result === "object" && result.videoEnabled === false) {
        return Object.assign({}, result, { videoEnabled: true });
      }
      return result;
    };
    state.configPatched = true;
    return true;
  }

  // The native media engine keeps its own appSupported set. Forcing the JS
  // store is not always enough: the encoder pipeline asks the engine too.
  function patchMediaEngine() {
    if (state.enginePatched) {
      return true;
    }
    const store = findStores().MediaEngineStore;
    const engine = store ? store.getMediaEngine() : null;
    if (!engine) {
      return false;
    }
    let patched = false;
    for (const method of ["supports", "supportsInApp"]) {
      try {
        if (typeof engine[method] !== "function") {
          continue;
        }
        const original = engine[method];
        state.originals["engine." + method] = { target: engine, original: original };
        engine[method] = function (feature) {
          if (state.forceGoLive && GOLIVE_FEATURES.indexOf(feature) !== -1) {
            return true;
          }
          return original.apply(this, arguments);
        };
        patched = true;
      } catch (_) {}
    }
    state.enginePatched = patched;
    return patched;
  }

  function forceGoLive(enabled) {
    state.forceGoLive = enabled !== false;
    patchMediaEngineStore();
    patchMediaEngine();
    patchConfigStore();
    try {
      const config = findStores().AppConfigStore;
      if (config && typeof config.emitChange === "function") {
        config.emitChange();
      }
    } catch (_) {}
    try {
      const store = findStores().MediaEngineStore;
      if (store && typeof store.emitChange === "function") {
        store.emitChange();
      }
    } catch (_) {}
    return summary();
  }

  function makeTestStream() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      const bars = ["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff", "#181818"];
      let frame = 0;
      const draw = () => {
        if (state.disposed || !state.viewerOverride) {
          return;
        }
        const w = canvas.width;
        const h = canvas.height;
        const bw = w / bars.length;
        for (let i = 0; i < bars.length; i++) {
          ctx.fillStyle = bars[i];
          ctx.fillRect(i * bw, 0, bw + 1, h);
        }
        ctx.fillStyle = "#5865f2";
        ctx.fillRect(0, (h >> 1) - 4, w, 8);
        ctx.fillStyle = "#000000";
        ctx.font = "48px monospace";
        ctx.fillText("BIG DUCKS " + frame, 40, h - 40);
        frame += 1;
        requestAnimationFrame(draw);
      };
      draw();
      return canvas.captureStream ? canvas.captureStream(30) : null;
    } catch (error) {
      state.lastError = String(error);
      return null;
    }
  }

  // Discord's desktop viewer uses a native DirectVideo path: it creates a
  // <video> and assigns srcObject. Swapping that MediaStream lets us feed the
  // viewer from our own transport even when the native video pipeline is
  // blocked.
  function installSrcObjectHook() {
    if (state.srcObjectHook) {
      return true;
    }
    const proto = globalThis.HTMLMediaElement && globalThis.HTMLMediaElement.prototype;
    if (!proto) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, "srcObject");
    if (!descriptor || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") {
      return false;
    }
    state.originals.srcObject = descriptor;
    Object.defineProperty(proto, "srcObject", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function () {
        return descriptor.get.call(this);
      },
      set: function (value) {
        if (state.viewerOverride && state.viewerStream && this && this.tagName === "VIDEO") {
          state.viewerSwaps += 1;
          return descriptor.set.call(this, state.viewerStream);
        }
        return descriptor.set.call(this, value);
      }
    });
    state.srcObjectHook = true;
    return true;
  }

  function injectTestStream() {
    const hook = installSrcObjectHook();
    state.viewerOverride = true;
    if (!state.viewerStream) {
      state.viewerStream = makeTestStream();
    }
    let swapped = 0;
    try {
      for (const video of document.querySelectorAll("video")) {
        if (video.srcObject) {
          video.srcObject = video.srcObject;
          swapped += 1;
        }
      }
    } catch (_) {}
    return { ok: !!state.viewerStream, hook: hook, swaps: state.viewerSwaps, existing: swapped };
  }

  function stopTestStream() {
    state.viewerOverride = false;
    state.viewerStream = null;
    return { ok: true, swaps: state.viewerSwaps };
  }

  // The real gate: the server assigns the "2026-08-video-guard" user
  // experiment (variations 1 and 2 set videoEnabled:false) to Brazilian
  // accounts. Neutralize the assignment at the source by overriding it on
  // the Flux dispatcher, then clear the experiment's blocking variations.
  const VIDEO_GUARD = "2026-08-video-guard";

  function findFluxDispatcher() {
    try {
      const chunk = globalThis.webpackChunkdiscord_app;
      if (!chunk || typeof chunk.push !== "function") {
        return null;
      }
      const require = chunk.push([[Symbol("bigducks-dispatcher")], {}, (r) => r]);
      try {
        chunk.pop();
      } catch (_) {}
      const cache = require && require.c;
      if (!cache) {
        return null;
      }
      for (const id of Object.keys(cache)) {
        let exports = null;
        try {
          exports = cache[id] && cache[id].exports;
        } catch (_) {
          continue;
        }
        if (!exports || typeof exports !== "object") {
          continue;
        }
        for (const value of Object.values(exports)) {
          if (value && typeof value === "object" && typeof value.dispatch === "function" && value._actionHandlers && value._actionHandlers._orderedActionHandlers) {
            return value;
          }
        }
      }
    } catch (error) {
      state.lastError = String(error);
    }
    return null;
  }

  // The block ships as an Apex experiment fetched over HTTP:
  //   GET /apex/experiments  ->  { installation, "2026-08-video-guard": {variantId: 2}, ... }
  // Rewriting the response at the transport level neutralizes it before any
  // consumer (JS store and native media engine) reads the assignment.
  function rewriteApexExperiments(text) {
    if (!text) {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      if (!("2026-08-video-guard" in parsed)) {
        return null;
      }
      parsed["2026-08-video-guard"] = { variantId: 0 };
      state.experimentRewrites += 1;
      return JSON.stringify(parsed);
    } catch (_) {
      return null;
    }
  }

  function installExperimentsRewrite() {
    if (state.xhrHook) {
      return true;
    }
    const Original = globalThis.XMLHttpRequest;
    if (!Original) {
      return false;
    }
    function BigDucksXHR() {
      const xhr = new Original();
      try {
        let url = "";
        const open = xhr.open;
        xhr.open = function (method, target) {
          url = String(target);
          return open.apply(this, arguments);
        };
        xhr.addEventListener("readystatechange", function () {
          if (xhr.readyState !== 4) {
            return;
          }
          if (!/\/apex\/experiments(\?|$)/.test(url)) {
            return;
          }
          try {
            const rewritten = rewriteApexExperiments(xhr.responseText);
            if (rewritten != null) {
              Object.defineProperty(xhr, "responseText", { configurable: true, get: function () { return rewritten; } });
              Object.defineProperty(xhr, "response", { configurable: true, get: function () { return rewritten; } });
            }
          } catch (_) {}
        });
      } catch (_) {}
      return xhr;
    }
    BigDucksXHR.prototype = Original.prototype;
    try {
      Object.setPrototypeOf(BigDucksXHR, Original);
    } catch (_) {}
    globalThis.XMLHttpRequest = BigDucksXHR;
    state.originals.XMLHttpRequest = Original;
    state.xhrHook = true;
    return true;
  }

  function neutralizeVideoGuard() {
    try {
      const dispatcher = state.dispatcher || findFluxDispatcher();
      if (!dispatcher) {
        return false;
      }
      state.dispatcher = dispatcher;
      state.dispatcherFound = true;
      dispatcher.dispatch({ type: "APEX_EXPERIMENT_SESSION_OVERRIDE_CREATE", experimentName: VIDEO_GUARD, variantId: 0 });
      dispatcher.dispatch({ type: "APEX_EXPERIMENT_OVERRIDE_CREATE", experimentName: VIDEO_GUARD, variantId: 0 });
      state.videoGuardCleared = true;
      return true;
    } catch (error) {
      state.lastError = String(error);
      return false;
    }
  }

  // Discord's WindowVisibilityVideoManager stops incoming video when the
  // window is not visible, which starves the stream receiver and produces the
  // 20s receiver timeout (error 2012). Keep incoming video enabled.
  function forceIncomingVideo() {
    const store = findStores().WindowVisibilityVideoManager;
    if (!store) {
      return false;
    }
    state.incomingVideoForced = true;
    let patched = false;
    try {
      const proto = Object.getPrototypeOf(store) || {};
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (!/incomingVideo/i.test(name) || typeof proto[name] !== "function") {
          continue;
        }
        if (state.originals["wv." + name]) {
          continue;
        }
        const original = proto[name];
        state.originals["wv." + name] = { target: proto, original: original };
        proto[name] = function () {
          const result = original.apply(this, arguments);
          if (typeof result === "boolean") {
            return true;
          }
          return result;
        };
        patched = true;
      }
    } catch (_) {}
    return patched;
  }

  function applyAuto() {
    if (!state.auto) {
      return;
    }
    try {
      neutralizeVideoGuard();
    } catch (_) {}
    try {
      installExperimentsRewrite();
    } catch (_) {}
    try {
      forceIncomingVideo();
    } catch (_) {}
    try {
      forceGoLive(true);
    } catch (_) {}
    try {
      setVideoCodec("H264");
    } catch (_) {}
  }

  function install() {
    installPutImageDataHook();
    installSrcObjectHook();
    const voice = acquireEngine();
    if (voice) {
      installEngineHooks(voice);
    }
    patchMediaEngineStore();
    patchMediaEngine();
    patchConfigStore();
    neutralizeVideoGuard();
    installExperimentsRewrite();
    if (!state.autoApplied) {
      state.autoApplied = true;
      applyAuto();
    }
    ensureRepaintLoop();
    if (!state.engine && !state.retryTimer) {
      state.retryTimer = globalThis.setTimeout(() => {
        state.retryTimer = null;
        install();
      }, 2000);
    }
    return summary();
  }

  function listSinks() {
    const out = [];
    for (const record of state.sinks.values()) {
      const canvas = canvasForSink(record.sinkId);
      out.push({
        sinkId: record.sinkId,
        streamId: record.streamId,
        frames: record.frames,
        lastAt: record.lastAt,
        canvas: !!canvas,
        width: canvas ? canvas.width : 0,
        height: canvas ? canvas.height : 0
      });
    }
    return out;
  }

  function dispose() {
    state.disposed = true;
    state.viewerOverride = false;
    try {
      if (state.originals.XMLHttpRequest) {
        globalThis.XMLHttpRequest = state.originals.XMLHttpRequest;
      }
    } catch (_) {}
    try {
      const mediaProto = globalThis.HTMLMediaElement && globalThis.HTMLMediaElement.prototype;
      if (mediaProto && state.originals.srcObject) {
        Object.defineProperty(mediaProto, "srcObject", state.originals.srcObject);
      }
    } catch (_) {}
    try {
      const proto = globalThis.CanvasRenderingContext2D && globalThis.CanvasRenderingContext2D.prototype;
      if (proto && typeof state.originals.putImageData === "function") {
        proto.putImageData = state.originals.putImageData;
      }
    } catch (_) {}
    const voice = state.voice;
    if (voice) {
      for (const name of ["addVideoOutputSink", "getNextVideoOutputFrame", "addDirectVideoOutputSink", "createVoiceConnectionWithOptions"]) {
        try {
          if (typeof state.originals[name] === "function") {
            voice[name] = state.originals[name];
          }
        } catch (_) {}
      }
    }
    try {
      for (const key of Object.keys(state.originals)) {
        if (key.indexOf("wv.") === 0) {
          const record = state.originals[key];
          if (record && record.target) {
            record.target[key.slice(3)] = record.original;
          }
        }
      }
    } catch (_) {}
    try {
      for (const key of ["engine.supports", "engine.supportsInApp"]) {
        const record = state.originals[key];
        if (record && record.target) {
          record.target[key.split(".")[1]] = record.original;
        }
      }
    } catch (_) {}
    try {
      const codecOriginal = state.originals.getCodecOptions;
      const proto = findCodecPrototype();
      if (proto && typeof codecOriginal === "function") {
        proto.getCodecOptions = codecOriginal;
      }
    } catch (_) {}
    try {
      const configOriginal = state.originals.configGetConfig;
      if (configOriginal && configOriginal.holder) {
        configOriginal.holder.getConfig = configOriginal.original;
      }
    } catch (_) {}
    try {
      const store = findStores().MediaEngineStore;
      const proto = store ? Object.getPrototypeOf(store) : null;
      if (proto) {
        for (const method of ["supports", "supportsInApp"]) {
          if (typeof state.originals[method] === "function") {
            proto[method] = state.originals[method];
          }
        }
      }
    } catch (_) {}
    try {
      delete globalThis.__BIG_DUCKS_MEDIA__;
      delete globalThis.__BIG_DUCKS_MEDIA_SUMMARY__;
    } catch (_) {}
    return { disposed: true };
  }

  function summary() {
    return {
      version: 2,
      engine: state.engine,
      enginePath: state.enginePath,
      engineError: state.engineError,
      sinkHook: state.sinkHook,
      sinkHookCalls: state.sinkHookCalls,
      nextFrameCalls: state.nextFrameCalls,
      directVideoCalls: state.directVideoCalls,
      putImageDataHook: state.putImageDataHook,
      repaintLoop: state.repaintLoop,
      directVideo: state.directVideo,
      testPattern: state.testPattern,
      permissive: state.permissive,
      autoTest: state.autoTest,
      observedFrames: state.observedFrames,
      substitutedFrames: state.substitutedFrames,
      repaintedFrames: state.repaintedFrames,
      lastFrameAt: state.lastFrameAt,
      lastError: state.lastError,
      moduleKeys: moduleKeys(),
      engineKeys: engineKeys(),
      stores: Object.keys(findStores()),
      srcObjectHook: state.srcObjectHook,
      viewerOverride: state.viewerOverride,
      viewerSwaps: state.viewerSwaps,
      auto: state.auto,
      videoGuardCleared: state.videoGuardCleared,
      dispatcherFound: state.dispatcherFound,
      incomingVideoForced: state.incomingVideoForced === true,
      disableDave: state.disableDave === true,
      xhrHook: state.xhrHook === true,
      experimentRewrites: state.experimentRewrites,
      goLivePatched: state.goLivePatched,
      goLiveError: state.goLiveError,
      enginePatched: state.enginePatched,
      configPatched: state.configPatched,
      forceGoLive: state.forceGoLive,
      webpack: scanWebpack(),
      connections: collectConnections(),
      sinks: listSinks()
    };
  }

  globalThis.__BIG_DUCKS_MEDIA__ = {
    version: 2,
    status: summary,
    summary: summary,
    listSinks: listSinks,
    enableTestPattern: () => {
      state.testPattern = true;
      ensureRepaintLoop();
      return summary();
    },
    disableTestPattern: () => {
      state.testPattern = false;
      return summary();
    },
    setAutoTest: (enabled) => {
      state.autoTest = enabled !== false;
      if (state.autoTest) {
        state.testPattern = true;
        ensureRepaintLoop();
      }
      return summary();
    },
    setPermissive: (enabled) => {
      state.permissive = enabled !== false;
      return summary();
    },
    dispose: dispose,
    stores: () => Object.keys(findStores()),
    experiments: experiments,
    experimentNames: experimentNames,
    rtcStats: rtcStats,
    setVideoCodec: setVideoCodec,
    injectTestStream: injectTestStream,
    stopTestStream: stopTestStream,
    neutralizeVideoGuard: neutralizeVideoGuard,
    forceIncomingVideo: forceIncomingVideo,
    rewriteExperiments: installExperimentsRewrite,
    setDisableDave: (enabled) => {
      state.disableDave = enabled !== false;
      return summary();
    },
    setAuto: (enabled) => {
      state.auto = enabled !== false;
      if (state.auto) {
        applyAuto();
      }
      return summary();
    },
    forceGoLive: forceGoLive,
    store: () => findMediaStore(),
    engine: () => {
      try {
        const store = findMediaStore();
        return store ? store.getMediaEngine() : null;
      } catch (_) {
        return null;
      }
    },
    connections: collectConnections,
    rescan: install
  };
  globalThis.__BIG_DUCKS_MEDIA_SUMMARY__ = summary;

  install();
})();
