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

(function () {
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
    { needle: '"canStreamWithSettings"', mutate: allowAll }
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
      for (const rule of EARLY_RULES) {
        if (source.indexOf(rule.needle) === -1) continue;
        const rewritten = rule.mutate(source);
        if (!rewritten || rewritten === source) continue;
        try {
          modules[id] = new Function("return (" + normalize(rewritten) + ")")();
          patched += 1;
          report("nitro-chunk", "modulo " + id + " " + rule.needle + " (antes de executar)");
        } catch (error) {
          report("nitro-chunk-erro", id + ": " + String(error && error.message).slice(0, 80));
        }
        break;
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
      if (!module || typeof factory !== "function" || module.__bdPatched) continue;

      let source;
      try { source = Function.prototype.toString.call(factory); } catch (_) { continue; }
      if (source.indexOf(needle) === -1) continue;

      const rewritten = mutate(source);
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

      const rewritten = mutate(source);
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

  // So reporta quando AUMENTA: na varredura seguinte o modulo ja esta patchado
  // e a contagem volta a 0 - isso nao e informacao, e ruido.
  if (patched > state.patched) {
    state.patched = patched;
    report("nitro-resultado", patched + " portao(oes) liberado(s) de " + moduleCount + " modulos");
  }

  // abordagem A (as listas do menu) - independe do portao
  extendPresetLists();
})();
