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

    // TROCA do BrowserWindow: o objeto VIVO do electron continua sendo o alvo e
    // um Proxy intercepta SO `BrowserWindow` - todo o resto (app, ipcMain, os
    // getters lazy) passa intacto. O `Object.assign` antigo LIA esses getters na
    // hora (congelando o valor de hoje, as vezes undefined) e ainda criava um
    // objeto novo que quem ja tinha a referencia nunca via.
    try {
      const targets = [];
      const seen = [];
      const addPath = (request) => {
        let resolved;
        try { resolved = require.resolve(request); } catch (_) { return; }
        if (seen.indexOf(resolved) !== -1) return;
        seen.push(resolved);
        let entry = require.cache[resolved];
        if (!entry) {
          try { require(request); } catch (_) {}
          entry = require.cache[resolved];
        }
        if (entry && entry.exports) targets.push(resolved);
      };
      // "electron" sempre; "electron/main" quando o runtime expoe esse caminho.
      addPath("electron");
      addPath("electron/main");

      // O entry do electron no require.cache expoe `exports` como propriedade
      // SOMENTE-LEITURA (getter sem setter): atribuir direto estoura
      // "Cannot set property exports ... which has only a getter". O `delete`
      // remove o descritor e a atribuicao seguinte cria uma propriedade nova,
      // own e writable. O codigo antigo fazia o delete; a refatoracao do Proxy
      // o perdeu - e o swap morreu em silencio (o catch do fallback engolia o
      // MESMO TypeError, e o log dizia "nenhum cache de electron" com o cache
      // presente). Sem o preload anexado, a bandeja nunca sai do cinza.
      const replaceExports = (entry, value) => {
        delete entry.exports;
        entry.exports = value;
      };

      const swap = (modulePath) => {
        const entry = require.cache[modulePath];
        const target = entry.exports;
        const descriptor = Object.getOwnPropertyDescriptor(target, "BrowserWindow");
        // Alvo congelado/selado (ou BrowserWindow nao-configuravel): um Proxy
        // violaria os invariantes - volta pro comportamento antigo.
        if (Object.isFrozen(target) || Object.isSealed(target) || (descriptor && !descriptor.configurable)) {
          replaceExports(entry, Object.assign({}, target, { BrowserWindow: BigDucksBrowserWindow }));
          return "fallback";
        }
        const proxy = new Proxy(target, {
          get(_, prop) {
            if (prop === "BrowserWindow") return BigDucksBrowserWindow;
            return Reflect.get(target, prop, target);
          },
          getOwnPropertyDescriptor(_, prop) {
            if (prop === "BrowserWindow") {
              const own = Reflect.getOwnPropertyDescriptor(target, prop);
              return { value: BigDucksBrowserWindow, writable: true, enumerable: own ? own.enumerable : true, configurable: true };
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
          has(_, prop) {
            return prop === "BrowserWindow" ? true : Reflect.has(target, prop);
          },
          set(_, prop, value) {
            if (prop === "BrowserWindow") return true;
            return Reflect.set(target, prop, value, target);
          },
          defineProperty(_, prop, value) {
            if (prop === "BrowserWindow") return true;
            return Reflect.defineProperty(target, prop, value);
          },
        });
        if (proxy.BrowserWindow !== BigDucksBrowserWindow) throw new Error("getter nao pegou");
        Reflect.ownKeys(proxy);
        replaceExports(entry, proxy);
        return "proxy";
      };

      const done = [];
      for (const modulePath of targets) {
        try {
          done.push(modulePath + ": " + swap(modulePath));
        } catch (error) {
          try {
            const entry = require.cache[modulePath];
            replaceExports(entry, Object.assign({}, entry.exports, { BrowserWindow: BigDucksBrowserWindow }));
            done.push(modulePath + ": fallback (" + (error && error.message) + ")");
          } catch (fallbackError) {
            // NUNCA engolir em silencio: este catch mudo e' o que fazia o swap
            // falhar sem dizer nada (so' sobrava o "nenhum cache", que era
            // mentira - o cache existia, a atribuicao e' que estourava).
            done.push(modulePath + ": FALHOU (" + (error && error.message)
              + " | fallback: " + (fallbackError && fallbackError.message) + ")");
          }
        }
      }
      console.log("[bigducks-rs] BrowserWindow (Proxy/fallback): " + (done.join(" | ") || "nenhum cache de electron"));
    } catch (error) {
      console.error("[bigducks-rs] nao consegui trocar o BrowserWindow:", error && error.message);
    }
  }
}
