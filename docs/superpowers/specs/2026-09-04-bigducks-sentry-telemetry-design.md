# BIG DUCKS LIVE — Telemetria opcional com Sentry

**Data:** 2026-09-04  
**Status:** proposta aprovada em conversa; aguardando revisão do documento antes do plano de implementação

## Objetivo

Adicionar telemetria opcional ao BIG DUCKS LIVE em dois pontos:

1. núcleo Go, para falhas de inicialização, relay, recuperação, injeção e pipeline de mídia;
2. bridge carregada no processo principal do Electron do Discord, para falhas da própria bridge e eventos de mídia que ela receber.

A telemetria serve para diagnosticar regressões como o caso atual de áudio funcionando sem vídeo. Ela não altera roteamento, codecs, sinalização, DAVE ou a política de recuperação.

## Limites de privacidade

- A configuração inicial é sempre `telemetryEnabled: false`.
- A ativação exige ação explícita no HUD ou edição do `config.json`.
- Nenhum token, endereço IP, conteúdo de mensagem, URL completa, caminho local, nome de usuário, ID de usuário, ID de servidor, ID de stream ou SSRC será enviado.
- Não serão usados `setUser`, breadcrumbs automáticos, anexos de log, screenshots, tracing ou profiling.
- Erros enviados serão eventos nomeados por uma lista fechada de códigos; mensagens e stacks brutos permanecem apenas no log local.
- O SDK Go usará `SendDefaultPii: false` e um processador final que remove campos proibidos.
- O SDK Electron não terá handlers globais para os renderers do Discord. Instrumentar os renderers capturaria falhas do cliente oficial, fora do escopo. A bridge será instrumentada apenas no processo principal onde é carregada.
- No projeto Sentry será ativada a configuração de não armazenar endereços IP. A proteção do cliente sozinha não impede que o servidor veja o endereço de origem da requisição.
- A telemetria não usará o relay SOCKS/PAC do Discord e não fará parte da decisão de proteção da conexão.

## DSN e dependências

O DSN fornecido pelo proprietário ficará embutido:

- em uma constante do pacote de telemetria Go;
- no bundle JavaScript da bridge.

O DSN não será lido da configuração do usuário nem tratado como segredo.

O núcleo usará `github.com/getsentry/sentry-go`. A bridge usará `@sentry/electron`, empacotado em um único `discord_bridge.js` por um passo Node reproduzível, com dependência e lockfile fixados. O bundle gerado será validado no build para que a versão instalada não diverja silenciosamente da versão commitada.

A bridge não instalará `node_modules` dentro do diretório do Discord nem modificará o cache do Sentry do Discord. Qualquer fila/cache da telemetria do BIG DUCKS deverá ficar em diretório próprio dentro de `%LOCALAPPDATA%\\DiscordStream`.

## Arquitetura

### Pacote Go de telemetria

Criar um módulo pequeno e independente, responsável por:

- inicializar e fechar o cliente Sentry somente quando habilitado;
- expor operações `Enable`, `Disable`, `Purge` e `Test`;
- receber eventos tipados e permitidos, sem aceitar mapas arbitrários vindos de logs;
- aplicar normalização e sanitização antes de chamar o SDK;
- limitar duplicatas e frequência de eventos de mídia;
- nunca fazer a falha da telemetria interromper o núcleo.

O pacote terá uma interface de transporte ou reporter substituível nos testes. O código de produção não enviará exceções brutas; ele converterá falhas em códigos e campos numéricos/booleanos seguros.

### Configuração persistida

Adicionar `TelemetryEnabled bool` à configuração persistida como `telemetryEnabled`.

- Configuração nova: `false`.
- Configuração antiga sem o campo: `false`, por privacidade.
- `SaveConfig` preservará explicitamente o valor.
- Ativar/desativar pelo HUD atualizará o arquivo de forma atômica sem alterar `autoStartDiscord`, `disabled`, modo de roteamento ou qualquer outra preferência.

### Núcleo Go

O núcleo inicializará o reporter depois de carregar e normalizar a configuração. Quando desabilitado, nenhum cliente Sentry será criado e nenhum evento será enfileirado.

Serão reportados somente eventos explícitos e permitidos, por exemplo:

- falha fatal de inicialização do núcleo;
- falha de bridge/injeção/reparo;
- falha final de recuperação;
- `audio_only`, `video_stalled`, `receiver_timeout` e `rtc_disconnected`, com deduplicação por janela de tempo;
- evento de teste solicitado pelo usuário.

Eventos de mídia poderão conter estado, contagens agregadas, duração aproximada e flags como `hasVideoSsrc`, mas nunca o valor de `Session`, SSRC ou qualquer identificador Discord. Rotação normal de proxy, heartbeat bem-sucedido e atualizações de status não serão enviados.

### Bridge Electron

A bridge continuará sendo carregada pelo loader reversível existente. O bundle terá:

- inicialização tardia do Sentry somente após o núcleo confirmar que a telemetria está habilitada;
- captura explícita de falhas nas operações da bridge (`reload`, fechamento de conexões, resolução de PAC e conexão local);
- envio de eventos de mídia já sanitizados;
- deduplicação e limite local;
- nenhum handler automático de exceção/rejeição do Discord e nenhum código de captura nos renderers do Discord;
- comando de teste e comando de descarte da fila própria.

O protocolo local autenticado da bridge será estendido com comandos de telemetria. O núcleo será a autoridade do estado habilitado/desabilitado e sincronizará o estado atual quando a bridge conectar.

### Controle local e HUD

Adicionar ao `RuntimeControl` e à API autenticada do núcleo:

- estado de telemetria no `/v1/status`;
- `POST /v1/telemetry/enable`;
- `POST /v1/telemetry/disable`;
- `POST /v1/telemetry/test`;
- `POST /v1/telemetry/purge`.

Todos os endpoints exigirão o token local existente.

O HUD terá uma seção compacta de “Diagnóstico opcional” com:

- estado atual;
- botão para ativar;
- botão para enviar evento de teste;
- botão “Desativar e apagar dados locais”, com confirmação;
- texto informando que eventos já enviados precisam ser removidos pelo painel/API do Sentry.

A ação de teste enviará no máximo um evento Go e um evento Electron, ambos marcados como teste e sem dados de usuário. O resultado só será considerado sucesso após `Flush` com limite curto; falha de conectividade será mostrada no HUD sem alterar a proteção.

## Desativação e limpeza

Ao desativar:

1. novas capturas são bloqueadas imediatamente;
2. o cliente Go é fechado sem manter fila própria;
3. a bridge recebe o comando de desativação;
4. a fila/cache exclusivo do BIG DUCKS é descartada;
5. os arquivos locais de telemetria são removidos, sem tocar em arquivos do Discord;
6. o estado persistido fica `telemetryEnabled: false`.

Eventos já enviados não podem ser apagados pelo SDK local. O HUD documentará a remoção pelo Sentry Dashboard/API como operação separada.

## Taxonomia segura de eventos

Cada evento terá apenas:

- `release` do BIG DUCKS;
- componente (`core`, `bridge` ou `media`);
- código fechado do evento;
- versão principal do Windows/Discord apenas se puder ser obtida sem caminho ou identificador;
- modo de roteamento (`gateway` ou `full`);
- estados, contagens e flags técnicas agregadas.

O sanitizador removerá ou substituirá:

- IPv4/IPv6, portas e URLs;
- tokens, DSNs, cabeçalhos e query strings;
- caminhos contendo perfis locais;
- sequências numéricas longas que possam ser IDs Discord;
- `session`, `user`, `guild`, `channel`, `stream` e `ssrc`.

O log local continuará podendo conter detalhes técnicos necessários para depuração manual, mas não será anexado automaticamente ao Sentry.

## Testes

A implementação seguirá TDD, em ciclos red-green-refactor:

1. testes de configuração: default desativado, round-trip e compatibilidade com configurações existentes;
2. testes do sanitizador: remoção de IPs, tokens, URLs, caminhos e identificadores;
3. testes do reporter: nenhum envio desabilitado, teste limitado, deduplicação e falhas do transporte isoladas;
4. testes de purga: fila local própria removida sem tocar nos dados do Discord;
5. testes da API autenticada para estado, enable, disable, test e purge;
6. testes do protocolo da bridge para sincronização de estado e comandos;
7. testes da redução de mídia confirmando que somente transições de falha geram eventos;
8. testes do HUD para exibição e chamadas dos controles;
9. execução da suíte existente sem regressão.

A verificação final exigirá `go test ./...`, `go vet ./...`, `gofmt`, `git diff --check` e build Windows x64. O passo Node também deverá verificar o bundle da bridge antes do build/release.

## Não objetivos

- Não corrigir diretamente a ausência de vídeo nesta mudança.
- Não alterar PAC, proxies, fallback direto, DAVE, codecs, GPU ou endpoints RTC.
- Não capturar automaticamente toda a atividade do Discord.
- Não instrumentar renderers do Discord.
- Não enviar logs completos ao Sentry.
- Não apagar dados já enviados sem ação no Sentry.

## Critério de aceitação

A mudança será aceita quando:

- uma instalação nova permanecer sem tráfego Sentry até o usuário ativar;
- o HUD permitir ativar, testar, desativar e limpar a telemetria;
- os eventos de teste Go/Electron chegarem ao projeto sem PII proibida;
- uma reprodução de áudio sem vídeo produzir eventos agregados úteis para distinguir sinalização/ingressão de decodificação;
- desligar a telemetria interromper novas capturas e remover somente a fila local do BIG DUCKS;
- todos os testes e verificações de build passarem.
