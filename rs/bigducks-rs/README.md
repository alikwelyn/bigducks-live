# bigducks-rs

Rust + **Discord original**. Sem Activity, sem proxy, sem `*.discord.media`.

## O que está funcionando (tudo verificado)

```
1. run.cmd  ->  instala o bridge no Discord + sobe o motor e o hub
2. abra o Discord e o Canary  ->  o bridge carrega sozinho (sem colar nada)
3. o botao "Compartilhar tela" ESTA DISPONIVEL (videoEnabled: true)
4. clique nele e escolha a tela
   -> a MESMA trilha que o Discord capturou vai por P2P (WebRTC)
5. o outro cliente recebe e mostra no painel
```

### Provas coletadas nas rodadas de teste

| verificação | resultado |
|---|---|
| Discord não quebra | ✅ 3/3 aberturas, título normal, sem erro no processo principal |
| Botão do Go Live liberado | ✅ `videoEnabled: true` nas 3 rodadas |
| Hub de sinalização | ✅ 2 peers conectados (Stable + Canary) |
| **P2P de verdade** | ✅ `rendered { source: "p2p" }` — o cliente 1 publicou, o cliente 2 recebeu e exibiu |
| Feed de reserva (motor Rust) | ✅ ~15 fps contínuos no painel |
| Desinstalação | ✅ `uninstall.cmd` restaura o `app.asar` original |

## Como usar

```
1. Feche o Discord e o Canary por completo (inclusive na bandeja)
2. Dois cliques em run.cmd          (deixe a janela aberta)
3. Abra o Discord e o Canary
4. No Discord de quem transmite: Compartilhar tela -> escolha a tela
```

O painel no outro cliente aparece sozinho. O **x** fecha nesta sessão
(`Ctrl+R` no Discord reabre).

## Como cada peça foi resolvida

### Injeção (modelo Vencord)

```
resources/app.asar/          (virou PASTA; o asar original vai pra injection-backups)
  index.js -> require(DiscordStream/bigducks_rs_bridge.js)   <- hook do BrowserWindow
              require(injection-backups/<...>.asar)          <- Discord original
```

`bigducks_rs_bridge.js` troca o **preload** da janela; o preload injeta
`bigducks_rs_renderer.js` com `webFrame.executeJavaScript` **antes** dos scripts da
página.

### Webpack: o detalhe que muda tudo

```js
// O push do Discord E o webpackJsonpCallback e DEVOLVE o require:
const wreq = chunk.push([[Symbol("bd-rs")], {}, (require) => require]);
// NUNCA chamar chunk.pop() depois!
```

`push` **não acrescenta** nada ao array (ele É o callback do webpack). Então o
`pop()` removia um **chunk real** — o global chegava a ficar `undefined` e o
renderer quebrava (era a origem da **tela cinza** e do `setAppBadge`/NaN).

### Liberar o botão

O guard é uma linha no bundle do Discord:

```js
h = !useConfig({ location: "RTCConnection" }).videoEnabled
```

Um **único** override do experimento pelo Flux resolve:

```js
dispatcher.dispatch({ type: "APEX_EXPERIMENT_SESSION_OVERRIDE_CREATE",
                      experimentName: "2026-08-video-guard", variantId: 0 });
```

**Uma vez só.** Redespachar em loop derruba o Discord.

### Captura: o botão nativo passa por getDisplayMedia

No bundle do Discord:

```js
await navigator.mediaDevices.getDisplayMedia({ video: {...}, frameRate: 30 })
```

Então o hook pega a **mesma trilha** que o Discord já capturou e publica por P2P.
O envio pelo servidor do Discord pode falhar com `2012` — irrelevante, o vídeo já
está indo por P2P.

## Arquivos

| arquivo | o que é |
|---|---|
| `run.cmd` | compila (1ª vez) e roda o motor |
| `uninstall.cmd` | remove a injeção e restaura o Discord |
| `web/main-bridge.js` | processo principal: troca o preload |
| `web/preload.js` | injeta o renderer antes da página |
| `web/renderer.js` | unlock + hook de captura + P2P + painel |
| `src/main.rs` | `/` painel, `/ws` frames, `/hub` sinalização, `/test-publish` |
| `src/capture.rs` | captura de tela + downscale |
| `src/install.rs` | injeta/remove o stub no `app.asar` |

## Limites honestos

- **Mesmo PC.** O hub é `ws://127.0.0.1:8791`. Para PCs diferentes ele precisa ser
  alcançável pelos dois (o WebRTC/ICE já usa STUN público; falta o rendezvous).
- **Sem áudio** ainda.
- O painel é uma janelinha sobre o Discord (levar para o `<video>` nativo do
  stream é o passo seguinte).

## Diagnóstico

O motor loga o que os bridges reportam:

```
hub[1] <- {"type":"unlock","data":{"tries":2}}
hub[1] <- {"type":"experiment-rewrite","data":{"count":1}}
hub[1] <- {"type":"rendered","data":{"source":"p2p"}}
hub[1] <- {"type":"stats","data":{"frames":372}}
```

`GET /test-publish?publisher=<id>` testa o P2P sem clique (um publica, o outro
assiste). No console do Discord: `__BD_RS__.probe()`.
