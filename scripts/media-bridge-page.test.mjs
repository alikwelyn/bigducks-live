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

new Function(source)();

const media = globalThis.__BIG_DUCKS_MEDIA__;
if (!media) throw new Error("media bridge did not install");

const initial = media.summary();
if (initial.engine !== true) throw new Error("engine acquisition failed: " + JSON.stringify(initial));
if (initial.sinkHook !== true) throw new Error("addVideoOutputSink was not hooked");
if (initial.putImageDataHook !== true) throw new Error("putImageData was not hooked");

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
console.log(JSON.stringify({
  ok: true,
  enginePath: after.enginePath,
  substitutedFrames: after.substitutedFrames,
  sinkHookCalls: after.sinkHookCalls,
  nextFrame: next.width + "x" + next.height,
  disposeReinstall: true
}, null, 2));
