// bigducks-rs - processo principal (modelo Vencord).
//
// Carregado pelo stub em resources/app.asar, ANTES do app real do Discord.
// Faz uma coisa so: troca o preload das janelas do Discord pelo nosso.
//
// O preload roda antes dos scripts da pagina, com `sandbox: false`, e e de la
// que o bridge do renderer e' injetado - e tambem de onde o plugin do nitro e'
// injetado, com retry rapido no inicio (ver web/preload.js + web/plugins.js).
// Esse retry e' o que faz as factories do webpack serem patcheadas ANTES de
// existirem, que foi o que destravou a qualidade da transmissao.
//
// O CDP (Page.addScriptToEvaluateOnNewDocument) foi tentado e DESCARTADO: o
// comando so vale pros PROXIMOS documentos, e o documento do Discord ja existe
// quando ele chega. Nao entregava nada e ainda deixava um debugger anexado.

"use strict";

if (!global.__bigducksRsMainBridge) {
  global.__bigducksRsMainBridge = true;

  const path = require("path");

  let electron = null;
  try { electron = require("electron"); } catch {}

  // Rede de seguranca estreita: o core do Discord tem bug proprio no badge do
  // Windows (Math.min(undefined, 10) -> NaN -> setOverlayIcon(undefined)). Nao
  // queremos que o dialogo "A JavaScript error occurred in the main process"
  // apareca; qualquer outra excecao continua sendo reportada normalmente.
  try {
    process.on("uncaughtException", (error) => {
      const text = String((error && (error.stack || error.message)) || error);
      if (text.includes("setAppBadge") || text.includes("setOverlayIcon") || text.includes("conversion failure")) {
        console.error("[bigducks-rs] badge do Discord suprimido:", error && error.message);
        return;
      }
      console.error("[bigducks-rs] uncaughtException:", error);
    });
  } catch (_) {}

  const preloadPath = path.join(__dirname, "bigducks_rs_preload.js");

  if (electron && electron.BrowserWindow) {
    const OriginalBrowserWindow = electron.BrowserWindow;

    class BigDucksBrowserWindow extends OriginalBrowserWindow {
      constructor(options) {
        try {
          const web = options && options.webPreferences;
          if (web && typeof web.preload === "string" && web.preload.length > 0 && options.title) {
            process.env.BIGDUCKS_ORIGINAL_PRELOAD = web.preload;
            web.preload = preloadPath;
            web.sandbox = false;
          }
        } catch (_) {}
        super(options);
      }
    }

    Object.assign(BigDucksBrowserWindow, OriginalBrowserWindow);
    // O esbuild/Electron as vezes renomeia; sem isso a janela sai de
    // getFocusedWindow() e o Discord estranha.
    Object.defineProperty(BigDucksBrowserWindow, "name", { value: "BrowserWindow", configurable: true });

    try {
      const electronPath = require.resolve("electron");
      delete require.cache[electronPath].exports;
      require.cache[electronPath].exports = Object.assign({}, electron, { BrowserWindow: BigDucksBrowserWindow });
    } catch (error) {
      console.error("[bigducks-rs] nao consegui trocar o BrowserWindow:", error && error.message);
    }
  }
}
