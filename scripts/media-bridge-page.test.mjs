// Executable proof that the media bridge page logic actually takes over the
// frames Discord draws, without needing a live Discord session. It mocks the
// renderer surface the page relies on (ImageData, a 2D context prototype,
// document, DiscordNative) and asserts that putImageData is replaced.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "internal/bridge/assets-src/media_bridge_page.js"), "utf8");

const drawCalls = [];

class ImageData {
  constructor(data, width, height) {
    if (!data || data.length !== width * height * 4) throw new Error("bad ImageData size");
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class CanvasRenderingContext2D {
  putImageData(imageData, dx, dy) {
    drawCalls.push({ imageData, dx, dy });
  }
}

const fakeCanvas = {
  id: "sink1",
  width: 320,
  height: 180,
  __bigDucksSink: false,
  getContext() {
    return fakeContext;
  }
};

const fakeContext = Object.create(CanvasRenderingContext2D.prototype);
fakeContext.canvas = fakeCanvas;

const engine = {
  addVideoOutputSink() {},
  getNextVideoOutputFrame() {
    return Promise.resolve({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
  },
  addDirectVideoOutputSink() {}
};

const scope = {
  ImageData,
  CanvasRenderingContext2D,
  requestAnimationFrame() {},
  setTimeout,
  clearTimeout,
  document: {
    getElementById(id) {
      return id === "sink1" ? fakeCanvas : null;
    }
  },
  DiscordNative: {
    nativeModules: {
      requireModule(name) {
        return name === "discord_voice" ? engine : null;
      }
    }
  }
};

globalThis.ImageData = ImageData;
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.requestAnimationFrame = scope.requestAnimationFrame;
globalThis.document = scope.document;
globalThis.DiscordNative = scope.DiscordNative;
globalThis.window = globalThis;

// Discord's i18n messages proxy pretends to expose any name and throws when
// called. The store finder must skip it and pick the real Flux store.
const i18nProxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === "__esModule") return false;
    return () => {
      throw new Error("Requested message " + String(prop) + " does not have a value in the requested locale");
    };
  }
});
const engineConnections = new Set();
const realEngine = { connections: engineConnections, connectionsEmpty: () => engineConnections.size === 0 };
class FakeMediaEngineStore {
  getName() { return "MediaEngineStore"; }
  getGoLiveSource() { return null; }
  getMediaEngine() { return realEngine; }
  supports() { return false; }
  supportsInApp() { return false; }
  emitChange() {}
}
const realStore = new FakeMediaEngineStore();
const realExperimentStore = {
  getName: () => "ExperimentStore",
  getAllExperimentAssignments: () => ({ "exp-a": 1, "exp-b": 0 }),
  getGuildExperiments: () => ({ "7": 1 }),
  getRegisteredExperiments: () => ({ "exp-a": {}, "exp-b": {} })
};
const realConfigStore = {
  getConfig: options => ({ videoEnabled: false, location: options && options.location }),
  useConfig: () => ({ videoEnabled: false }),
  emitChange: () => {}
};
const mockRequire = { c: { "1": { exports: i18nProxy }, "2": { exports: realStore }, "3": { exports: { ExperimentStore: realExperimentStore } }, "4": { exports: realConfigStore } } };
globalThis.webpackChunkdiscord_app = {
  push(args) {
    args[2](mockRequire);
    return 1;
  }
};

new Function(source)();

const media = globalThis.__BIG_DUCKS_MEDIA__;
if (!media) throw new Error("media bridge did not install");

const initial = media.summary();
if (initial.engine !== true) throw new Error("engine acquisition failed: " + JSON.stringify(initial));
if (initial.sinkHook !== true) throw new Error("addVideoOutputSink was not hooked");
if (initial.putImageDataHook !== true) throw new Error("putImageData was not hooked");
if (initial.webpack.mediaEngineStore !== true) throw new Error("real MediaEngineStore was not found");
if (initial.connections.length !== 0) throw new Error("unexpected connections: " + JSON.stringify(initial.connections));
if (media.store() !== realStore) throw new Error("store() did not return the real store");
if (!initial.stores.includes("ExperimentStore") || !initial.stores.includes("MediaEngineStore")) {
  throw new Error("store discovery incomplete: " + JSON.stringify(initial.stores));
}
const foundExperiments = media.experiments();
if (foundExperiments.found !== true || foundExperiments.user["exp-a"] !== 1) {
  throw new Error("experiments() failed: " + JSON.stringify(foundExperiments));
}

// The Go Live unlock: canGoLive is supportsInApp(VIDEO) && supportsInApp(DESKTOP_CAPTURE).
if (media.status().goLivePatched !== true) throw new Error("Go Live gate was not patched");
if (realStore.supportsInApp("VIDEO") !== false) throw new Error("precondition failed: gate already open");
media.forceGoLive(true);
if (realStore.supportsInApp("VIDEO") !== true) throw new Error("forceGoLive did not unlock VIDEO");
if (realStore.supportsInApp("DESKTOP_CAPTURE") !== true) throw new Error("forceGoLive did not unlock DESKTOP_CAPTURE");
if (realStore.supports("VIDEO") !== true) throw new Error("forceGoLive did not unlock supports(VIDEO)");
if (realStore.supportsInApp("NOISE_SUPPRESSION") !== false) throw new Error("forceGoLive leaked to unrelated features");
if (media.status().configPatched !== true) throw new Error("config store was not patched");
if (realConfigStore.getConfig({ location: "handleScreenshareUnavailable" }).videoEnabled !== true) {
  throw new Error("forceGoLive did not unlock config videoEnabled");
}
if (media.status().forceGoLive !== true) throw new Error("forceGoLive flag not reported");
media.forceGoLive(false);
if (realStore.supportsInApp("VIDEO") !== false) throw new Error("forceGoLive(false) did not restore the gate");
if (realConfigStore.getConfig({ location: "x" }).videoEnabled !== false) throw new Error("forceGoLive(false) did not restore config");

// Simulate Discord registering the sink for a remote stream, then drawing a
// decoded frame. The bridge must have marked the canvas and must substitute it.
engine.addVideoOutputSink.call(engine, "sink1", "stream1", () => {});
media.setAutoTest(true);

const originalFrame = new ImageData(new Uint8ClampedArray(320 * 180 * 4), 320, 180);
fakeContext.putImageData(originalFrame, 0, 0);

if (drawCalls.length !== 1) throw new Error("expected one draw call, got " + drawCalls.length);
const drawn = drawCalls[0].imageData;
if (drawn === originalFrame) throw new Error("frame was not substituted");

// The bottom half of the middle scanline is the blurple marker.
const midRow = (drawn.height >> 1) * drawn.width;
let blurple = 0;
for (let x = 0; x < drawn.width; x++) {
  const i = (midRow + x) * 4;
  if (drawn.data[i] === 88 && drawn.data[i + 1] === 101 && drawn.data[i + 2] === 242) blurple += 1;
}
if (blurple !== drawn.width) throw new Error("test pattern scanline missing, got " + blurple);

const after = media.summary();
if (after.substitutedFrames < 1) throw new Error("substituted frame counter not updated");
if (after.sinkHookCalls < 1) throw new Error("sink registration not observed");
if (!after.sinks.some(sink => sink.sinkId === "sink1" && sink.canvas === true)) {
  throw new Error("sink canvas not tracked: " + JSON.stringify(after.sinks));
}

const next = await engine.getNextVideoOutputFrame("stream1");
if (next.width !== 1280 || next.height !== 720) {
  throw new Error("getNextVideoOutputFrame was not taken over: " + next.width + "x" + next.height);
}

// dispose must restore the original canvas hook so a new paste can install
// cleanly without reloading Discord.
media.dispose();
if (globalThis.__BIG_DUCKS_MEDIA__ !== undefined) throw new Error("dispose did not clear the API");
drawCalls.length = 0;
const rawFrame = new ImageData(new Uint8ClampedArray(4), 1, 1);
fakeContext.putImageData(rawFrame, 0, 0);
if (drawCalls.length !== 1 || drawCalls[0].imageData !== rawFrame) {
  throw new Error("dispose did not restore putImageData");
}

new Function(source)();
if (!globalThis.__BIG_DUCKS_MEDIA__) throw new Error("reinstall after dispose failed");
if (globalThis.__BIG_DUCKS_MEDIA__.status().engine !== true) {
  throw new Error("reinstalled bridge did not reacquire the engine");
}
if (globalThis.__BIG_DUCKS_MEDIA__.store() !== realStore) {
  throw new Error("reinstalled bridge lost the store");
}
console.log(JSON.stringify({
  ok: true,
  enginePath: after.enginePath,
  substitutedFrames: after.substitutedFrames,
  sinkHookCalls: after.sinkHookCalls,
  nextFrame: next.width + "x" + next.height,
  storeRejectedI18nProxy: true,
  disposeReinstall: true
}, null, 2));
