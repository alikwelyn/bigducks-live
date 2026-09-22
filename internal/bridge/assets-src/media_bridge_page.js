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

  if (globalThis.__BIG_DUCKS_MEDIA__) {
    return;
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
    webpackCache: null,
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
        voice.addVideoOutputSink = function (sinkId, streamId, frameCallback) {
          state.sinkHookCalls += 1;
          registerSink(sinkId, streamId);
          return originalAdd.apply(this, arguments);
        };
        state.sinkHook = true;
      }
      if (typeof voice.getNextVideoOutputFrame === "function") {
        const originalNext = voice.getNextVideoOutputFrame;
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
        voice.addDirectVideoOutputSink = function () {
          state.directVideo = true;
          state.directVideoCalls += 1;
          return originalDirect.apply(this, arguments);
        };
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

  function findMediaStore() {
    if (state.store) {
      return state.store;
    }
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
        return null;
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
            if (value && typeof value === "object" && typeof value.getMediaEngine === "function") {
              state.store = value;
              return;
            }
          }
        }
      ]);
    } catch (error) {
      state.lastError = String(error);
    }
    return state.store;
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

  function install() {
    installPutImageDataHook();
    const voice = acquireEngine();
    if (voice) {
      installEngineHooks(voice);
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
    rescan: install
  };
  globalThis.__BIG_DUCKS_MEDIA_SUMMARY__ = summary;

  install();
})();
