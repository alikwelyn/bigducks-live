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

### Iterar no diagnóstico WebRTC sem reiniciar o Discord

Para desenvolvimento local, inicie uma vez:

```powershell
.\target\release\Desjanjador.exe --web-dev --no-install --no-restart --no-update
```

Com `--web-dev`, `/webrtc-test` e `/webrtc-test.js` são lidos do diretório `web/`
do checkout a cada requisição. Edite os arquivos e recarregue a página com
`Ctrl+F5`; não é preciso recompilar/reiniciar o Desjanjador nem reiniciar o
Discord. `--no-install` e `--no-restart` evitam tocar na injeção ou reiniciar o
Discord durante esse ciclo. O bridge precisa já estar instalado para os testes
integrados com o Discord.

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

## Rede entre PCs

O hub local sinaliza ofertas e candidatos; o relay remoto também leva apenas
sinalização. O vídeo usa WebRTC direto. Para redes cujo NAT/firewall bloqueia
essa ligação direta, configure um servidor TURN acessível pelos dois clientes.
No `%LOCALAPPDATA%\DiscordStream\remote-hub.txt`, mantenha URL/segredo na linha
1 e sala na linha 2; a linha 3 opcional recebe os servidores ICE em JSON, por
exemplo:

```json
[{"urls":"turn:turn.example.net:3478","username":"usuario","credential":"senha"}]
```

Sem TURN válido, STUN sozinho não garante conexão entre redes diferentes.
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

O diagnóstico visual fica em `http://127.0.0.1:8791/webrtc-test` (também no
menu da bandeja). Ele reúne três testes independentes:

1. **Rede/ICE:** DataChannel com ping, rota ICE selecionada, STUN/TURN e ICE
   restart. Para validar o loop local, selecione Local e clique em **Abrir par
   local**: o app abre uma segunda aba com o mesmo código e conecta as duas. Isso
   não mede NAT/Internet. Para testar NAT, selecione Relay nos dois PCs e use o
   mesmo código em redes diferentes. O relay carrega sinalização, não mídia.
2. **Mídia sem Discord:** canvas sintético testa WebRTC encode/decode. Captura
   Rust usa a fonte/configuração atuais do motor e envia os frames ao outro peer;
   não altere configurações enquanto uma live nativa estiver ativa.
3. **Discord E2E:** monitor passivo dos eventos locais do bridge; ele diferencia
   track anexada de primeiro frame realmente decodificado no player.

O relatório copiado omite IPs, candidates crus, código de sessão e credenciais.
Os logs do hub também resumem SDP/candidates sem registrar endereços de rede.
