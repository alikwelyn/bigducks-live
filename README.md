# BIG DUCKS LIVE

Aplicativo portátil para Windows que mantém as lives do Discord acessíveis por uma rota SOCKS5 limitada ao gateway, com recuperação automática, controle manual e um HUD simples de entender.

![Logo do BIG DUCKS](imgs/big-ducks.png)

## O que mudou em relação ao protótipo

- roteamento cobre `gateway.discord.gg` e gateways regionais como `gateway-us-east1-b.discord.gg`;
- o gateway nunca cai silenciosamente para o IP direto quando não há proxy verificado;
- uma reconexão troca o proxy, fecha somente os túneis antigos e pede ao Electron para abrir conexões novas;
- toda tentativa termina em sucesso ou erro explicável — o HUD não fica em “reconectando” para sempre;
- a bandeja supervisiona e reinicia automaticamente o núcleo se ele encerrar;
- `Reiniciar proteção` reinicia apenas o núcleo e mantém o Discord aberto;
- `Corrigir Discord` fecha e reabre a sessão pela rota protegida, sem usar o Gerenciador de Tarefas;
- `Sair` fecha o HUD, o núcleo e toda a árvore do Discord;
- logs e arquivos locais recebem permissões legíveis pelo usuário atual;
- atualizações vêm de Releases do GitHub e só são instaladas após assinatura Ed25519 e SHA-256 válidos;
- o diagnóstico RTC nativo do Go Live é somente leitura e ajuda a separar transporte, decoder e renderização;
- a telemetria Sentry é opcional, começa desativada e envia somente eventos agregados e sanitizados do núcleo/bridge.

## Instalação

Requisitos: Windows 10 ou 11 x64, Discord oficial e Microsoft Edge WebView2 Runtime.

1. Baixe `BigDucks-windows-amd64.exe` na página de Releases.
2. Renomeie para `BigDucks.exe` e coloque em uma pasta permanente.
3. Feche o Discord completamente, inclusive pelo ícone ao lado do relógio. Isso é necessário apenas na primeira instalação ou quando a integração for reparada.
4. Abra `BigDucks.exe`.

O pato aparece na bandeja e o HUD abre automaticamente. Em instalações novas, o BIG DUCKS abre em segundo plano nas próximas inicializações do Windows e aguarda o Discord por padrão. Para iniciar o Discord automaticamente, edite `%LOCALAPPDATA%\DiscordStream\config.json` e defina `"autoStartDiscord": true`. Configurações antigas, criadas antes dessa opção existir, preservam o comportamento anterior e continuam iniciando o Discord.

## Uso

No HUD:

- **Reconectar live** procura ou promove uma saída verificada e força uma nova conexão do gateway, sem fechar o Discord;
- **Testar rota** confirma tanto o host canônico quanto um gateway regional;
- **Recarregar Discord** recarrega a janela usando a integração Electron;
- **Abrir log** abre o arquivo técnico no Bloco de Notas sem exigir administrador;
- **Atualizar agora** baixa, valida e instala uma Release assinada;
- **Detalhes técnicos** mostram o diagnóstico nativo do RTC sem exibir SSRC ou identificadores.

No ícone do pato ao lado do relógio:

- **Abrir** abre uma janela independente;
- **Reiniciar** reinicia somente o processo do núcleo;
- **Corrigir Discord** pede confirmação, fecha a árvore atual e reabre o Discord pela rota protegida;
- **Sair** fecha o HUD, o núcleo, o Discord e encerra o BIG DUCKS.

## Como funciona

O aplicativo inicia um relay SOCKS local e entrega ao Discord um arquivo PAC. Apenas hosts do gateway em `discord.gg` usam um proxy público verificado; mídia, voz, vídeo e o restante do tráfego continuam diretos. A correspondência por sufixo exige uma fronteira de domínio e não aceita nomes parecidos, como `discord.gg.example.com`.

Uma pequena integração JavaScript reversível no Electron permite fechar conexões de rede, resolver o PAC e recarregar a janela. Se Vencord ou Equicord já estiver instalado, o loader reconhecido é encadeado e preservado. Nenhuma DLL é injetada e não é necessário executar como administrador.

Os arquivos continuam em `%LOCALAPPDATA%\DiscordStream` por compatibilidade segura com instalações anteriores. O diretório inclui configuração, pool de proxies, backups reversíveis, canal local autenticado e `discordstream.log`. A fila local de telemetria, quando existir, fica em `%LOCALAPPDATA%\DiscordStream\telemetry`.

## Privacidade e limitações

Proxies públicos são instáveis e não são controlados por este projeto. A conexão com o gateway continua protegida por TLS de ponta a ponta, mas o operador do proxy pode observar seu endereço IP, o domínio de destino, horários e volume de tráfego. Não use este projeto como VPN e não envie outros aplicativos pelo relay local.

O BIG DUCKS reduz a falha causada por gateways regionais e proxies mortos, mas não pode garantir disponibilidade do Discord, da lista pública ou de qualquer proxy. Se nenhum candidato passar nos testes, o gateway espera e continua procurando em vez de expor uma conexão direta como se estivesse protegida. O fallback direto permanece desativado por padrão.

O diagnóstico detalhado e o roteiro A/B estão em [docs/native-rtc-diagnostics.md](docs/native-rtc-diagnostics.md). A telemetria é habilitada explicitamente no HUD; desabilitá-la bloqueia novos eventos e remove apenas a fila local. IPs, tokens, URLs completas, caminhos, IDs Discord, SSRC, mensagens e logs não são enviados. Consulte [docs/telemetry.md](docs/telemetry.md) para o contrato completo e a remoção de eventos já enviados.

Este projeto não é afiliado, aprovado ou mantido pelo Discord. Alterações no cliente oficial podem exigir uma atualização do BIG DUCKS.

## Desinstalação

Feche o Discord completamente e execute:

```powershell
.\BigDucks.exe --uninstall
```

Isso restaura o loader anterior do Discord e sua entrada original de inicialização. Depois, apague o EXE. Os dados locais podem ser removidos manualmente após confirmar que a restauração terminou.

## Desenvolvimento

Use Go 1.26 ou posterior e Node.js para Windows x64:

```powershell
npm ci
npm run build:bridge
go test ./...
go vet ./...
.\build.ps1
```

A bridge commitada em `internal/bridge/assets/discord_bridge.js` é gerada determinísticamente de `internal/bridge/assets-src/discord_bridge.js` com as versões fixadas em `package-lock.json`. Não edite o bundle diretamente.

O artefato fica em `dist\BigDucks.exe`, com ícone e metadados do Windows. Tags `vX.Y.Z` executam o workflow de Release, assinam o manifesto e publicam os três arquivos consumidos pelo atualizador.

Veja [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) e [NOTICE.md](NOTICE.md) antes de contribuir ou redistribuir.

## Licença

Distribuído sob a GNU General Public License v3.0. Consulte [LICENSE](LICENSE).
