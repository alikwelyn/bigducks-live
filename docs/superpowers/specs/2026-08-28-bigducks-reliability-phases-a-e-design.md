# BIG DUCKS LIVE — Confiabilidade das fases A–E

## Objetivo

Tornar o BIG DUCKS LIVE confiável durante o ciclo de vida do Discord, reduzir falhas causadas por proxies públicos, separar diagnóstico de gateway e mídia, permitir recuperação conservadora e tornar a injeção resistente a atualizações do Discord.

A implementação será feita no worktree público `D:\discord\.worktrees\bigducks-live`, branch `public-main`. A Activity de compartilhamento de tela fica fora deste escopo.

## Escopo

### Incluído

- monitoramento real do processo principal do Discord;
- política configurável de inicialização, com `autoStartDiscord: false` por padrão;
- estado explícito para Discord fechado, inicialização, proteção, ausência de proxy e falha;
- respeito efetivo a `disabled`;
- modo seguro sem fallback direto silencioso;
- validação de proxy com sinais específicos do Discord, além do teste SOCKS/TLS existente;
- diagnóstico estruturado da sessão de mídia e vídeo quando os sinais estiverem disponíveis;
- recuperação conservadora por padrão e recuperação agressiva opcional;
- proteção contra corrida durante atualização do Discord e reparo de `app.asar` com backoff e limite;
- testes unitários, de integração e verificação final com `go test ./...` e `go vet ./...`.

### Fora do escopo

- implementação da Activity de compartilhamento de tela;
- substituição do Go Live nativo por WebRTC próprio;
- implementação de um SFU;
- restart automático completo do Discord como primeira estratégia de recuperação;
- integração direta com APIs privadas não documentadas do Discord que não estejam disponíveis de forma estável no cliente injetado.

## Decisões de produto

A configuração persistida terá estas opções:

```json
{
  "autoStartDiscord": false,
  "allowDirectFallback": false,
  "aggressiveRecovery": false
}
```

- `autoStartDiscord: false`: o BIG DUCKS aguarda o usuário abrir o Discord; não inicia o processo por conta própria.
- `allowDirectFallback: false`: quando não existir proxy verificado, o gateway não poderá conectar diretamente.
- `aggressiveRecovery: false`: durante uma live, a recuperação não recarrega nem reinicia o cliente automaticamente.

As opções serão normalizadas com defaults seguros e não poderão transformar ausência de proxy em conexão direta por acidente.

## Arquitetura

### 1. Ciclo de vida do Discord

`internal/discord` fornecerá abstrações testáveis para:

- localizar o executável mais recente;
- identificar o processo principal, não apenas qualquer `Discord.exe` filho;
- acompanhar PID e identidade/horário de criação quando disponível;
- detectar processo fechado, processo novo e processo ainda em inicialização;
- aguardar prontidão dos recursos necessários antes de injetar ou marcar a integração como ativa.

`internal/app` coordenará essas informações em uma máquina de estados. O estado `protected` somente poderá ser publicado quando houver Discord ativo, bridge/injeção compatível e proxy verificado, conforme o modo de roteamento.

O encerramento do Discord levará o runtime a um estado ocioso/fechado, fechará os túneis associados e impedirá novas tentativas de proteção até detectar um novo processo. Leituras transitórias ou falhas isoladas de enumeração não serão suficientes para declarar encerramento.

### 2. Proxy e roteamento

O pool gerenciado continuará sendo a autoridade para seleção de endpoints. Um endpoint só será promovido após passar pelas sondagens configuradas. A validação deverá combinar:

1. conexão SOCKS5;
2. endpoint de latência/região do Discord, quando disponível;
3. handshake TLS real com gateway Discord;
4. país/região observada e exclusões configuradas;
5. latência e tempo limite.

Falhas de uma fonte pública de candidatos não poderão causar fallback direto. O pool permanecerá vazio/indisponível e o relay retornará erro explícito enquanto novas tentativas com backoff forem realizadas.

A política de hosts e portas continuará restritiva: somente hosts Discord permitidos e porta `443`. No modo `gateway`, os domínios de mídia continuarão fora do relay protegido, para não encaminhar servidores `c-*.discord.media` pelo proxy do gateway.

### 3. Diagnóstico de RTC e vídeo

O diagnóstico será um componente separado do estado de gateway. Quando a bridge ou os logs do cliente fornecerem sinais, serão correlacionados por sessão e timestamp. Os estados mínimos serão:

```text
unknown
not_streaming
stream_starting
streaming
audio_only
video_stalled
receiver_timeout
rtc_disconnected
```

O diagnóstico deverá distinguir pelo menos:

- gateway sem conexão;
- gateway conectado e mídia desconectada;
- áudio presente com vídeo parado;
- stream criada sem receptor pronto;
- timeout de receptor;
- baixa taxa/ausência de frames;
- evento de bloqueio ou inelegibilidade, quando observável.

A ausência de um sinal não será interpretada automaticamente como sucesso. O status e o log deverão preservar a diferença entre “não observado” e “não ocorreu”.

### 4. Recuperação

A recuperação será coordenada por `internal/app`, mantendo a proteção contra concorrência já existente e adicionando política de tentativas.

Modo conservador, padrão:

- validar que o Discord ainda está ativo;
- garantir que há proxy verificado;
- promover reserva ou selecionar novo endpoint;
- fechar somente túneis protegidos afetados;
- solicitar redial pela bridge quando disponível;
- aguardar nova conexão dentro do orçamento;
- não recarregar nem reiniciar o Discord durante a live;
- aplicar cooldown e limite de tentativas;
- publicar falha explícita quando a recuperação não for possível.

Modo agressivo, opt-in:

- permite uma segunda etapa de redial/reconstrução de mídia;
- pode fechar conexões Electron selecionadas;
- permanece limitado por cooldown, orçamento e número máximo de tentativas;
- não fará restart completo do Discord nesta etapa sem uma decisão posterior específica.

Gateway e mídia não serão tratados como a mesma recuperação. Uma nova conexão de gateway não poderá marcar a transmissão como saudável se o diagnóstico indicar `video_stalled`, `receiver_timeout` ou `rtc_disconnected`.

### 5. Atualização e injeção

A preparação da integração verificará, antes de modificar ou carregar recursos:

- existência e estabilidade de `Discord.exe`;
- existência do diretório `resources`;
- existência e tipo esperado de `app.asar`;
- disponibilidade do backup original;
- versão selecionada e metadados da instalação.

Durante uma atualização em andamento, erros transitórios como `app.asar was not found` serão tratados com espera e backoff, não como motivo para loop rápido de reinicialização. Haverá limite de tentativas e mensagens distintas para “aguardando instalação”, “reparo necessário” e “integração ativa”.

`InjectionState: ours` somente será publicado após validação completa do artefato instalado e da bridge. Quando a versão do Discord mudar, a integração anterior será marcada como incompatível/reparo necessário até ser validada novamente.

## Fluxo principal

1. BIG DUCKS carrega configuração normalizada.
2. Se `disabled` estiver ativo, publica `disabled`, não inicia proteção e restaura o cliente quando necessário.
3. O monitor procura o processo principal do Discord.
4. Se não encontrar e `autoStartDiscord` for falso, publica `discord_closed` e aguarda.
5. Ao encontrar um processo novo, aguarda prontidão dos recursos.
6. O pool busca ou revalida proxies.
7. Sem proxy e com `allowDirectFallback` falso, publica `no_proxy` e não cria conexão direta.
8. Com proxy válido, inicia relay/PAC/bridge necessários.
9. Publica proteção somente após confirmar processo, integração e rota.
10. Durante a execução, monitora processo, pool, gateway e sinais de mídia.
11. Em falha, executa a política conservadora ou agressiva configurada.
12. Ao fechar o Discord, encerra a proteção, limpa túneis e volta a `discord_closed`.

## Estados públicos

Os estados existentes serão preservados quando compatíveis. A implementação poderá adicionar estados explícitos, sem reutilizar `protected` para representar Discord fechado ou proxy ausente:

```text
disabled
discord_closed
discord_starting
discord_running
starting_protection
no_proxy
protected
reconnecting
repair_required
failed
```

A HUD e a Control API deverão receber mensagens adequadas para os novos estados, mas a primeira implementação priorizará semântica correta e compatibilidade com consumidores existentes.

## Testes

Os testes serão escritos antes do código de cada comportamento novo.

### Processo e ciclo de vida

- processo inexistente resulta em `discord_closed`;
- processo filho isolado não conta como processo principal;
- novo PID é detectado como nova sessão;
- leituras transitórias não causam falso encerramento;
- fechamento posterior encerra proteção;
- `autoStartDiscord: false` não chama launch;
- `autoStartDiscord: true` permite launch;
- `disabled: true` impede criação de relay/bridge e proteção.

### Proxy e relay

- ausência de proxy retorna `ErrNoProxy`;
- relay não tenta conexão direta no modo seguro;
- endpoint que falha na sonda do Discord não é promovido;
- erro da fonte de candidatos mantém o modo seguro;
- host fora da allowlist e porta diferente de `443` continuam bloqueados;
- cooldown impede rotação repetitiva.

### Diagnóstico e recuperação

- gateway saudável não limpa diagnóstico de vídeo parado;
- áudio sem frames gera `audio_only` ou `video_stalled` conforme os sinais;
- timeout de receptor gera `receiver_timeout`;
- recuperação conservadora não recarrega o Discord;
- recuperação agressiva respeita limite e cooldown;
- recuperação concorrente continua serializada;
- Discord fechado cancela a recuperação.

### Atualização/injeção

- `app.asar` ausente durante janela transitória aguarda com backoff;
- artefato inválido gera `repair_required`;
- integração válida publica `ours`;
- mudança de versão invalida o estado anterior;
- limite de tentativas evita loop infinito.

### Verificação final

```powershell
go test ./...
go vet ./...
```

Também será executado um build de validação para Windows com a versão atualmente suportada, sem publicar release automaticamente.

## Critérios de aceite

- O BIG DUCKS não mostra `protected` quando o Discord está fechado.
- Com a configuração padrão, o BIG DUCKS não abre o Discord sozinho.
- O fechamento do Discord é detectado e leva o runtime a `discord_closed`.
- Com zero proxies válidos, não há fallback direto silencioso.
- A rotação de proxy possui cooldown e não reinicia indefinidamente a sessão.
- O status diferencia gateway protegido de saúde da mídia.
- A recuperação padrão não reinicia nem recarrega o Discord durante uma live.
- Uma instalação do Discord em atualização não provoca loop agressivo de reparo.
- Todos os testes existentes e novos passam, e `go vet ./...` passa.
- A Activity de compartilhamento de tela não é adicionada neste ciclo.
