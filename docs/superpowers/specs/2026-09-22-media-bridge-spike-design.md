# Spike — ponte de mídia do Discord (levar o orange para dentro da live)

Data: 2026-09-22
Status: spike em avaliação (branch `feat/bigducks-media-bridge`)
Objetivo: provar que é possível assumir os frames que o Discord desenha para uma
Go Live e alimentá-los por um transporte próprio (orange/P2P), mantendo a UI
nativa do Discord como casca.

## Contexto

A intenção do produto é: o usuário clica em **Compartilhar tela** no Discord,
passa pelo seletor nativo, e a live roda — mas a mídia não vai pelo SFU do
Discord, e sim pelo transporte do bigducks. Cada participante tem o programa
instalado, então o lado que assiste também é nosso.

A pergunta do spike era: **dá para trocar o miolo sem reescrever o cliente?**

## O que muda a premissa

No cliente oficial (Electron), ao contrário do cliente web:

- A captura, o encode e o transporte são **nativos**, dentro de
  `modules/discord_voice/discord_voice.node` (DXGI + D3D11/AMF/Intel +
  `gpu_encoder_helper.exe`).
- Não existe `getDisplayMedia` no renderer para live. O seletor de janela é
  nativo (`presentDesktopSourcePicker`).
- O contrato que o renderer enxerga é o `MediaEngineStore`/`VoiceEngine`, que a
  Vencord publica em `packages/discord-types`
  (`MediaEngineConnection.setStream`, `setGoLiveSource`, `setDesktopSource`,
  `getNextVideoOutputFrame`, `setVideoBroadcast`, `presentDesktopSourcePicker`…).
- O vídeo remoto é entregue ao renderer como `ImageData` e desenhado num
  `<canvas>` pelo próprio `discord_voice/index.js`
  (`addVideoOutputSink(sinkId, streamId, cb)` → `canvasContext.putImageData`).

Ou seja: capturar/encodar por dentro do motor nativo é caro. Mas **exibir**
frames que não vieram do SFU é barato, porque passa por um canvas.

## O que foi construído neste spike

`internal/bridge/assets-src/media_bridge_page.js` — script de página (mundo
principal do renderer) que:

1. adquire o motor nativo via
   `DiscordNative.nativeModules.requireModule("discord_voice")`;
2. envolve `addVideoOutputSink`, `getNextVideoOutputFrame` e
   `addDirectVideoOutputSink`, registrando os `sinkId`/`streamId` ativos;
3. instala um gancho em `CanvasRenderingContext2D.prototype.putImageData` que
   substitui o frame entregue pelo Discord por um padrão de teste;
4. mantém um fallback de repintura por `requestAnimationFrame` para o caminho
   "direct canvas";
5. expõe `__BIG_DUCKS_MEDIA__` (`status`, `enableTestPattern`,
   `disableTestPattern`, `setAutoTest`, `listSinks`, `rescan`) e
   `__BIG_DUCKS_MEDIA_SUMMARY__`.

Integração:

- `discord_bridge.js` injeta esse script em toda janela do cliente e expõe os
  comandos `media_probe` e `media_test_pattern`;
- `server.go` adiciona `Server.MediaProbe` e `Server.SetMediaTestPattern`;
- `scripts/build-bridge.mjs` embute o script de página via `define`
  (`__BIG_DUCKS_MEDIA_PAGE__`), então o arquivo continua sendo um probe
  autônomo colável no DevTools.

## Como testar (prova de runtime)

Sem precisar do orange: a prova é um **padrão de teste** aparecendo no lugar do
vídeo, dentro da UI do Discord.

1. Rápido, sem rebuild: abra o DevTools do Discord (`Ctrl+Shift+I`) e cole o
   conteúdo de `internal/bridge/assets-src/media_bridge_page.js`. Depois rode
   `__BIG_DUCKS_MEDIA__.setAutoTest(true)`.
2. Abra uma Go Live qualquer (de um amigo, ou a sua) e observe o canvas.
3. `__BIG_DUCKS_MEDIA__.status()` mostra `engine`, `sinkHook`, `putImageDataHook`,
   `sinkHookCalls`, `substitutedFrames`/`repaintedFrames` e os sinks vistos.
4. Caminho integrado: `MediaProbe`/`SetMediaTestPattern` no bridge (o renderer
   responde em JSON).

Vale registrar uma captura de tela do antes/depois.

## O que já está provado

- `node scripts/media-bridge-page.test.mjs` roda a página contra um mock de
  canvas/`DiscordNative` e confirma que o frame desenhado é substituído e que
  `getNextVideoOutputFrame` é assumido.
- `go test ./...` cobre o contrato do bridge e os novos comandos.

## Riscos e incógnitas

- O cliente moderno pode usar o caminho "direct canvas" (textura compartilhada,
  talvez WebGL) em vez de `putImageData`. Nesse caso o gancho de `putImageData`
  não dispara e sobra o fallback de repintura (só para canvas 2D).
- `DiscordNative` precisa existir no mundo principal do renderer. É o esperado,
  porque o próprio `discord_voice/index.js` o lê, mas só o teste real confirma.
- Nomes de módulos mudam entre versões do Discord; por isso os finders são
  defensivos e reportam no `status`.
- O **lado de envio** continua sendo o problema difícil: o motor nativo não
  aceita frames crus. As saídas mapeadas são `connection.setStream(MediaStream)`
  com o engine em `WEBRTC`, o framebuffer de video hook
  (`DiscordVideoHook_Framebuffer_Memory_`) ou não usar o encoder do Discord e
  mandar P2P puro.

## Próximo passo

1. Rodar o probe num Discord real com uma Go Live e confirmar qual caminho de
   renderização a versão atual usa (`substitutedFrames` vs `repaintedFrames` vs
   nenhum).
2. Se o lado de recepção confirmar, ligar `media_probe`/`media_test_pattern` a
   uma superfície de teste (control API/HUD ou flag de diagnóstico).
3. Abrir a frente do envio: decidir entre engine `WEBRTC` + `setStream` e o
   framebuffer do video hook, e medir custo de cada um.
