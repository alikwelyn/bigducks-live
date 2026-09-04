# BIG DUCKS LIVE — reparo da sessão e encerramento completo

## Objetivo

Permitir que usuários recuperem uma sessão do Discord sem abrir o Gerenciador de Tarefas e garantir que **Sair** encerre o HUD, o núcleo, o Discord e o processo do BIG DUCKS iniciado pela bandeja.

## Escopo aprovado

### Corrigir Discord

Adicionar à bandeja o item **Corrigir Discord**. A ação é manual e exige confirmação. Após confirmada, o núcleo:

1. Verifica se a proteção não está desativada.
2. Fecha a árvore completa do Discord, se existir.
3. Aguarda o encerramento dos processos por prazo limitado.
4. Reaplica ou repara a integração reversível do Discord.
5. Inicia o Discord pela rota protegida atualmente configurada.
6. Funciona como ação explícita mesmo quando `autoStartDiscord` é `false`, sem persistir essa opção.
7. Atualiza status e log com sucesso ou erro explicável.

Se a proteção estiver desativada, a ação não altera a configuração silenciosamente e orienta o usuário a ativá-la primeiro.

### Sair

Ao clicar em **Sair**, a bandeja deve:

1. Marcar o encerramento para impedir que o supervisor reinicie o núcleo.
2. Fechar o HUD existente de forma graciosa e, se necessário, usar uma finalização limitada do processo do HUD.
3. Parar o núcleo pelo canal de controle local.
4. Encerrar a árvore completa do Discord.
5. Aguardar os componentes por prazos limitados.
6. Remover o ícone e permitir que o processo da bandeja termine normalmente.

A operação deve ser idempotente e não deve iniciar novamente o núcleo durante o encerramento.

## Arquitetura

A bandeja não duplicará a lógica de PAC, relay, proxies ou injeção. Será adicionado um comando autenticado `RepairDiscord` ao controle local do núcleo. O `internal/app` será responsável por encerrar e iniciar a sessão protegida usando os recursos que já possui.

O `autoStartDiscord` continuará controlando apenas inicialização automática. A ação explícita **Corrigir Discord** usará um caminho `force` em memória, sem alterar o arquivo de configuração.

O pacote HUD receberá uma operação Windows testável para localizar, fechar e aguardar a janela existente. O encerramento forçado será restrito ao PID da janela do HUD, nunca a todos os processos `BigDucks.exe`.

## Segurança e falhas

- `allowDirectFallback` continua respeitado; reparo nunca abre Discord diretamente sem PAC/relay protegido.
- `disabled: true` impede o reparo e exige ativação explícita.
- O botão fica desabilitado durante o reparo e o encerramento.
- Falhas de fechamento, bridge, injeção ou inicialização aparecem no log e no HUD.
- Todos os waits têm timeout; nenhum fluxo fica bloqueado indefinidamente.

## Testes

- Testes do controle local para o novo comando de reparo.
- Testes do núcleo comprovando reparo explícito com `autoStartDiscord: false` e bloqueio quando a proteção está desativada.
- Testes Windows do helper de fechamento do HUD.
- Testes da bandeja para o novo item, confirmação/estado ocupado e encerramento.
- `go test ./...`, `go vet ./...` e build Windows x64.
- Release somente após validar os três artefatos, manifesto, tamanho, SHA-256 e assinatura Ed25519.
