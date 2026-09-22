# Go Live sender (teste)

Ferramenta de **teste** para responder uma pergunta só:

> O bloqueio do Go Live no Brasil é do **cliente** (a flag de experimento que
> esconde o botão) ou do **servidor** (que se recusa a entregar a mídia)?

## O que é

Um "sender" que entra num canal de voz e publica um **Go Live de verdade**
(mesmo fluxo do cliente desktop: `STREAM_CREATE` op 18 → servidor de stream →
WebRTC + RTP/RTX → **DAVE/E2EE**). Clientes nativos do Discord no canal
**assistem normalmente**, sem script e sem viewer customizado.

A diferença crucial: ele **não lê o experimento Apex** (`videoEnabled`). Ele
calcula a `stream_key` sozinho e manda o `STREAM_CREATE`. Se o bloqueio for só a
flag do cliente, isto funciona **do Brasil, sem proxy nenhum**.

## Repositórios

| Repo | Versão | DAVE/E2EE | Serve? |
|---|---|---|---|
| [Discord-RE/Discord-video-stream](https://github.com/Discord-RE/Discord-video-stream) | 7.x | ✅ `@snazzah/davey` | **Sim** |
| [misyltoad/Discord-video-stream](https://github.com/misyltoad/Discord-video-stream) | 3.0.2 | ❌ | Não (morre no erro 4017) |
| [gabrielmaialva33/discord-video-stream](https://github.com/gabrielmaialva33/discord-video-stream) | 3.4.0 | ❌ | Não (morre no erro 4017) |

Só o Discord-RE tem a camada E2EE obrigatória hoje.

## Token e canal: automático

Você **não precisa** do DevTools. O BigDucks injeta um capturador no renderer do
Discord (o método antigo do `webpackChunkdiscord_app.getToken` foi removido
nesse build) e escreve:

```
%LOCALAPPDATA%\DiscordStream\golive-sender.json
```

com `token`, `guildId` e `channelId`. O `sender.mjs` lê esse arquivo sozinho.

### Como capturar

1. Feche todos os Discord e rode `D:\discord\dist\BigDucks.exe`.
2. Faça login na conta que vai **transmitir**.
3. No Discord, **clique no canal de voz** que você quer usar (só selecionar; não
   precisa entrar) — é assim que o `channelId`/`guildId` são capturados.
   - Se ainda faltar `channelId`, preencha à mão no `config.json` (Modo
     Desenvolvedor → botão direito no canal → Copiar ID). O token é o difícil e
     esse vem automático.
4. Espere ~10s e confira no log do BigDucks:
   `Go Live sender config captured at ...`
   - Se não aparecer, dê **Ctrl+R** no Discord (recarrega o renderer; o hook do
     gateway pega o `IDENTIFY` na reconexão) e espere mais 10s.

## Como transmitir

1. Dê **dois cliques** em `start.cmd`.
   - Na primeira vez ele instala as dependências (`npm install`, demora).
2. Ele lê o token/canal capturados, entra no canal de voz e começa o Go Live.
3. Entre no mesmo canal com o **cliente nativo** numa **outra conta** e veja se
   o Go Live aparece.

> Importante: se a conta capturada (desktop) **entrar** no canal antes, o sender
> entra como a mesma conta de novo. Saia do canal no desktop antes de rodar o
> sender, ou use outra conta para assistir.

## Como ler o resultado

| Resultado | Conclusão |
|---|---|
| Cliente nativo assiste, **sem proxy** | bloqueio é **do cliente** → dá pra fazer 100% nativo com a sessão liberada, e eu integro isso no BigDucks (1 clique, sem console) |
| `4017` / `2012` também aqui | bloqueio é **do servidor** → saída não-BR (proxy) é obrigatória |

## Aviso

- É um **self-bot**: automatizar conta de usuário viola os ToS e pode dar ban.
  Use numa conta de teste, não na principal.
- O token fica em `%LOCALAPPDATA%\DiscordStream\golive-sender.json` (permissão
  do usuário) e **nunca** deve ser commitado — `tools/golive-sender/config.json`
  já está no `.gitignore`.
- Isto é uma **ferramenta de diagnóstico**, não o produto.
