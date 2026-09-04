"use strict";

if (!global.__discordStreamBridgeLoaded) {
  global.__discordStreamBridgeLoaded = true;

  const fs = require("fs");
  const net = require("net");
  const path = require("path");
  const { app, BrowserWindow, session } = require("electron");

  const clientURL = /^https:\/\/(?:canary|ptb\.)?discord\.com\/(?:app|channels|login)/;
  const dataRoot = process.env.LOCALAPPDATA || app.getPath("userData");
  const controlPath = path.join(dataRoot, "DiscordStream", "bridge-control.json");
  let retryDelay = 500;
  let retryTimer = null;
  let socket = null;
  let buffer = "";

  function reply(id, ok, error, value) {
    if (!socket || socket.destroyed) return;
    socket.write(JSON.stringify({ type: "result", id, ok, error: error || "", value: value || "" }) + "\n");
  }

  // Client patches can report media health without exposing the bridge socket.
  global.__BIG_DUCKS_REPORT_MEDIA_EVENT = function reportMediaEvent(event, session) {
    if (!socket || socket.destroyed || typeof event !== "string") return false;
    socket.write(JSON.stringify({ type: "media_event", event, session: typeof session === "string" ? session : "", at: new Date().toISOString() }) + "\n");
    return true;
  };

  async function closeConnections(id) {
    try {
      await session.defaultSession.closeAllConnections();
      reply(id, true, "");
    } catch (error) {
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
    socket.on("error", () => {});
    socket.on("close", () => {
      socket = null;
      scheduleReconnect();
    });
  }

  app.whenReady().then(connect).catch(scheduleReconnect);
}
