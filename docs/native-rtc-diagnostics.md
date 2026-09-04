# Diagnóstico nativo do Go Live

O BIG DUCKS registra o caminho nativo do `discord_voice` em modo somente leitura. O probe não troca proxy, região, endpoint, DAVE, codec, GPU, conexão ou estado de recuperação.

## Reprodução controlada

1. Feche o Discord e confirme que o BIG DUCKS está com `aggressiveRecovery: false`.
2. Execute uma sessão com Discord 1.0.9255 e salve `%LOCALAPPDATA%\\DiscordStream\\discordstream.log`.
3. Repita com Discord 1.0.9256.
4. Para cada versão, compare uma sessão em **estado vanilla** (loader restaurado) e uma em **estado injetado** (bridge ativa).
5. Faça um teste como espectador, entrando em uma transmissão já ativa, e outro como transmissor.
6. No HUD, abra os detalhes técnicos e anote a sequência de `diagnóstico RTC nativo`, sem copiar IDs, tokens ou URLs.
7. Preserve também os logs nativos do Discord apenas para análise manual local.

A comparação mínima é:

```text
Abrir uma live com Discord 1.0.9255
Abrir a mesma live com Discord 1.0.9256
estado vanilla
estado injetado
```

## Interpretação

- `native_probe_unavailable`: o preload, o mundo isolado 999 ou o shape da API não está disponível; não conclui que a rede falhou.
- `native_receiver_no_packets`: havia demanda, mas não houve progresso de pacotes de áudio/vídeo nem receiver ativo nas amostras consecutivas.
- `native_receiver_audio_only`: áudio progrediu e vídeo não apresentou SSRC/pacotes; prioriza assinatura, encaminhamento, descriptografia e DAVE antes de codec.
- `native_decoder_stalled`: pacotes/bytes de vídeo progrediram, mas frames decodificados não; investigar decoder, codec e aceleração somente neste caso.
- `native_transmitter_stalled`: captura progrediu, mas o encode não; investigar captura/encoder no transmissor.
- `native_render_unknown`: o caminho nativo não permite provar a etapa posterior à decodificação; não atribuir a falha à GPU sem evidência adicional.

Uma amostra isolada não é diagnóstico. Contadores que diminuem são tratados como nova geração e exigem aquecimento novamente.

## Privacidade

O contrato enviado pela bridge contém somente estados, booleanos e contadores agregados: `receiverCount`, pacotes, bytes, frames, FPS e presença de áudio/vídeo. O valor do SSRC nunca é enviado; somente `hasAudioSsrc` e `hasVideoSsrc` podem aparecer. Sessão, usuário, guild, canal, stream key, caminho local, URL, token e endpoint não fazem parte do payload.

## Regra para uma correção futura

Não tratar troca de endpoint, região, PAC, proxy ou reinício da transmissão como correção até que a comparação A/B isole o fator. Depois de obter uma sequência reproduzível, criar uma especificação separada para a menor mudança confirmada. O diagnóstico atual não executa recuperação automática.
