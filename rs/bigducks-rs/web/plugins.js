// bigducks-rs - plugins opcionais (ligados com --nitro no run.cmd).
//
// Patch de CLIENTE, igual Equicord / YABDP4Nitro: a qualidade da transmissao
// (resolucao/fps) e decidida no JavaScript do cliente. O portao e a funcao do
// modulo cujo codigo contem a string "canStreamWithSettings".
//
// POR QUE NAO BASTA TROCAR O EXPORT: o portao e chamado DE DENTRO do proprio
// modulo (referencia local). Trocar `exports.x` nao afeta quem chama por dentro -
// foi isso que deu "0 funcoes". O que funciona (tecnica do Equicord) e
// REESCREVER A FONTE DA FACTORY e re-avaliar o modulo, com o patch DENTRO do
// closure.
//
// Este arquivo e injetado varias vezes pelo preload (o webpack so fica completo
// depois que o bundle carrega), entao e idempotente.
//
// RODADA NOVA (7 patches, TODOS guardados - ancora que nao casa so LOGA, nunca
// lanca): 1 codec forcado (H264) | 2 portoes do Nitro | 3 experimentos do Flux |
// 4 nitidez do stream | 5 upload 100 MB | 6 fundo de camera | 7 clips +fps/duracao.
// Os itens 2/5/6/7 seguem a MESMA via de factory (EARLY_RULES no push +
// patchFactories no cache); 1/3/4/6 embrulham o objeto VIVO (runtime, guardado).

(function () {
  // ---- constantes de comportamento (mexa AQUI, nao na logica) --------------
  //
  // item 1 - codec forcado. H264 e o unico que celular/browser decodificam de
  // forma confiavel; AV1/VP9 deixam a nossa live PRETA no celular. A chave tem
  // que bater com a do mapa `videoDecoders` do cliente (H264/VP8/VP9/H265/AV1).
  const FORCE_CODEC = "H264";
  // item 3 - experimentos do Flux: `variant` vai como 2o argumento.
  const FLUX_VARIANT = 1;
  const FLUX_EXPERIMENTS = ["2026-05-frontier-tuning", "2026-08-video-guard"];
  const EXPERIMENT_NAME = /^\d{4}-\d{2}-[a-z0-9-]+$/i;
  // item 4 - agucamento do stream (texto compartilhado nitido). false desliga.
  // DESLIGADO (0.1.3): aplicar `filter: url(#bd-sharpen-filter)` em video ao
  // vivo faz o feConvolveMatrix engolir os frames do WebRTC e renderizar LIXO -
  // tiles serpia e o player de quem ASSISTE preto com franja no topo (visto e
  // fotografado no par Discord x Canary no mesmo PC). Texto nitido era o
  // objetivo, mas o alvo aqui so' pode ser <video>. Vira opt-in explicito.
  const SHARPEN_STREAM = false;
  // item 5 - teto de upload (100 MB).
  const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
  // item 6 - fundo de camera virtual. Vazio = DESLIGADO; com URL/caminho, liga
  // (o preset de fabrica + o embrulho do graph handler passam a agir).
  const CAMERA_BACKGROUND = "";

  function report(name, data) {
    const text = String(data == null ? "" : data);
    try {
      fetch("http://127.0.0.1:8791/bridge-event?name=" + encodeURIComponent(name) + "&data=" + encodeURIComponent(text)).catch(() => {});
    } catch (_) {}
    try { console.log("[bigducks-rs:plugin]", name, text); } catch (_) {}
  }

  function webpackRequire() {
    try {
      const chunk = globalThis.webpackChunkdiscord_app;
      if (!chunk || typeof chunk.push !== "function") return null;
      const result = chunk.push([[Symbol("bd-nitro")], {}, (require) => require]);
      if (result && result.c) return result;
    } catch (_) {}
    return null;
  }

  const state = window.__bdNitroState || (window.__bdNitroState = { modules: 0, patched: 0, warned: false });

  // ---- hook no PUSH do webpack: patchear antes de o modulo existir ----------
  //
  // O boot mostra "TARDE: ja executado" nos tres modulos. Nao e jeito, e ordem: o
  // runtime do webpack faz
  //     self.webpackChunkdiscord_app = self.webpackChunkdiscord_app || []
  //     (depois) push([[ids], { modulos }])
  // O preload roda ANTES da pagina, entao se a gente cria esse array com um push
  // proprio, os modulos passam por nos ANTES de serem registrados - e antes de
  // qualquer execucao. Sem versao velha, o freeze e a referencia antiga deixam de
  // existir como problema.
  const EARLY_RULES = [
    { needle: "STREAM_HIGH_QUALITY", mutate: grantStreamPerk },
    { needle: "stream-settings-fps-", mutate: forceMaxAllowed },
    { needle: '"canStreamWithSettings"', mutate: allowAll },
    // itens novos desta rodada. A lista e ENCADEADA (patchIncoming sem `break`):
    // um modulo pode ser, ao mesmo tempo, da perk e de um portao.
    { needle: "canStreamQuality", mutate: hardenGates },
    { needle: "getMaxFileSize", mutate: raiseUploadLimit },
    { needle: "photoshop", mutate: raiseUploadLimit },
    { needle: "CLIPS_FRAME_RATE", mutate: extendClips },
    { needle: "CLIPS_LENGTH", mutate: extendClips },
    { needle: "backgroundReplacement", mutate: injectCameraBackgroundPreset }
  ];

  function patchIncoming(data) {
    const modules = data && data[1];
    if (!modules || typeof modules !== "object") return 0;
    let patched = 0;
    for (const id of Object.keys(modules)) {
      const factory = modules[id];
      if (typeof factory !== "function") continue;
      let source;
      try { source = Function.prototype.toString.call(factory); } catch (_) { continue; }
      // Encadeia TODAS as regras que casam (antes era `break` na primeira): um
      // modulo pode ser, ao mesmo tempo, da perk e de um portao. O resultado so e
      // trocado se compilar - senao a factory original fica intacta.
      let out = source;
      const applied = [];
      for (const rule of EARLY_RULES) {
        if (out.indexOf(rule.needle) === -1) continue;
        let rewritten = null;
        try { rewritten = rule.mutate(out); } catch (error) {
          report("nitro-chunk-erro", id + ": " + String(error && error.message).slice(0, 80));
          continue;
        }
        if (!rewritten || rewritten === out) continue;
        out = rewritten;
        applied.push(rule.needle);
      }
      if (!applied.length) continue;
      try {
        modules[id] = new Function("return (" + normalize(out) + ")")();
        patched += 1;
        report("nitro-chunk", "modulo " + id + " " + applied.join(",") + " (antes de executar)");
      } catch (error) {
        report("nitro-chunk-erro", id + ": " + String(error && error.message).slice(0, 80));
      }
    }
    return patched;
  }

  function installChunkHook() {
    try {
      const existing = globalThis.webpackChunkdiscord_app;
      if (existing && existing.__bdHooked) return true;
      const list = Array.isArray(existing) ? existing : [];
      const originalPush = list.push.bind(list);
      list.push = function (data) {
        try { patchIncoming(data); } catch (_) {}
        return originalPush(data);
      };
      list.__bdHooked = true;
      globalThis.webpackChunkdiscord_app = list;
      return true;
    } catch (_) {
      return false;
    }
  }

  installChunkHook();

  const require = webpackRequire();
  if (!require || !require.c) {
    if (!state.warned) {
      state.warned = true;
      report("nitro-falhou", "sem acesso ao webpack");
    }
    return;
  }

  const moduleCount = Object.keys(require.c).length;
  if (moduleCount === state.modules && state.patched > 0) return; // nada novo
  state.modules = moduleCount;

  // Injeta `return !0;` antes do `if (... PRESET_AUTO)`: o portao responde
  // "pode" sempre. Adaptacao da regex do Equicord
  // (/(?=if\(\i===\i\.\i\.PRESET_AUTO\))/) para leitura direta da fonte.
  function allowAll(source) {
    const at = source.indexOf("PRESET_AUTO");
    if (at < 0) return null;
    const ifAt = source.lastIndexOf("if(", at);
    if (ifAt < 0) return null;
    if (source.slice(Math.max(0, ifAt - 14), ifAt).indexOf("!0") !== -1) return null; // ja patchado
    return source.slice(0, ifAt) + "return !0;" + source.slice(ifAt);
  }

  // `Function.prototype.toString` de metodo abreviado devolve `nome(args){...}`,
  // que NAO e expressao valida sozinha ("Unexpected token '{'"). E o nome pode
  // ser NUMERICO - o webpack minificado gera `{327649(e,t,n){...}}` - e
  // `function 327649()` tambem e invalido, entao nesse caso o nome sai.
  function normalize(source) {
    let text = String(source).trim();
    let isAsync = false;
    if (/^async\s/.test(text)) { isAsync = true; text = text.slice(6).trim(); }
    if (/^function\b/.test(text) || text.charAt(0) === "(") {
      return (isAsync ? "async " : "") + text;
    }
    const shorthand = text.match(/^([A-Za-z_$][\w$]*|\d[\w$]*)\s*\(/);
    if (shorthand) {
      const named = /^[A-Za-z_$]/.test(shorthand[1]);
      const params = text.slice(text.indexOf("("));
      return (isAsync ? "async function " : "function ") + (named ? shorthand[1] : "") + params;
    }
    return (isAsync ? "async " : "") + text;
  }

  function patchFactories(needle, mutate) {
    let patched = 0;
    for (const id of Object.keys(require.c)) {
      let module;
      let factory;
      try {
        module = require.c[id];
        factory = require.m && require.m[id];
      } catch (_) { continue; }
      if (!module || typeof factory !== "function") continue;
      // Guarda por AGULHA (needle), nao por modulo: o MESMO modulo pode ser, ao
      // mesmo tempo, o da perk e o de um portao - e os dois precisam entrar.
      module.__bdNeedles = module.__bdNeedles || {};
      if (module.__bdNeedles[needle]) continue;

      let source;
      try { source = Function.prototype.toString.call(factory); } catch (_) { continue; }
      if (source.indexOf(needle) === -1) continue;

      let rewritten = null;
      try { rewritten = mutate(source); } catch (error) {
        // Um mutate que estoura NAO pode abortar o plugin inteiro: hoje um throw
        // aqui derruba as regras seguintes E os itens de runtime (tudo abaixo).
        // Isola por modulo e segue (o `patchIncoming` ja' faz isto).
        report("nitro-mutate-erro", id + " " + needle + ": " + String(error && error.message).slice(0, 80));
        continue;
      }
      if (!rewritten || rewritten === source) continue;

      try {
        // Mesma assinatura da factory original (module, exports, require).
        const rebuilt = new Function("return (" + normalize(rewritten) + ")")();
        const previousExports = module.exports;
        require.m[id] = rebuilt;
        delete require.c[id];
        const fresh = require(id); // re-executa com o patch dentro do closure
        // Copia BEST-EFFORT pro objeto antigo (quem ja segurou a referencia).
        // NAO usar Object.assign: o `n.d` do webpack cria getters
        // NAO-configuraveis e a atribuicao simples estoura "Cannot set property".
        if (fresh && typeof fresh === "object" && previousExports) {
          for (const key of Object.getOwnPropertyNames(fresh)) {
            try {
              Object.defineProperty(previousExports, key, Object.getOwnPropertyDescriptor(fresh, key));
            } catch (_) {}
          }
        }
        module.__bdPatched = true;
        module.__bdNeedles[needle] = true;
        if (needle.indexOf("STREAM_HIGH_QUALITY") !== -1) state.perkModule = id;
        patched += 1;
        report("nitro-patch", "modulo " + id + " " + needle);
      } catch (error) {
        // Manda o comeco da fonte junto: e o que diz a FORMA da funcao quando
        // a re-avaliacao falha (evita mais uma rodada de chute).
        report("nitro-erro", id + ": " + String(error && error.message).slice(0, 80)
          + " | fonte: " + source.slice(0, 130));
      }
    }
    return patched;
  }

  // ---- abordagem A: estender as LISTAS de preset -----------------------------
  //
  // O menu nao e montado com valores soltos: ele faz `lista.map(...)` pra desenhar
  // cada item (fps e resolucao). Entao, em vez de injetar JSX, basta acrescentar
  // entradas nas listas - o PROPRIO Discord desenha as opcoes novas com o codigo
  // dele. As listas vem do modulo com exports `{value,label,subtext}[]`.
  function extendPresetLists() {
    let added = 0;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || typeof exports !== "object") continue;

      for (const key of Object.getOwnPropertyNames(exports)) {
        let list;
        try { list = exports[key]; } catch (_) { continue; }
        if (!Array.isArray(list) || list.length === 0 || list.__bdExtended) continue;

        const first = list[0];
        if (!first || typeof first !== "object" || !("value" in first) || !("label" in first)) continue;

        const values = [];
        for (const item of list) {
          const n = Number(item && item.value);
          // 0 nao e valor de preset (a lista de resolucao termina com um): se
          // contar, a lista inteira e descartada pela lista branca.
          if (!Number.isFinite(n) || n === 0) continue;
          values.push(n);
        }
        if (!values.length) continue;

        // Lista BRANCA: um array qualquer com {value,label} nao pode ser
        // confundido - o teste pegou [1,2,3] sendo classificado como "fps" e
        // isso poluiria listas alheias da UI. So aceita valores tipicos de fps
        // ou de resolucao, em listas curtas.
        const FPS_OK = [15, 20, 24, 25, 30, 60, 120, 144];
        const RES_OK = [240, 360, 480, 540, 720, 900, 1080, 1440, 2160];
        const every = (allowed) => values.every((v) => allowed.indexOf(v) !== -1);
        const short = list.length <= 6;
        const isFps = short && every(FPS_OK);
        const isResolution = short && every(RES_OK);
        if (!isFps && !isResolution) {
          // Diagnostico: diz QUAIS valores essa lista tem - foi assim que a gente
          // descobriu que a lista de RESOLUCAO nao casou com a lista branca.
          state.saw = state.saw || {};
          const tag = id + ":" + key;
          if (!state.saw[tag]) {
            state.saw[tag] = true;
            report("nitro-presets-visto", "modulo " + id + " exports[" + key + "] valores=" + values.slice(0, 8).join(","));
          }
          continue;
        }

        const wanted = isFps ? [60, 120] : [1080, 1440];
        let touched = false;
        for (const value of wanted) {
          if (values.indexOf(value) !== -1) continue;
          try {
            list.push({ value: value, label: isFps ? value + " FPS" : value + "p" });
            touched = true;
          } catch (error) {
            report("nitro-presets-falhou", id + " " + key + ": " + String(error && error.message).slice(0, 80));
          }
        }
        try { list.__bdExtended = true; } catch (_) {}
        if (touched) {
          added += 1;
          report("nitro-presets", "modulo " + id + " exports[" + key + "] + "
            + (isFps ? "60/120 FPS" : "1080p/1440p"));
        }
      }
    }
    return added;
  }

  // ---- abordagem C: soltar o "G" (limite do tier no menu) -------------------
  //
  // O menu calcula `G = <res> === w?.maxResolution && <fps> === w?.maxFPS` - ou
  // seja, "estou exatamente no maximo permitido". Se G for falso, o valor pedido
  // e PRESO em `o` (o atual) e o caminho do aviso dispara. Forcar G = true faz o
  // menu respeitar a escolha, do mesmo jeito que a gente ja forcou o portao.
  function forceMaxAllowed(source) {
    const re = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=+(([A-Za-z_$][\w$]*)\?\.maxResolution)&&([A-Za-z_$][\w$]*)=+(\4\?\.maxFPS)/;
    const simple = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=+(\w+)\?\.maxResolution&&(\w+)=+\3\?\.maxFPS/;
    if (simple.test(source)) {
      source = source.replace(simple, "$1=!0");
    }
    if (re.test(source)) {
      source = source.replace(re, "$1=!0");
    }
    // NOVO: o callback P nunca abre o modal - sempre aplica as opcoes.
    // O P e: `P=r.useCallback((e,r,a,s)=>{if(e){APLICA}else{openModalLazy}})`.
    // Trocando `if(e){` por `if(!0){`, o bloco de APLICACAO roda sempre - e o
    // `else` com o openModalLazy (o modal do Nitro) nunca e alcancado.
    // Se o usuario escolheu 1080p/60, esses valores vao em r e a e sao passados
    // para setGoLiveSource. Se o gate falhar (e=null), o P simplesmente nao
    // faz nada (nao ha modal) - melhor do que mostrar o upsell.
    source = source.replace(
      /(\w+=r\.useCallback\(\(\w+,\w+,\w+,\w+\)=>\{)if\(\w+\)\{/,
      "$1if(!0){"
    );
    return source;
  }

  // ---- abordagem E: o EXPERIMENTO do tier (o bloqueio real) -----------------
  //
  // O menu chama `(0,g.A)("useStreamSettingsItems", user, guildId)` (g = modulo
  // que contem "2026-05-frontier-tuning"). Essa funcao devolve
  // `{maxBitrate, maxResolution:1080, maxFPS:30, maskReportedQuality}` pros
  // membros de guild sem boost - e e ELA que trava as opcoes no painel, mesmo
  // com a perk concedida. Devolvendo null, o menu nao aplica limite nenhum.
  function killTierExperiment(source) {
    // A funcao termina com `return null!=s.maxBitrate?s:null` - e esse `s` (o
    // config do experimento) que traz {maxResolution:1080, maxFPS:30}. Trocando
    // SO ESSA LINHA por `return null`, a funcao nunca devolve limite - os early
    // returns ja devolviam null. Mudanca minima, sem reescrever o corpo.
    if (source.indexOf("2026-05-frontier-tuning") === -1) return null;
    const re = /return null!=(\w+)\.maxBitrate\?\1:null/;
    if (!re.test(source)) return null;
    const out = source.replace(re, "return null");
    return out === source ? null : out;
  }

  // ---- abordagem D: a PERK --------------------------------------------------
  //
  // O banner do picker ("Transmita em resolucao HD com Nitro") e o modal NAO sao
  // checagens separadas: os dois respondem a perk STREAM_HIGH_QUALITY
  // (`q = new M(T.w.STREAM_HIGH_QUALITY)`). Concedendo a perk, os dois somem na
  // raiz - junto com o resto do gate de qualidade.
  function grantStreamPerk(source) {
    const perk = source.match(/([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.w\.STREAM_HIGH_QUALITY\)/);
    if (!perk) return null;
    const name = perk[1];
    let touched = false;
    // A qualidade alta so existe na lista do TIER_2. Banner, modal e trava
    // perguntam "o meu TIER inclui a perk?" - entao ela entra nos tiers 0 e 1.
    const patched = source.replace(
      /(\[\w+\.\w+\.TIER_[01]\]:new \w+\(\w+\.\w+\.TIER_[01],\[[^\]]*?)(\])/g,
      function (all, head, tail) {
        if (new RegExp("[,\\[]" + name + "[,\\]]").test(all)) return all;
        touched = true;
        return head + "," + name + tail;
      }
    );
    // e, por seguranca, o proprio objeto da perk responde "sim" as perguntas
    // booleanas (alguns caminhos consultam a instancia em vez da lista).
    const withFlags = patched.replace(perk[0], function () {
      return name + "=(function(){var p=new " + perk[0].split("new ")[1].replace(/\)$/, "") + ");"
        + "try{var ks=['hasPremium','hasBoost','isAvailable','isOwned','hasFreePremium','isGrandfathered'];"
        + "for(var i=0;i<ks.length;i++){if(typeof p[ks[i]]==='function'){p[ks[i]]=function(){return !0};}}}catch(e){}"
        + "return p;})()";
    });
    return touched ? withFlags : null;
  }

  // ---- descoberta dirigida: quem MAIS fala da perk ---------------------------
  //
  // O bundle por offset caiu em modulo errado duas vezes. Aqui a varredura e no
  // CLIENTE VIVO, por codigo: toda funcao exportada que menciona
  // STREAM_HIGH_QUALITY e candidata - inclusive o cheque de entitlement que
  // mantem o banner e o modal. Sem chute: e o log que diz onde patchear depois.
  function findPerkConsumers() {
    const needle = "STREAM_HIGH_QUALITY";
    const seen = state.seen || (state.seen = {});
    let reported = 0;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || typeof exports !== "object") continue;

      let names;
      try { names = Object.getOwnPropertyNames(exports); } catch (_) { continue; }
      for (const key of names) {
        let value;
        try { value = exports[key]; } catch (_) { continue; }
        if (typeof value !== "function") continue;

        let source;
        try { source = Function.prototype.toString.call(value); } catch (_) { continue; }
        const at = source.indexOf(needle);
        if (at === -1) continue;

        const tag = id + ":" + key;
        if (seen[tag]) continue;
        seen[tag] = true;
        reported += 1;
        report("perk-consumidor", "modulo " + id + " fn " + String(key).slice(0, 24)
          + " | ..." + source.slice(Math.max(0, at - 110), at + 70).replace(/\s+/g, " "));
      }
    }
    return reported;
  }

  // ---- fechar o gap do `perk-consumers`: CONSUMIR o entitlement -------------
  //
  // O `findPerkConsumers` so LOGA quem fala da perk (HANDOFF 6.2 registra como
  // aberto). Aqui a gente acha o consumidor do entitlement pelo CORPO do export
  // (via __bdWebpack.getByBody, do preload) e o embrulha pra responder "tem
  // direito" mesmo sem o Nitro - e o que derruba o banner do picker e o modal.
  // Tudo guardado: sem primitiva, sem alvo ou export nao-atribuivel, so LOGA.
  function bindPerkConsumer() {
    if (state.perkBound) return true;
    const api = globalThis.__bdWebpack;
    const wrap = globalThis.__bdWrap;
    if (!api || typeof api.getByBody !== "function" || !wrap || typeof wrap.after !== "function") {
      note("perk-bind", "perk-bind-sem-primitivas", "getByBody/__bdWrap ausentes (preload novo?)");
      return false;
    }
    // ON-DEMAND: a varredura por CORPO e O(modulos) e cara (getOwnPropertyNames +
    // toString de cada export) - NAO pode rodar a cada poll de injecao. So tenta
    // quando o cache do webpack MUDOU de tamanho (modulo novo entrou); o preload
    // ainda cacheia o indice por tamanho, entao o trabalho pesado roda 1x.
    let size = -1;
    try {
      const req = api.getRequire && api.getRequire();
      if (req && req.c) size = Object.keys(req.c).length;
    } catch (_) {}
    if (size >= 0 && state.perkTriedSize === size) return false;
    if (size >= 0) state.perkTriedSize = size;
    const hit = api.getByBody((body) => {
      if (body.indexOf("STREAM_HIGH_QUALITY") === -1) return false;
      // o consumidor do entitlement cita uma checagem de premium/entitlement
      return /hasPremium|hasEntitlement|hasBoost|hasFreePremium|isPremium|isEntitled|isAvailable|isOwned/i.test(body);
    });
    if (!hit) {
      note("perk-bind", "perk-bind-sem-alvo", "nenhum consumidor de STREAM_HIGH_QUALITY + entitlement");
      return false;
    }
    if (state.perkModule != null && String(state.perkModule) === String(hit.id)) {
      note("perk-bind", "perk-bind-ignorado", "casou o proprio modulo da perk (" + hit.id + ")");
      return false;
    }
    try {
      const bound = wrap.after(hit.exports, hit.key, function (value) {
        // So mexe no que ja era "sem direito"; devolver objeto/true fica intacto.
        return (value === false || value == null) ? true : value;
      }, { replace: true });
      if (!bound || !bound.__bdAfter) {
        note("perk-bind", "perk-bind-leitura", "export " + hit.id + ":" + String(hit.key).slice(0, 24) + " nao e atribuivel");
        return false;
      }
      state.perkBound = true;
      report("perk-consumido", "modulo " + hit.id + " fn " + String(hit.key).slice(0, 24) + " (entitlement forcado)");
      return true;
    } catch (error) {
      note("perk-bind", "perk-bind-erro", String(error && error.message).slice(0, 80));
      return false;
    }
  }

  // ---- o que faltava: distribuir as perks nos objetos VIVOS -----------------
  //
  // O mapa de tiers e `Object.freeze`, e os consumidores guardaram a REFERENCIA
  // antiga - entao re-executar o modulo e copiar exports por cima NUNCA pega em
  // chave congelada (foi por isso que "aplicou" e nada mudou). Aqui nao tem
  // re-execucao: a gente pega a UNIAO das perks de todos os tiers e devolve pra
  // cada lista. Os consumidores enxergam na hora, porque sao os mesmos objetos.
  function grantPerksToAllTiers() {
    const id = state.perkModule;
    const mod = id != null && require.c[id] && require.c[id].exports;
    if (!mod) return 0;

    const lists = [];
    for (const key of Object.getOwnPropertyNames(mod)) {
      let value;
      try { value = mod[key]; } catch (_) { continue; }
      if (!value || typeof value !== "object") continue;
      for (const tierKey of Object.keys(value)) {
        let tier;
        try { tier = value[tierKey]; } catch (_) { continue; }
        if (!tier || typeof tier !== "object") continue;
        for (const prop of Object.getOwnPropertyNames(tier)) {
          let arr;
          try { arr = tier[prop]; } catch (_) { continue; }
          if (Array.isArray(arr) && arr.length) lists.push(arr);
        }
      }
    }
    if (lists.length < 2) return 0;

    const union = [];
    for (const arr of lists) {
      for (const perk of arr) if (union.indexOf(perk) === -1) union.push(perk);
    }

    let added = 0;
    for (const arr of lists) {
      for (const perk of union) {
        if (arr.indexOf(perk) !== -1) continue;
        try { arr.push(perk); added += 1; } catch (_) {}
      }
    }
    if (added) {
      report("perk-tiers", added + " perk(s) distribuida(s) em " + lists.length + " listas de tier");
    }
    return added;
  }

  // ==========================================================================
  // RODADA NOVA (itens 1-7). Fonte-rewrite (2/5/6/7) usa as MESMAS vias de cima;
  // runtime (1/3/4/6) embrulha o objeto vivo. Tudo guardado: ancora que nao casa
  // so LOGA (via `note`/report) - nunca lanca.
  // ==========================================================================

  // Injeta `return <expr>;` no comeco do corpo da funcao/metodo `name`. Cobre as
  // formas minificadas (`name(a){`, `name:function(a){`, `name=(a)=>{`) e NAO
  // casa chamada (`x.name(a)`) porque exige `{` depois do `)` e posicao de
  // definicao antes do nome. O marcador `/*bd-name*/` torna a re-entrada no-op.
  function injectReturn(source, name, expr) {
    const marker = "/*bd-" + name + "*/";
    if (source.indexOf(marker) !== -1) return null; // ja patchado
    const re = new RegExp(
      "([\\s,{;(]|^)" + name
        + "\\s*(?:[:=]\\s*(?:async\\s+)?(?:function\\s*)?)?\\([^)]*\\)\\s*(?:=>\\s*)?\\{"
    );
    const match = re.exec(source);
    if (!match) return null;
    const openBrace = match.index + match[0].length;
    return source.slice(0, openBrace) + "return " + expr + ";" + marker + source.slice(openBrace);
  }

  // item 2 - os PORTOES do Nitro (a versao a prova de build da perk).
  //
  // Em vez de patchear cada preset, libera os PROPRIOS portoes que o cliente
  // consulta. Nomes estaveis (sao API publica do modulo premium). Loga cada um.
  function hardenGates(source) {
    let out = source;
    let flipped = 0;
    for (const gate of ["canStreamQuality", "canUseHighVideoUploadQuality", "canUseClientThemes"]) {
      const next = injectReturn(out, gate, "!0");
      if (next) { out = next; flipped += 1; report("gate-liberado", gate); }
    }
    if (flipped) {
      // getFeatureValue e generico (WIDGETs alheios usam): so entra quando o
      // modulo ja era um modulo de portao nosso.
      const generic = injectReturn(out, "getFeatureValue", "!0");
      if (generic) { out = generic; flipped += 1; report("gate-liberado", "getFeatureValue"); }
    }
    return flipped ? out : null;
  }

  // item 5 - teto de upload (100 MB). Modulo achado pela ancora "photoshop"
  // (o modulo que tem getMaxFileSize/exceedsMessageSizeLimit).
  function raiseUploadLimit(source) {
    let out = source;
    let touched = 0;
    const size = injectReturn(out, "getMaxFileSize", String(UPLOAD_LIMIT_BYTES));
    if (size) { out = size; touched += 1; report("upload-teto", "getMaxFileSize -> " + UPLOAD_LIMIT_BYTES + " bytes"); }
    const limit = injectReturn(out, "exceedsMessageSizeLimit", "!1");
    if (limit) { out = limit; touched += 1; report("upload-teto", "exceedsMessageSizeLimit -> false"); }
    return touched ? out : null;
  }

  // item 7 - clips com mais fps e mais duracao. As listas moram DENTRO do objeto
  // logo depois das ancoras `.CLIPS_FRAME_RATE,{` e `.CLIPS_LENGTH,{`. Acha esse
  // objeto (ancora + proximo `{`, tolerante a espaco) e acrescenta na PRIMEIRA
  // lista so-de-numeros - idempotente pela presenca do valor.
  function matchingBrace(source, open) {
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source.charAt(i);
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  }

  function injectClipValues(source, anchor, values) {
    const at = source.indexOf(anchor);
    if (at === -1) return null;
    const open = source.indexOf("{", at + anchor.length);
    if (open === -1) return null;
    const close = matchingBrace(source, open);
    if (close === -1) return null;
    const body = source.slice(open + 1, close);
    const array = body.match(/\[([0-9,\s]*)\]/);
    if (!array) return null;
    const current = array[1].split(",").map((part) => part.trim()).filter((part) => part !== "");
    const added = [];
    for (const value of values) {
      if (current.indexOf(String(value)) === -1) { current.push(String(value)); added.push(value); }
    }
    if (!added.length) return null;
    const rebuilt = body.slice(0, array.index) + "[" + current.join(",") + "]" + body.slice(array.index + array[0].length);
    return { source: source.slice(0, open + 1) + rebuilt + source.slice(close), added };
  }

  function extendClips(source) {
    let out = source;
    let added = 0;
    const fps = injectClipValues(out, ".CLIPS_FRAME_RATE", [120, 144]);
    if (fps) { out = fps.source; added += fps.added.length; report("clips-opcoes", "CLIPS_FRAME_RATE + " + fps.added.join("/") + " FPS"); }
    const length = injectClipValues(out, ".CLIPS_LENGTH", [180, 300]);
    if (length) { out = length.source; added += length.added.length; report("clips-opcoes", "CLIPS_LENGTH + " + length.added.join("/") + "s"); }
    return added ? out : null;
  }

  // item 6 (parte de fabrica) - preset de fundo de camera. Entra como PRIMEIRO
  // item da primeira lista de objetos com cara de fundo (tem url/image/thumbnail)
  // do modulo de backgroundReplacement. Desligado por padrao: o runtime ainda
  // embrulha o graph handler em wrapCameraBackground().
  function injectCameraBackgroundPreset(source) {
    if (!CAMERA_BACKGROUND) return null;
    if (source.indexOf("ackground") === -1) return null;
    if (source.indexOf('"bd-custom"') !== -1) return null;
    const array = source.match(/\[\s*\{[^{}]*?(?:thumbnail|url|image|src)\s*:/);
    if (!array) return null;
    const at = array.index + 1;
    const url = JSON.stringify(CAMERA_BACKGROUND);
    const preset = "{id:\"bd-custom\",name:\"bigducks\",url:" + url + ",image:" + url + ",thumbnail:" + url + "},";
    return source.slice(0, at) + preset + source.slice(at);
  }

  // item 1 - codec forcado (runtime, no PROTOTIPO da RTCConnection).
  //
  // `getCodecOptions` devolve {audioEncoder,...,videoEncoder,videoDecoders}.
  // Trocando `videoEncoder` por `videoDecoders[FORCE_CODEC]` o proprio cliente
  // negocia H264 - que celular/browser decodificam (AV1 nao).
  function codecDecoder(options) {
    const decoders = options && options.videoDecoders;
    if (!decoders || typeof decoders !== "object") return null;
    const want = String(FORCE_CODEC).toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const key of Object.keys(decoders)) {
      if (String(key).toLowerCase().replace(/[^a-z0-9]/g, "") === want) return decoders[key];
    }
    return null;
  }

  function forceCodec(options) {
    const chosen = codecDecoder(options);
    if (!chosen || options.videoEncoder === chosen) return false;
    options.videoEncoder = chosen;
    if (!state.codecLogged) {
      state.codecLogged = true;
      report("codec-forcado", FORCE_CODEC + " (videoEncoder = videoDecoders[" + FORCE_CODEC + "])");
    }
    return true;
  }

  function codecWrapper(original) {
    const wrapper = function () {
      const ret = original.apply(this, arguments);
      try { forceCodec(ret); } catch (_) {}
      return ret;
    };
    wrapper.__bdCodec = true;
    return wrapper;
  }

  // Embrulha getCodecOptions onde ele estiver: no PROTOTIPO (classe
  // RTCConnection) e/ou como propriedade propria do objeto/namespace exportado.
  function wrapCodecHolder(value) {
    let count = 0;
    const proto = typeof value === "function" ? value.prototype : null;
    if (proto && proto !== Object.prototype) {
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(proto, "getCodecOptions"); } catch (_) { desc = null; }
      if (desc && typeof desc.value === "function" && !desc.value.__bdCodec) {
        try {
          Object.defineProperty(proto, "getCodecOptions", {
            configurable: true, writable: true, enumerable: !!desc.enumerable, value: codecWrapper(desc.value),
          });
          count += 1;
        } catch (_) {}
      }
    }
    if (typeof value.getCodecOptions === "function" && !value.getCodecOptions.__bdCodec) {
      try {
        Object.defineProperty(value, "getCodecOptions", {
          configurable: true, writable: true, value: codecWrapper(value.getCodecOptions),
        });
        count += 1;
      } catch (_) {}
    }
    return count;
  }

  function wrapCodecOptions() {
    if (state.codecWrapped) return true;
    let count = 0;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || typeof exports !== "object") continue;
      let values;
      try { values = [exports, exports.default].concat(Object.values(exports)); } catch (_) { continue; }
      for (const value of values) {
        if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
        try { count += wrapCodecHolder(value); } catch (_) {}
      }
    }
    if (count) {
      state.codecWrapped = true;
      report("codec-hook", count + " getCodecOptions embrulhado(s) p/ " + FORCE_CODEC);
      return true;
    }
    note("codec", "codec-sem-alvo", "getCodecOptions nao achado (nenhum alvo embrulhado)");
    return false;
  }

  // item 3 - experimentos do Flux (createOverride + emitChange; so runtime).
  function findExperimentStore() {
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || typeof exports !== "object") continue;
      let values;
      try { values = [exports, exports.default].concat(Object.values(exports)); } catch (_) { continue; }
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        try {
          if (typeof value.createOverride === "function" && typeof value.emitChange === "function") return value;
        } catch (_) {}
      }
    }
    return null;
  }

  function unlockExperiments() {
    if (state.fluxDone) return true;
    const store = findExperimentStore();
    if (!store) { note("flux", "experimentos-sem-store", "ApexExperimentStore ausente (createOverride/emitChange)"); return false; }

    const names = FLUX_EXPERIMENTS.slice();
    // descoberta: nomes de experimento que o proprio store conhece e que sao de
    // stream/clips (nomes fora do nosso radar entram de graca).
    for (const prop of ["getExperiments", "getAllExperiments"]) {
      let list;
      try { list = typeof store[prop] === "function" ? store[prop]() : null; } catch (_) { list = null; }
      if (!list) continue;
      let keys = [];
      try { keys = Array.isArray(list) ? list : Object.keys(list); } catch (_) { keys = []; }
      for (const key of keys) {
        const name = String(key);
        if (EXPERIMENT_NAME.test(name) && /stream|clip|video|screen|frontier|quality|rtc/i.test(name)) names.push(name);
      }
    }

    const seen = {};
    let overrides = 0;
    for (const name of names) {
      if (seen[name]) continue;
      seen[name] = true;
      try {
        store.createOverride(name, FLUX_VARIANT);
        overrides += 1;
        report("experimento", name + " -> variante " + FLUX_VARIANT);
      } catch (error) {
        report("experimento-erro", name + ": " + String(error && error.message).slice(0, 60));
      }
    }
    try { if (overrides) store.emitChange(); } catch (_) {}
    state.fluxDone = true;
    report("experimentos", overrides + " override(s) via ApexExperimentStore.createOverride");
    return overrides > 0;
  }

  // item 4 - agucamento do stream: um filtro SVG (feConvolveMatrix) UMA vez, e
  // `style.filter` no player (mesma jogada do tile por-usuario da referencia, com
  // a var CSS reutilizavel). E o que deixa o TEXTO de tela-compartilhada nitido.
  function installSharpening() {
    if (!SHARPEN_STREAM) { note("sharpen", "nitidez-off", "SHARPEN_STREAM=false"); return false; }
    if (state.sharpenInstalled) return true;
    try {
      if (!document.getElementById("bd-sharpen-filter")) {
        const NS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.setAttribute("aria-hidden", "true");
        svg.style.position = "absolute";
        const filter = document.createElementNS(NS, "filter");
        filter.setAttribute("id", "bd-sharpen-filter");
        filter.setAttribute("color-interpolation-filters", "sRGB");
        const kernel = document.createElementNS(NS, "feConvolveMatrix");
        // Kernel de sharpen suave: realca o texto sem halo forte.
        kernel.setAttribute("order", "3");
        kernel.setAttribute("kernelMatrix", "0 -1 0 -1 5 -1 0 -1 0");
        kernel.setAttribute("preserveAlpha", "true");
        filter.appendChild(kernel);
        svg.appendChild(filter);
        (document.body || document.documentElement).appendChild(svg);
      }
      // Reaproveitavel por CSS: as tiles podem usar var(--bd-sharpen).
      document.documentElement.style.setProperty("--bd-sharpen", "url(#bd-sharpen-filter)");
    } catch (error) {
      note("sharpen-erro", "nitidez-erro", String(error && error.message).slice(0, 80));
      return false;
    }

    const apply = () => {
      try {
        for (const video of document.querySelectorAll("video")) {
          const rect = video.getBoundingClientRect();
          if (rect.width < 300 || rect.height < 170) continue; // so o player de verdade
          if (video.style.filter === "url(#bd-sharpen-filter)") continue;
          video.style.filter = "url(#bd-sharpen-filter)";
        }
      } catch (_) {}
    };
    try {
      apply();
      new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
      setInterval(apply, 3000);
    } catch (_) {}
    state.sharpenInstalled = true;
    report("nitidez", "feConvolveMatrix no player (opt-out SHARPEN_STREAM)");
    return true;
  }

  // item 6 (parte de runtime) - embrulha o graph handler do fundo de camera.
  // Guardado pelo proprio CAMERA_BACKGROUND: vazio = desligado.
  function wrapCameraBackground() {
    if (!CAMERA_BACKGROUND) { note("camera-off", "camera-bg", "desligado (CAMERA_BACKGROUND vazio)"); return false; }
    if (state.cameraWrapped) return true;
    let handlers = 0;
    let presets = 0;
    for (const id of Object.keys(require.c)) {
      let exports;
      try { exports = require.c[id] && require.c[id].exports; } catch (_) { continue; }
      if (!exports || typeof exports !== "object") continue;
      let values;
      try { values = [exports, exports.default].concat(Object.values(exports)); } catch (_) { continue; }
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        let keys;
        try { keys = Object.getOwnPropertyNames(value); } catch (_) { continue; }
        for (const key of keys) {
          let item;
          try { item = value[key]; } catch (_) { continue; }
          // (a) lista de presets de fundo: acrescenta o nosso.
          if (Array.isArray(item) && item.length && item[0] && typeof item[0] === "object"
            && ("thumbnail" in item[0] || "url" in item[0] || "image" in item[0] || "src" in item[0])) {
            let has = false;
            for (const entry of item) { try { if (entry && entry.id === "bd-custom") has = true; } catch (_) {} }
            if (!has) {
              try {
                item.push({ id: "bd-custom", name: "bigducks", url: CAMERA_BACKGROUND, image: CAMERA_BACKGROUND, thumbnail: CAMERA_BACKGROUND });
                presets += 1;
              } catch (_) {}
            }
            continue;
          }
          // (b) graph handler: funcao exportada com "background" no nome.
          if (typeof item !== "function" || item.__bdCamera || !/background/i.test(key)) continue;
          const wrapper = function () {
            try {
              const args = Array.prototype.slice.call(arguments);
              for (const arg of args) {
                if (arg && typeof arg === "object" && arg.backgroundImage == null && arg.imageUrl == null) {
                  arg.backgroundImage = CAMERA_BACKGROUND;
                }
              }
            } catch (_) {}
            return item.apply(this, arguments);
          };
          wrapper.__bdCamera = true;
          try { value[key] = wrapper; handlers += 1; } catch (_) {}
        }
      }
    }
    state.cameraWrapped = true;
    if (handlers || presets) {
      report("camera-bg", "presets=" + presets + " handlers=" + handlers + " url=" + String(CAMERA_BACKGROUND).slice(0, 60));
      return true;
    }
    note("camera", "camera-bg-sem-alvo", "modulo de background nao achado");
    return false;
  }

  // Relata UMA vez por sessao (a injecao repete a cada modulo novo).
  function note(key, name, data) {
    state.notes = state.notes || {};
    if (state.notes[key]) return false;
    state.notes[key] = true;
    report(name, data);
    return true;
  }

  // ---- patchear a FABRICA antes da primeira execucao ------------------------
  //
  // Esta e a tecnica definitiva (a mesma do Vencord): o `require.m` guarda as
  // factories de TODOS os modulos do chunk, executados ou nao. Se a gente troca a
  // factory ANTES do primeiro require, o modulo ja NASCE patcheado - e o problema
  // todo de "Object.freeze + consumidor com referencia antiga" deixa de existir,
  // porque nao ha versao velha.
  function patchFactoriesEarly(needle, mutate) {
    let patched = 0;
    for (const id of Object.keys(require.m || {})) {
      let factory;
      try { factory = require.m[id]; } catch (_) { continue; }
      if (typeof factory !== "function" || factory.__bdPatched) continue;

      // JA EXECUTADO: patchear a factory nao muda nada em runtime - e ainda
      // ATRAPALHA, porque a fonte passa a vir patcheada e o patch tardio (que
      // re-executa o modulo) acha que nao tem o que fazer e pula. Deixa pro
      // caminho tardio.
      if (require.c && require.c[id]) continue;

      let source;
      try { source = Function.prototype.toString.call(factory); } catch (_) { continue; }
      if (source.indexOf(needle) === -1) continue;

      let rewritten = null;
      try { rewritten = mutate(source); } catch (error) {
        // Um mutate que estoura NAO pode abortar o plugin inteiro: hoje um throw
        // aqui derruba as regras seguintes E os itens de runtime (tudo abaixo).
        // Isola por modulo e segue (o `patchIncoming` ja' faz isto).
        report("nitro-mutate-erro", id + " " + needle + ": " + String(error && error.message).slice(0, 80));
        continue;
      }
      if (!rewritten || rewritten === source) continue;

      try {
        const rebuilt = new Function("return (" + normalize(rewritten) + ")")();
        rebuilt.__bdPatched = true;
        require.m[id] = rebuilt;
        patched += 1;
        report("nitro-early", "modulo " + id + " " + needle + " (A TEMPO: ainda nao executado)");
      } catch (error) {
        report("nitro-early-erro", id + ": " + String(error && error.message).slice(0, 80));
      }
    }
    return patched;
  }

  // PRIMEIRO: patchear as FACTORIES (antes de qualquer re-execucao). Se a gente
  // chegar a tempo, o modulo nasce certo e nada mais e necessario.
  patchFactoriesEarly("STREAM_HIGH_QUALITY", grantStreamPerk);
  patchFactoriesEarly("stream-settings-fps-", forceMaxAllowed);
  patchFactoriesEarly('"canStreamWithSettings"', allowAll);
  patchFactoriesEarly("2026-05-frontier-tuning", killTierExperiment);
  // itens novos da rodada (2/5/6/7): mesma via "a tempo" pra factory ja
  // registrada mas ainda nao executada.
  patchFactoriesEarly("canStreamQuality", hardenGates);
  patchFactoriesEarly("getMaxFileSize", raiseUploadLimit);
  patchFactoriesEarly("photoshop", raiseUploadLimit);
  patchFactoriesEarly("CLIPS_FRAME_RATE", extendClips);
  patchFactoriesEarly("CLIPS_LENGTH", extendClips);
  patchFactoriesEarly("backgroundReplacement", injectCameraBackgroundPreset);

  const patched = patchFactories('"canStreamWithSettings"', allowAll);
  // o menu (mesma tecnica): solta o clamp do limite do tier
  patchFactories("stream-settings-fps-", forceMaxAllowed);
  // a perk: mata o banner do picker e o modal de upsell na raiz
  patchFactories("STREAM_HIGH_QUALITY", grantStreamPerk);
  // o experimento de tier: e ele que devolve maxFPS:30/maxResolution:1080
  patchFactories("2026-05-frontier-tuning", killTierExperiment);
  // e o passo que realmente pega: distribuir as perks nos objetos vivos
  grantPerksToAllTiers();
  // e, ate o banner cair, mostra TODO mundo que fala da perk (o cheque de
  // entitlement esta nessa lista - e o log diz qual patchear)
  findPerkConsumers();
  // e CONSOME de fato o entitlement (fecha o gap do `perk-consumers`).
  bindPerkConsumer();

  // ---- itens novos: via TARDIA (modulos que executaram antes do gancho) -----
  patchFactories("canStreamQuality", hardenGates);
  patchFactories("getMaxFileSize", raiseUploadLimit);
  patchFactories("photoshop", raiseUploadLimit);
  patchFactories("CLIPS_FRAME_RATE", extendClips);
  patchFactories("CLIPS_LENGTH", extendClips);
  patchFactories("backgroundReplacement", injectCameraBackgroundPreset);

  // ---- itens novos: RUNTIME (nao reescrevem factory - so embrulham objeto) --
  // Cada um e guardado por `state`: a injecao repetida e no-op. O try/catch
  // externo garante que um item quebrado nunca derrube os outros.
  try { wrapCodecOptions(); } catch (error) { report("codec-erro", String(error && error.message).slice(0, 80)); }
  try { unlockExperiments(); } catch (error) { report("experimentos-erro", String(error && error.message).slice(0, 80)); }
  try { installSharpening(); } catch (error) { report("nitidez-erro", String(error && error.message).slice(0, 80)); }
  try { wrapCameraBackground(); } catch (error) { report("camera-bg-erro", String(error && error.message).slice(0, 80)); }

  // So reporta quando AUMENTA: na varredura seguinte o modulo ja esta patchado
  // e a contagem volta a 0 - isso nao e informacao, e ruido.
  if (patched > state.patched) {
    state.patched = patched;
    report("nitro-resultado", patched + " portao(oes) liberado(s) de " + moduleCount + " modulos");
  }

  // abordagem A (as listas do menu) - independe do portao
  extendPresetLists();
})();
