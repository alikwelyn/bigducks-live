# Telemetria Sentry

A telemetria do BIG DUCKS LIVE vem **ativada por padrão** no `v0.1.8`. Configurações antigas sem o campo `telemetryEnabled` também usam esse padrão; um `false` explícito no HUD ou em `%LOCALAPPDATA%\DiscordStream\config.json` desativa o envio. O núcleo é a autoridade da preferência e sincroniza o estado com a bridge autenticada.

## O que pode ser enviado

Quando ativada, a telemetria usa somente eventos tipados e agregados:

- componentes `core`, `bridge` e `media`;
- códigos fechados `startup_failure`, `bridge_failure`, `injection_failure`, `recovery_failure`, `audio_only`, `video_stalled`, `receiver_timeout`, `rtc_disconnected`, `native_probe_unavailable`, `native_transmitter_stalled`, `native_receiver_no_packets`, `native_decoder_stalled`, `native_render_unknown` e `telemetry_test`;
- estado agregado, modo `gateway|full`, flags de disponibilidade/SSRC, contadores de pacotes/bytes/frames/receptores e buckets de duração;
- um evento `telemetry_test` apenas quando o usuário aciona **Enviar teste**.

O estado é deduplicado para evitar repetição de falhas de mídia. Heartbeats bem-sucedidos, polls, mudanças de rota e logs não são enviados.

## Limites de privacidade

Não são enviados IPs, tokens, URLs completas, caminhos locais, mensagens de erro, logs completos, IDs de usuário, guild, canal ou stream, valores de SSRC, screenshots, breadcrumbs, exceções ou stacks. O núcleo e a bridge removem os campos não permitidos antes do transporte. A bridge usa Sentry apenas no processo principal do Electron; nenhum renderer é instrumentado.

O tráfego do Sentry usa transporte HTTPS direto e não passa pelo PAC, relay SOCKS ou sessão de rede do Discord. Isso mantém a telemetria fora das decisões de roteamento e recuperação do BIG DUCKS.

## Controles e remoção

- o **switch de telemetria** inicializa ou encerra o transporte e grava somente a preferência;
- ao desligar, novos eventos são bloqueados e a fila local é removida;
- **Enviar teste** envia primeiro um evento do núcleo; a bridge envia seu próprio evento quando a integração instalada suporta telemetria;
- se o Discord já estava aberto durante a atualização, use **Corrigir Discord** uma vez para carregar a bridge Sentry atualizada;
- **Apagar fila local** remove apenas `%LOCALAPPDATA%\DiscordStream\telemetry`, sem alterar a preferência.

Eventos que já chegaram ao Sentry não podem ser removidos pelo BIG DUCKS. Para apagá-los, use o Dashboard ou a API do Sentry com as permissões administrativas do projeto.

## Diagnóstico A/B de áudio sem vídeo

Para investigar o caso atual:

1. reproduza primeiro em uma sessão vanilla; a telemetria já estará ativa no `v0.1.8`;
2. repita com a bridge/injeção do BIG DUCKS e mantenha a mesma configuração;
3. use **Enviar teste** para confirmar o transporte e, depois, reproduza o Go Live;
4. compare a mesma versão do Discord, a versão anterior e a versão atual, registrando o horário local da sessão;
5. no HUD, abra **Detalhes técnicos** e correlacione o estado RTC nativo com os contadores agregados.

O diagnóstico nativo é somente leitura. Estados como `native_receiver_no_packets`, `native_decoder_stalled` e `native_transmitter_stalled` ajudam a separar sinalização/encaminhamento, decodificação e renderização sem transformar identificadores do Discord em telemetria. Nenhum evento deve ser interpretado como prova de uma correção de endpoint, proxy, codec ou DAVE sem um A/B reproduzível.
