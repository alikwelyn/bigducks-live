# Telemetria opcional

A telemetria do BIG DUCKS LIVE vem **desativada por padrão**. Ela só é ativada por uma ação explícita no HUD ou pela configuração `telemetryEnabled` em `%LOCALAPPDATA%\DiscordStream\config.json`. O núcleo é a autoridade da preferência e sincroniza o estado com a bridge autenticada.

## O que pode ser enviado

Quando ativada, a telemetria usa somente eventos tipados e agregados:

- componentes `core`, `bridge` e `media`;
- códigos fechados de falha de inicialização, bridge, injeção, recuperação, áudio sem vídeo, timeout, desconexão RTC e diagnóstico RTC nativo;
- estado agregado, modo `gateway|full`, flags de disponibilidade/SSRC, contadores de pacotes/bytes/frames/receptores e buckets de duração;
- um evento `telemetry_test` apenas quando o usuário aciona **Enviar teste**.

O estado é deduplicado para evitar repetição de falhas de mídia. Heartbeats bem-sucedidos, polls, mudanças de rota e logs não são enviados.

## Limites de privacidade

Não são enviados IPs, tokens, URLs completas, caminhos locais, mensagens de erro, logs completos, IDs de usuário, guild, canal ou stream, valores de SSRC, screenshots, breadcrumbs, exceções ou stacks. O núcleo e a bridge removem os campos não permitidos antes do transporte. A bridge usa Sentry apenas no processo principal do Electron; nenhum renderer é instrumentado.

O tráfego do Sentry usa transporte HTTPS direto e não passa pelo PAC, relay SOCKS ou sessão de rede do Discord. Isso mantém a telemetria fora das decisões de roteamento e recuperação do BIG DUCKS.

## Controles e remoção

- **Ativar** inicializa o transporte e grava somente a preferência;
- **Desativar** bloqueia novos eventos, encerra o transporte e remove a fila local;
- **Enviar teste** envia um evento do núcleo e um da bridge, aguardando o flush limitado;
- **Apagar fila local** remove apenas `%LOCALAPPDATA%\DiscordStream\telemetry`, sem alterar a preferência.

Eventos que já chegaram ao Sentry não podem ser removidos pelo BIG DUCKS. Para apagá-los, use o Dashboard ou a API do Sentry com as permissões administrativas do projeto.

## Diagnóstico A/B de áudio sem vídeo

Para investigar o caso atual:

1. deixe a telemetria desativada e reproduza primeiro em uma sessão vanilla;
2. repita com a bridge/injeção do BIG DUCKS e ative a telemetria explicitamente;
3. use **Enviar teste** para confirmar o transporte e, depois, reproduza o Go Live;
4. compare a mesma versão do Discord, a versão anterior e a versão atual, registrando o horário local da sessão;
5. no HUD, abra **Detalhes técnicos** e correlacione o estado RTC nativo com os contadores agregados.

O diagnóstico nativo é somente leitura. Estados como `native_receiver_no_packets`, `native_decoder_stalled` e `native_transmitter_stalled` ajudam a separar sinalização/encaminhamento, decodificação e renderização sem transformar identificadores do Discord em telemetria. Nenhum evento deve ser interpretado como prova de uma correção de endpoint, proxy, codec ou DAVE sem um A/B reproduzível.
