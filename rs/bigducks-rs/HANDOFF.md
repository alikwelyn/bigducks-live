# HANDOFF — bigducks-rs

Documento para continuar em uma sessao nova sem repetir os becos. Tudo aqui foi
verificado no cliente real (Discord 1.0.9258 / Canary 1.0.1187, Windows).

---

## 1. O que e o projeto

`rs/bigducks-rs` — motor em Rust + bridge injetado no **Discord original**.
Sem Activity, sem proxy, sem `*.discord.media`. O video sai da captura Rust, vira
MediaStream, atravessa **WebRTC P2P** e e injetado no `<video>` do player nativo.

## 2. O que esta funcionando e verificado

```
✅ injecao automatica (run.cmd instala e sobe tudo; uninstall.cmd restaura)
✅ botao nativo "Compartilhar tela" liberado (videoEnabled: true)
✅ escolha do modal chega no motor (janela E tela)
      preload: setDesktopSourceWithOptions {type=window,sourceId=12190818, ...}
      source selecionada: window:12190818 -> Window(12190818)
✅ painel nativo controla a NOSSA captura ao vivo
      encodingVideoWidth/Height/FrameRate/MaxBitRate -> /settings -> capture: 1280x720 @ 30 fps
✅ P2P + injecao no player (video-health readyState:4, 1280x720)
✅ limpeza ao trocar de servidor; trocar de tela sem reiniciar
✅ --nitro: /plugins.js so existe com a flag (404 sem ela); o preload carrega
❌ bypass de Nitro efetivo (o portao nao foi patchado) — ver secao 6
```

## 3. Mapa dos arquivos

```
src/main.rs      axum: /ws (feed), /hub (P2P), /source, /settings, /bridge-event,
                 /plugins.js, /test-publish; AppState{ settings, selection, nitro }
src/capture.rs   xcap: Monitor/Window/Process/Screen(HMONITOR).
                 Capturer::capture(&selection, width, height) — tamanho vem por chamada
src/install.rs   injecao modelo Vencord: troca resources/app.asar por uma PASTA stub
                 (package.json + index.js) que require o bridge e depois o asar original
                 (backup em DiscordStream/injection-backups/)
web/main-bridge.js  processo principal: aponta o preload do Discord pro nosso
web/preload.js      ★ A PECA CHAVE (ver secao 4)
web/renderer.js     mundo principal: hook do srcObject, injecao no player, WebRTC P2P,
                    applyBitrate, loadExperiments/unlock
web/plugins.js      ★ a completar (bypass Nitro)
```

## 4. As descobertas que custaram a sessao (NAO REPETIR OS BECOS)

### 4.1 `discord_voice` nao e o addon — e um ARQUIVO JS que o envolve
Ele expoe `createOwnStreamConnectionWithOptions`, `setDesktopSource(id,hook,type)`,
`setDesktopSourceWithOptions(options)`, `presentNativeScreenSharePicker`,
`addDirectVideoOutputSink`, `getNextVideoOutputFrame`. E ali que o `sourceId` passa.

### 4.2 Em runtime esse modulo e intocavel (provado)
```
voice-identity {same:false}                        -> cada requireModule devolve OBJETO NOVO
require-wrap-failed {frozen:true, extensible:false} -> nativeModules e congelado
module-wrapped {wrapped:12, attempted:12}           -> o patch pega, mas no objeto ERRADO
```
Conclusao: patchear o modulo nativo por dentro **nao funciona** nessa versao.

### 4.3 A via que FUNCIONA: o preload + o carregador do Node
`web/preload.js` roda antes da pagina, **com sandbox desligado** (tem `require`).
Ele instala:
```js
Module._load = function (request) {
  const result = original.apply(this, arguments);
  if (/discord_voice/i.test(request) && looksLikeVoiceEngine(result)) return decorate(result);
  return result;
};
```
Assim **toda copia que sai do carregador ja nasce decorada** — inclusive a que o
Discord guarda. E a decoracao envolve (sem alterar comportamento):
`createOwnStreamConnectionWithOptions/createVoiceConnectionWithOptions` -> o objeto
devolvido -> `setDesktopSource` / `setDesktopSourceWithOptions` (le o `sourceId`),
mais `presentNativeScreenSharePicker`. Tambem envolve `setTransportOptions` e
`setGoLiveDevices` para ler resolucao/fps/bitrate.

### 4.4 Formatos do `sourceId` (medidos)
```
type=window        sourceId=12190818   -> HWND            -> xcap Window(12190818) ✔
type=screen-handle sourceId=131073     -> HMONITOR        -> GetMonitorInfoW + casar
                                                            o monitor pelo retangulo ✔
```
Nunca tratar o id cru: sem tipo, um handle de monitor vira "uma janela qualquer"
(esse bug existiu: `131073 -> Window(131073)`).

### 4.5 Chaves reais da qualidade
```
encodingVideoWidth / encodingVideoHeight / encodingVideoFrameRate / encodingVideoMaxBitRate
```
IGNORAR: `encodingVoiceBitRate` (bitrate de VOZ — ja virou "0 Mbps" no log),
`remoteSinkWants*` (o que o ESPECTADOR quer — fazia o fps oscilar 20↔30) e o
tamanho de MINIATURA (130x130) que vem junto com a fonte.

### 4.6 Vias mortas (nao insistir)
```
dispatcher do Flux -> actions-sample so mostra as NOSSAS acoes (APEX_*)
modulo webpack da engine -> engine-deep {hit:""} (nao e export de topo)
fetch do renderer para 127.0.0.1 -> bloqueado pela CSP da pagina (usar o preload,
   que usa http do Node)
```

## 5. Protocolo de teste (rapido)

1. Fechar Discord e Canary **inclusive na bandeja**
2. `D:\discord\rs\bigducks-rs\run.cmd` (ja tem `--nitro`; tire a flag pra desligar)
3. Abrir os dois Discords
4. Log do motor: `preload: hook Module._load instalado` + `engine-decorado ...`
5. Compartilhar tela (janela ou tela) e conferir `source selecionada: ...`
6. Mexer no painel de qualidade e conferir `qualidade: ...` + `capture: ...`

Build/instalar: `cargo build --release` e `target\release\bigducks-rs.exe --install`.

## 6. BYPASS DE NITRO — parte 1 FEITA; parte 2 (UI) escolhida pelo usuario

### 6.1 Permissao — FEITO e confirmado no cliente
`web/plugins.js` reescreve a fonte da factory do modulo **327649** e re-avalia
(tecnica do Equicord). Log real:
```
preload: nitro-patch modulo 327649 "canStreamWithSettings"
preload: nitro-resultado 1 portao(oes) liberado(s) de 8332 modulos
```
Detalhes que custaram rodadas e NAO podem ser perdidos:
- `requireModule`/`nativeModules` nao servem (secao 4.2) — a factory e outra coisa.
- `Function.prototype.toString` de modulo minificado devolve **metodo abreviado**
  (`327649(e,t,n){...}`) — nome NUMERICO, e `function 327649()` e invalido: o nome
  tem que SAIR (`function (e,t,n){...}`). Ver `normalize()` em plugins.js.
- NUNCA `Object.assign(exportsNovo, exportsVelho)`: o `n.d` do webpack cria getters
  **nao-configuraveis** e a atribuicao simples estoura. Usar `Object.defineProperty`
  por chave em try/catch (copia best-effort).
- `delete require.c[id]` + `require(id)` re-executa; consumidores que carregarem
  DEPOIS (painel abre lazy) pegam o namespace patchado.

### 6.2 UI — patches implementadas (A, C e D). Aguardando teste

> **C — clamp do tier:** no menu, `G = <res>===w?.maxResolution && <fps>===w?.maxFPS`
> prende o valor escolhido. `forceMaxAllowed` troca por `G=!0`. Log: `nitro-patch
> modulo 405916 stream-settings-fps-`.
> **D — a PERK (a que importa pro banner/modal):** banner do picker e modal de
> upsell NAO sao checagens separadas - respondem a perk `STREAM_HIGH_QUALITY`
> (`q = new M(T.w.STREAM_HIGH_QUALITY)`). `grantStreamPerk` concede a perk
> (override de hasPremium/hasBoost/isAvailable/isOwned/hasFreePremium).
> Log esperado: `nitro-patch modulo <id> STREAM_HIGH_QUALITY`.
> **A — listas:** `extendPresetLists` reconhece fps (`ce`, [15,30]) e resolucao
> (`Jk`, [480,720,1080,1440,0] -> o 0 tem que ser ignorado, senao a lista toda e
> descartada) e so precisou adicionar 60/120 FPS - 1080/1440 ja existiam.
> **NAO RESOLVEU o banner/modal** (testado no cliente): acrescentar a perk nas
> listas dos tiers 0 e 1 (`el=Object.freeze({[TIER_0]:new R(...),...})`) **nao**
> derrubou nem o banner do picker nem o modal. Ou seja: a checagem nao consulta a
> lista do tier - consulta outra coisa (metodo da classe `R`, ou o proprio
> experimento/entitlement). **Proximo passo preciso:** achar onde a perk e
> CONSULTADA (por referencia ao `q`, nao por offset - os dumps por offset caíram
> em modulos errados duas vezes), ou ir pelo caminho pragmatico de DOM (esconder
> o banner e o modal no renderer, que foi o que o usuario pediu).
> **Retry do plugin:** resolvido - o `executeJavaScript` devolve o ultimo valor, o
> plugin expoe `window.__bdNitroState.patched`, e o preload para de tentar
> (`plugins-ok patch aplicado na tentativa N`).


> `web/plugins.js` agora, alem do portao, roda `extendPresetLists()`: acha as listas
> de preset (arrays `{value,label}` com valores na lista branca de fps ou de
> resolucao) e acrescenta **60/120 FPS** e **1080p/1440p**. O proprio Discord
> desenha os itens novos com o codigo dele — zero JSX nosso.
> Lista branca obrigatoria: sem ela, `[1,2,3]` era classificado como fps (falso
> positivo que poluiria listas alheias).
> Log esperado: `nitro-presets modulo <id> exports[<key>] + 1080p/1440p` (e `+ 60/120 FPS`).
> Se **nao** aparecer `nitro-presets`, as listas nao sao exports de topo -> cair na
> abordagem B (injetar elementos em `children:F})` / `children:B})`, ancoras abaixo).

Estado: opcoes continuam **travadas** e o modal de upsell aparece MESMO com o portao
liberado. O gate decide *permissao*; a **lista de opcoes + o aviso** sao outra via.

**DUMP FEITO (codigo cru dessa build, offset ~3069539 no web.*.js):**

```js
let k = x(c),
  F = y.ce.map(e => { let {value:t,label:n,subtext:r}=e, a=x(t),
        l=(0,m.A)(y.jQ.PRESET_CUSTOM,a,t,h,I,M);
      return (0,i.jsx)(s.iD,{ group:"stream-settings-fps",
        id:`stream-settings-fps-${t}`, label:n, subtext:r, checked:t===c,
        action:()=>{ G&&t===c||P(l,a,t,L.AnalyticsObjectTypes.RESOLUTION) } },
        `stream-settings-fps-${t}`) }),
  B = y.Jk.map(e => { let {value:t,label:n,subtext:r}=e,
        a=(0,m.A)(y.jQ.PRESET_CUSTOM,t,U,h,I,M);
      return (0,i.jsx)(s.iD,{ group:"stream-settings-resolution",
        id:`stream-settings-resolution-${t}`, label:n, subtext:r, checked:t===k,
        action:()=>{ G&&t===k||P(a,t,U,L.AnalyticsObjectTypes.RESOLUTION) } },
        `stream-settings-resolution-${t}`) });

return (0,i.jsxs)(i.Fragment,{ children:[
  (0,i.jsx)(s.rX,{ label:v.intl.string(v.t.SkkeIt),  children:F }),   // <-- FPS
  (0,i.jsx)(s.rX,{ label:v.intl.string(v.t.rHyPXg), children:B })     // <-- RESOLUCAO
]})
```

**Conclusoes praticas:**
- `v.t.SkkeIt` = SCREENSHARE_FRAME_RATE e `v.t.rHyPXg` = STREAM_RESOLUTION
  (sao os `#{intl::...}` do Equicord, no bundle cru).
- **As ancoras boas sao as strings nao-minificadas** `stream-settings-fps-` e
  `stream-settings-resolution-`, nao as chaves de i18n (que mudam de build).
- Os pontos de injecao sao os dois `children:F` / `children:B` no Fragment final.
- O codigo injetado roda DENTRO do closure do modulo, entao tem acesso a
  `i` (jsx runtime), `s` (namespace do menu), `P` (funcao que aplica), `m.A`
  (monta o preset) e `y.jQ.PRESET_CUSTOM` — **nao precisa redescobrir componentes**;
  basta capturar esses identificadores com grupos de captura na regex do patch.
- `s.iD` = item de lista (radio com `checked`/`action`) e `s.rX` = submenu com label.
  O `CustomRange` do Equicord usa `MenuControlItem`+`MenuSliderControl`, que vivem no
  mesmo namespace `s` — se der, usar preset items (so `s.iD`) e evitar o slider.

**Patch proposto (vanilla, cirurgico):** transformar
`children:F})` -> `children:[...F,...globalThis.__bdRanges({jsx:i,Item:s.iD,apply:P,build:m})]})`
(idem para `B`), com o helper definido em `plugins.js` e reportando via `nitro-patch`.

### 6.4 RESOLVIDO — a licao que fechou tudo: TIMING

```
nitro-early modulo 158045 STREAM_HIGH_QUALITY (A TEMPO: ainda nao executado)
nitro-early modulo 405916 stream-settings-fps- (A TEMPO: ainda nao executado)
nitro-early modulo 327649 "canStreamWithSettings" (A TEMPO: ainda nao executado)
nitro-early modulo 248174 2026-05-frontier-tuning (A TEMPO: ainda nao executado)
qualidade: 2560x1440 @ 60 fps, 9 Mbps
```

**O que faltava era o RELOGIO, nao o patch.** O runtime do webpack aparece ANTES dos
chunks que contem os nossos modulos. O plugin tentava a cada 6 s e chegava na
tentativa 2 - quando os quatro ja tinham executado (`TARDE` no log). Com retry de
~150 ms no inicio, o gancho do push entra no ar e as factories sao patchadas
**antes de existir**: sem versao velha, `Object.freeze` e referencias antigas
deixam de ser problema.

**Os cinco patches que fazem o painel nativo liberar 1440p/60-120:**
| camada | modulo | patch |
|---|---|---|
| permissao | 327649 `canStreamWithSettings` | `return !0` |
| clamp do menu | 405916 | `G=!0` + `if(!0){` no callback `P` (mata o modal) |
| perk | 158045 `STREAM_HIGH_QUALITY` | entra nas listas TIER_0/TIER_1 |
| limite de tier | 248174 `2026-05-frontier-tuning` | `return null!=s.maxBitrate?s:null` -> `return null` |
| fps extra | 753070 (lista `ce`) | +60/120 FPS |

**Diagnosticos que NAO devem ser removidos** (custaram rodadas): `nitro-early`
(A TEMPO vs TARDE e o indicador de timing), `nitro-patch` (por modulo),
`earlyHook` no probe e `cdp-ok/cdp-erro`.

**Descartado de proposito:** o CDP (`Page.addScriptToEvaluateOnNewDocument`) -
injeta com sucesso mas so vale pros PROXIMOS documentos, e o documento do Discord
ja existe quando o comando chega. O retry rapido no preload faz o mesmo trabalho
por outro caminho. `Object.assign` em exports do webpack (getters
nao-configuraveis). Patchear a factory de modulo ja executado (nao muda runtime e
ainda bloqueia o patch tardio).

Poder escolher 1080p/1440p/60 **na UI nativa**, sem o modal — e o laco ja existente
(secao 2) leva isso pro motor. A qualidade em si NAO depende do encoder do Discord:
a captura e nossa.


**Sintoma:** ao mudar fps/resolucao, o Discord abre o modal "Desbloqueie a
transmissao em HD 4k a 60 fps" e nao aplica. Sem isso o painel nao oferece
1080p/1440p/60, e o laco de qualidade nao tem o que repassar.

**O que eu tentei e NAO funciona:** trocar o *export* da funcao portao por
`() => true`. Resultado: `nitro-resultado 0 funcoes`. Motivo: o portao e chamado
**de dentro do proprio modulo** (referencia local), entao trocar o export e
invisivel para quem chama.

**O que os mods fazem (fonte: Equicord `limitlessScreenshare`):** eles reescrevem
o **codigo-fonte da factory do modulo** e re-avaliam. Patch exato deles:
```js
{ find: '"canStreamWithSettings"',
  replacement: { match: /(?=if\(\i===\i\.\i.PRESET_AUTO\))/, replace: "return !0;" } }
{ find: '"stream-option-notify"',  // o modal de upsell
  replacement: [ ...troca os children por sliders... ] }
```

**Como portar para o nosso `web/plugins.js`** (nao precisa Vencord):
```js
const require = webpackRequire();              // chunk.push([[Symbol()],{},r=>r])
for (const id of Object.keys(require.c)) {
  const factory = require.m && require.m[id];   // a FACTORY, nao o exports
  if (typeof factory !== "function") continue;
  const source = Function.prototype.toString.call(factory);
  if (!source.includes('"canStreamWithSettings"')) continue;
  const at = source.indexOf("PRESET_AUTO");
  const ifAt = source.lastIndexOf("if(", at);
  const patched = source.slice(0, ifAt) + "return !0;" + source.slice(ifAt);
  const rebuilt = new Function("return (" + patched + ")")();   // mesma assinatura
  require.m[id] = rebuilt;
  delete require.c[id];
  const fresh = require(id);                    // re-executa
  Object.assign(require.c[id].exports, fresh);  // outros modulos seguram a ref antiga
}
```
Cuidados: a factory pode ser arrow/`use strict`; preservar a lista de parametros;
rodar DEPOIS que o bundle carrega (no boot o cache tem ~63 modulos, depois ~37k) —
por isso o plugin e injetado em loop pelo preload (24x a cada 6s) e ja e idempotente.
Reportar sempre: `nitro-patch {modulo, injetado}` e `nitro-resultado {N}`.

**Depois de patchado:** o painel deve oferecer 1080p/1440p/60 sem modal -> o laco
ja existente leva para `/settings` -> `capture:` muda ao vivo.

## 7. Pendencias conhecidas (fora do escopo desta frente)

```
- PCs diferentes: o hub e 127.0.0.1; o WebRTC ja usa STUN publico, falta o rendezvous remoto
- audio da live: nao implementado
- janelinha: so fallback; some quando o player nativo monta
- sliders proprios no painel (opcional): o Equicord tambem injeta ranges customizados
```

## 8. Comandos uteis

```
run.cmd  /  uninstall.cmd
http://127.0.0.1:8791/           painel (viewer)
http://127.0.0.1:8791/source?value=window:123    troca a fonte ao vivo
http://127.0.0.1:8791/settings?width=1920&height=1080&fps=30&bitrate=8000000
http://127.0.0.1:8791/bridge-event?name=x&data=y  aparece no log do motor
```

---

## 9. App de bandeja (Windows) — o que foi agregado por cima do motor

O binario continua o mesmo (motor + relay), mas no Windows agora ele e' um app
de bandeja "de amigo": dois cliques, sem terminal, com icone.

### 9.1 Icone
`build.rs` gera um `.ico` multi-tamanho (16/24/32/48/64/256) a partir do MESMO
logo do app Go (`imgs/big-ducks.png`, ver `internal/brand/brand.go`) e embute via
`winresource`. O `imgs/` fica na RAIZ do repo (fora deste crate) - por isso o
`build.rs` so' roda no Windows (com `build.rs` presente) e nao existe no container
Linux do relay. A bandeja usa o mesmo desenho (`src/icon.rs`) com um ponto de
estado: verde=relay conectado, ambar=sem canal de voz, azul=so' hub local,
vermelho=bridge nao instalado, roxo=update pronto.

### 9.2 Sem console
`#![cfg_attr(windows, windows_subsystem = "windows")]` no `src/main.rs`. TODO o
log vai para `%LOCALAPPDATA%\DiscordStream\engine.log` (rotativo 2 MB x 3:
`engine.log`, `.1`, `.2`) via `src/logging.rs`. `--console` chama
`AttachConsole`/`AllocConsole` (src/platform.rs) e o mesmo texto aparece no
terminal - os prints de diagnostico NAO foram perdidos.

### 9.3 Bandeja (`src/tray.rs`, crate `tray-icon`)
A thread principal bombeia mensagens Win32 (o runtime tokio fica nas threads de
trabalho). Menu: Abrir painel / Ver log / Reinstalar bridge / Reiniciar Discord /
Iniciar com o Windows (checkbox) / Sair. O estado vem de `src/status.rs`, que o
`/bridge-event` alimenta com o que o preload reporta (`hub-remoto` -> relay
conectado / sem canal de voz).

### 9.4 Reiniciar o Discord (`src/discord.rs`)
O asar so' e' lido no boot. Se a injecao MUDOU nesta execucao e o Discord esta
aberto, ele e' fechado com `WM_CLOSE` nas janelas de topo dos PIDs do Discord e
reaberto pelos MESMOS executaveis (caminho lembrado via `QueryFullProcessImageNameW`).
Sem prompt; avisa por balao.

### 9.5 Autostart (`src/autostart.rs`)
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` valor `BigDucksRS`
(`"...exe" --startup`), sem admin. Ligado na primeira execucao (nunca para
caminho temporario). Resolve tambem a ORDEM: o asar e' reescrito antes do Discord.

### 9.6 Auto-update (`src/update.rs`)
Manifest JSON em `https://desjanjador.skillup.com.br/release.json`, checado no
boot (~20s depois) e a cada 4h (desligue com `--no-update`). Compara versao
(`CARGO_PKG_VERSION`), baixa `bigducks-rs.exe`, confere SHA-256 + tamanho, e troca
o binario EM EXECUCAO (renomeia o atual para `.old`, poe o novo no lugar, reabre,
apaga o `.old` no proximo boot). Nunca troca no meio de uma transmissao.
O lado servidor vive no MESMO binario (`--relay`): rotas `/release.json`,
`/bigducks-rs.exe` e `/release/<arquivo>` a partir de `--release-dir`
(ou `BIGDUCKS_RELEASE_DIR`). Para publicar: jogue o exe em `releases/` + um
`version.txt` (gera o manifest na hora), ou o `release.json` pronto.

### 9.7 Flags novas
`--console`, `--no-install` (nao mexe no app.asar; util p/ subir a bandeja em
teste), `--no-update`, `--release-dir <dir>`, `--startup` (marcador do autostart).
`run.cmd` agora passa `--console` (dev) e segue funcionando.

