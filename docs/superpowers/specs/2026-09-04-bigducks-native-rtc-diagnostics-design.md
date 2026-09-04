# BIG DUCKS LIVE — Diagnóstico nativo do RTC do Go Live

**Data:** 2026-09-04  
**Status:** proposta para implementação; escopo somente leitura

## Objetivo

Descobrir em qual ponto o vídeo nativo do Go Live deixa de existir, sem aplicar uma recuperação especulativa. O diagnóstico deve distinguir:

1. transmissor sem captura/encode;
2. stream nativa criada, mas sem progresso de saída;
3. espectador com demanda positiva, mas sem receiver/pacotes de vídeo;
4. pacotes recebidos/descriptografados, mas sem frames decodificados;
5. falha de renderização posterior ao decoder.

A primeira mudança adiciona observabilidade. Nenhuma ação automática destrói conexão, fecha WebSocket, muda endpoint, força região, altera DAVE, codec, GPU, PAC ou proxy.

## Evidência que motiva o desenho

- O Discord Desktop atual usa o módulo nativo `discord_voice`; `window.RTCPeerConnection` não representa necessariamente a conexão real.
- O problema observado mantém áudio funcionando e vídeo ausente, com `RTC_CONNECTED`, stream registrada e guards sem bloqueio.
- O upstream dos issues #164/#195 mostrou que `Remote media sink wants:` e `getFilteredStats(2, callback)` são sinais úteis do transmissor, mas não provam recebimento no espectador.
- A diferença entre `receiver count`, pacotes, bytes, frames decodificados e renderização precisa ficar explícita para evitar atribuir uma falha de transporte a codec ou hardware.

## Arquitetura

A bridge carregada no processo principal registrará um preload de sessão no primeiro callback de `app.whenReady`, antes de o módulo principal oficial do Discord criar janelas. O preload executará no mundo isolado do Electron, interceptará somente o carregamento do módulo `discord_voice` e envolverá os factories `createVoiceConnectionWithOptions`, `createOwnStreamConnectionWithOptions` e `VoiceConnection` sem modificar argumentos ou retornos.

A bridge consultará o resumo nativo pelo `executeJavaScriptInIsolatedWorld(999, ...)`. Um probe separado no mundo principal observará somente a demanda `Remote media sink wants:` e a abertura de WebSockets `*.discord.media`. Os dois resumos serão correlacionados na bridge por janela temporal, sem enviar valores de SSRC ou identificadores Discord.

## Contrato de dados

O preload expõe apenas funções internas com nomes `__BIG_DUCKS_*` e retorna um resumo limitado:

```js
{
  installed: true,
  voiceHooked: true,
  connections: [{
    kind: "voice" | "stream" | "unknown",
    ageMs: 0,
    destroyed: false,
    stats: {
      available: true,
      audioPackets: 0,
      videoPackets: 0,
      audioBytes: 0,
      videoBytes: 0,
      audioFrames: 0,
      videoFrames: 0,
      captureFrames: 0,
      encodedFrames: 0,
      framesDecoded: 0,
      framesDropped: 0,
      receiverCount: 0,
      hasAudioSsrc: false,
      hasVideoSsrc: false,
      width: 0,
      height: 0,
      inputFPS: 0,
      encodedFPS: 0
    }
  }],
  demand: { known: true, active: true, ageMs: 0 },
  mediaSocket: { seen: true, ageMs: 0 }
}
```

Campos desconhecidos ficam `null`/`false`; o normalizador aceita somente chaves numéricas conhecidas, limita contadores a `Number.MAX_SAFE_INTEGER` e troca qualquer SSRC por um booleano de presença. Shape de objeto desconhecido vira apenas uma assinatura de chaves sanitizada, sem valores.

A bridge envia ao núcleo eventos agregados, por exemplo:

```json
{
  "type": "media_event",
  "event": "native_rtc_snapshot",
  "at": "2026-09-04T00:00:00Z",
  "native": {
    "hooked": true,
    "streamConnection": true,
    "statsAvailable": true,
    "demandActive": true,
    "hasAudioSsrc": true,
    "hasVideoSsrc": false,
    "audioPackets": 30960,
    "videoPackets": 0,
    "audioFrames": 0,
    "videoFrames": 0,
    "captureFrames": 0,
    "encodedFrames": 0,
    "framesDecoded": 0,
    "receiverCount": 0
  }
}
```

`session`, stream key, usuário, guild, canal, host completo e SSRC não entram nesse contrato.

## Classificação

A redução local usará estados mutuamente informativos:

- `native_probe_unavailable`: preload ausente, API isolada indisponível ou shape incompatível;
- `native_transmitter_stalled`: captura/encode sem progresso durante demanda ativa;
- `native_receiver_audio_only`: áudio progride, vídeo não tem SSRC/pacotes/frames;
- `native_receiver_no_packets`: receiver sem pacotes enquanto há demanda;
- `native_decoder_stalled`: vídeo tem pacotes/bytes, mas não há frames decodificados;
- `native_render_unknown`: decoder progride, mas o diagnóstico posterior não confirma renderização;
- `native_rtc_disconnected`: conexão nativa destruída ou desconectada.

A classificação exige amostras consecutivas e janela mínima para não confundir aquecimento ou renegociação normal com falha. Uma única amostra nunca gera uma conclusão.

## Segurança e compatibilidade

- O preload é idempotente e não impede o Discord de iniciar se o módulo mudar.
- O wrapper preserva `this`, argumentos, promises, exceções e retornos originais.
- O mundo principal não recebe código de recuperação.
- Falhas do probe são registradas localmente e não alteram a rota.
- A bridge continua funcional quando `registerPreloadScript` ou `executeJavaScriptInIsolatedWorld` não existem.
- O código não instala handlers globais nos renderers do Discord.

## Testes e critério de aceite

- Testes JS de normalização cobrem payload outbound, receiver, shape desconhecido, contadores inválidos e remoção de SSRC/IDs.
- Testes Go cobrem a validação do protocolo, redução de estados e ausência de transição com uma amostra isolada.
- O asset gerado contém o registro do preload, o mundo 999, os factories nativos e `getFilteredStats(2, callback)`.
- A reprodução do áudio sem vídeo produz no log local uma sequência suficiente para responder se a ausência ocorre antes dos pacotes, após a descriptografia ou no decoder.
- Não existe recuperação automática nesta mudança; qualquer correção só será planejada depois da evidência A/B entre Discord vanilla/injetado e versões 1.0.9255/1.0.9256.
