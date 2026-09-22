// Experimental Go Live sender.
//
// What it does: logs in as a normal user account, joins a voice channel and
// pushes a real Discord Go Live stream (same STREAM_CREATE / DAVE / RTP flow the
// desktop client uses). Native Discord clients in that channel watch it like any
// other Go Live.
//
// Why it matters: it never reads the Apex `videoEnabled` experiment, so the
// Brazilian region gate that hides the Go Live button does not apply to it.
// If this works from Brazil with NO proxy, the block is client-side only.
//
// Run it with start.cmd (double-click) or `node sender.mjs`.
// Stop it with Ctrl+C.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, "config.json");

const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

// BigDucks writes %LOCALAPPDATA%\DiscordStream\golive-sender-<userId>.json with
// the token and the voice channel that account is currently viewing, so normally
// there is nothing to paste by hand. One file per account when several clients
// (Stable + Canary) are logged in.
const captureDir = path.join(process.env.LOCALAPPDATA || "", "DiscordStream");

function loadCaptures() {
  const captures = [];
  try {
    for (const name of fs.readdirSync(captureDir)) {
      if (!/^golive-sender(-[0-9]+)?\.json$/.test(name)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(captureDir, name), "utf8"));
        if (data && typeof data.token === "string" && data.token) captures.push({ name, data });
      } catch (_) {}
    }
  } catch (_) {}
  return captures;
}

function mergeCapture(captured) {
  const placeholders = {
    token: "SEU_TOKEN_AQUI",
    guildId: "ID_DO_SERVIDOR",
    channelId: "ID_DO_CANAL_DE_VOZ",
  };
  for (const key of ["token", "guildId", "channelId"]) {
    const unset = !config[key] || config[key] === placeholders[key];
    if (unset && captured[key]) config[key] = captured[key];
  }
}

try {
  const captures = loadCaptures();
  if (captures.length > 0) {
    let chosen = config.userId
      ? captures.find((entry) => entry.data.userId === String(config.userId)) || null
      : null;
    if (!chosen && captures.length === 1) chosen = captures[0];
    if (chosen) {
      mergeCapture(chosen.data);
      console.log(
        `[sender] using BigDucks capture ${chosen.name} (user=${chosen.data.userId || "?"}, tokenSource=${chosen.data.tokenSource || "?"}, channel=${chosen.data.channelId || "?"})`,
      );
    } else {
      console.log(
        `[sender] ${captures.length} accounts captured: ${captures.map((entry) => `${entry.name} (user=${entry.data.userId || "?"})`).join(", ")}`,
      );
      console.log('[sender] set "userId" in config.json to pick which account streams');
    }
  }
} catch (err) {
  console.warn("[sender] could not read the BigDucks captures:", err?.message || err);
}

if (!config.token || config.token === "SEU_TOKEN_AQUI") {
  console.error(
    "[sender] no token. Run BigDucks with Discord open (it writes the capture automatically), or paste one into config.json.",
  );
  process.exit(1);
}
if (!config.channelId || config.channelId === "ID_DO_CANAL_DE_VOZ") {
  console.error(
    "[sender] no channelId. Join the voice channel in Discord (BigDucks captures it), or fill it in config.json.",
  );
  process.exit(1);
}

if (config.debug) {
  process.env.DEBUG = "*";
  console.log("[sender] DEBUG=* enabled");
}

// Use the bundled ffmpeg from ffmpeg-static if the library looks for one.
try {
  const ffmpeg = await import("ffmpeg-static");
  if (ffmpeg?.default) {
    process.env.FFMPEG_PATH = ffmpeg.default;
    console.log(`[sender] ffmpeg: ${ffmpeg.default}`);
  }
} catch {
  console.warn("[sender] ffmpeg-static not available, relying on ffmpeg on PATH.");
}

const { Client } = await import("@lng2004/discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Encoders } = await import(
  "@dank074/discord-video-stream"
);

const fps = Number(config.fps) > 0 ? Number(config.fps) : 30;
const width = Number(config.width) > 0 ? Number(config.width) : 1280;
const height = Number(config.height) > 0 ? Number(config.height) : 720;
const bitrate = Number(config.bitrateKbps) > 0 ? Number(config.bitrateKbps) : 2500;
const bitrateMax = Number(config.maxBitrateKbps) > 0 ? Number(config.maxBitrateKbps) : bitrate * 2;

const encoder =
  String(config.encoder || "software").toLowerCase() === "nvenc"
    ? Encoders.nvenc({ preset: "p4" })
    : Encoders.software();

// Default source is the desktop (gdigrab). Any ffmpeg-readable file/url works too.
const isScreen = !config.source || config.source === "screen";
const input = isScreen ? "desktop" : config.source;

const streamer = new Streamer(new Client({ checkUpdate: false }));
const client = streamer.client;

let controller = null;

function stopEverything() {
  try {
    controller?.abort();
  } catch {}
  try {
    streamer.stopStream();
  } catch {}
  try {
    streamer.leaveVoice();
  } catch {}
}

process.on("SIGINT", () => {
  console.log("\n[sender] stopping...");
  stopEverything();
  setTimeout(() => process.exit(0), 750);
});

client.on("ready", async () => {
  console.log(`[sender] logged in as ${client.user?.tag} (${client.user?.id})`);

  try {
    console.log(
      `[sender] joining voice: guild=${config.guildId ?? "(dm)"} channel=${config.channelId}`,
    );
    await streamer.joinVoice(config.guildId ?? null, config.channelId);
    console.log("[sender] in voice, starting Go Live...");

    controller = new AbortController();

    const options = {
      width,
      height,
      frameRate: fps,
      bitrateVideo: bitrate,
      bitrateVideoMax: bitrateMax,
      videoCodec: "H264",
      includeAudio: false,
      encoder,
      // The library's minimizeLatency option emits "-flags lowdelay", which
      // ffmpeg 6 rejects (the constant is low_delay). We add the correct
      // low-latency input flags ourselves instead.
      minimizeLatency: false,
      customInputOptions: isScreen
        ? ["-f", "gdigrab", "-framerate", String(fps), "-fflags", "nobuffer", "-flags", "low_delay", "-flush_packets", "1"]
        : [],
      customFfmpegFlags: [],
      logLevel: "error",
    };

    const { command, output } = prepareStream(input, options, controller.signal);
    command.on("error", (err) =>
      console.error("[sender] ffmpeg error:", err?.message || err),
    );

    console.log("[sender] streaming. Native clients in the channel should see it. Ctrl+C to stop.");

    // Prove whether the sender is really transmitting. BaseMediaConnection.webRtcConn
    // returns the wrapper; the wrapper exposes .ready and the raw PeerConnection.
    // We also wrap sendVideoFrame so we can count frames actually pushed to transport.
    function describeConnection(connection) {
      if (!connection) return "absent";
      const wrapper = connection.webRtcConn;
      if (!wrapper) return "no-wrapper";
      if (wrapper && typeof wrapper.sendVideoFrame === "function" && !wrapper.__bigDucksCounted) {
        wrapper.__bigDucksCounted = true;
        wrapper.__bigDucksFrames = 0;
        const original = wrapper.sendVideoFrame.bind(wrapper);
        wrapper.sendVideoFrame = function () {
          wrapper.__bigDucksFrames += 1;
          return original.apply(null, arguments);
        };
      }
      const peer = wrapper.webRtcConn;
      const state = peer && typeof peer.state === "function" ? peer.state() : "no-peer";
      const frames = wrapper.__bigDucksFrames === undefined ? "-" : wrapper.__bigDucksFrames;
      return `ready=${wrapper.ready === true} pc=${state} dave=${connection.daveReady === true} framesSent=${frames}`;
    }

    const reporter = setInterval(() => {
      try {
        const voice = streamer.voiceConnection;
        const stream = voice && voice.streamConnection;
        console.log(`[sender] voice[${describeConnection(voice)}] stream[${describeConnection(stream)}]`);
      } catch (err) {
        console.log("[sender] state probe failed:", err?.message || err);
      }
    }, 5000);

    try {
      await playStream(output, streamer, { type: "go-live" }, controller.signal);
    } finally {
      clearInterval(reporter);
    }
    console.log("[sender] stream finished.");
  } catch (err) {
    console.error("[sender] failed:", err?.message || err);
    stopEverything();
    process.exitCode = 1;
  }
});

client.on("error", (err) => console.error("[sender] client error:", err?.message || err));

client.login(config.token).catch((err) => {
  console.error("[sender] login failed:", err?.message || err);
  process.exitCode = 1;
});
