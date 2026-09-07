# BIG DUCKS Discord Stream Activity

Activity independente do núcleo Go do BIG DUCKS LIVE. A captura de tela ou janela acontece em uma página externa compatível com `getDisplayMedia`; espectadores assistem dentro do Discord.

## Transporte de mídia

Novas transmissões preferem trilhas WebRTC nativas publicadas uma vez no **Cloudflare Realtime SFU**. O Durable Object mantém presença, slots, cards, miniaturas e sinalização. Se o SFU não estiver configurado ou um espectador não conseguir conectá-lo, a Activity ativa automaticamente o relay WebCodecs compatível apenas para aquele fluxo.

A configuração SFU preserva o segredo no backend:

```env
CLOUDFLARE_SFU_APP_ID=
CLOUDFLARE_SFU_APP_SECRET=
```

Crie o aplicativo em **Cloudflare Dashboard → Realtime → SFU**. Nunca coloque o App Secret no frontend, no repositório ou em `wrangler.jsonc`.

TURN continua opcional como fallback ICE:

```env
CLOUDFLARE_TURN_KEY_ID=
CLOUDFLARE_TURN_KEY_SECRET=
```

TURN e SFU compartilham a franquia Realtime da conta. O padrão `720p/30 FPS` limita a utilização; `1080p/60 FPS` utiliza significativamente mais tráfego.

## Acesso e proteção dos endpoints

- `/` fora do iframe mostra somente instruções para abrir a Activity; `frame_id` é um indicador de UI, **não autenticação**.
- `/share` valida uma sessão de publicador antes de habilitar captura ou substituir outra aba. Links ausentes, usados ou expirados mostram uma orientação, não inicializam o SDK.
- A Activity autenticada cria um código aleatório de uso único em `/api/share-link`, válido por até 2 minutos. `/api/share-redeem` troca o código por uma sessão. A URL é limpa imediatamente; o token fica em memória/sessionStorage da aba para permitir recarga. Links legados com `t` continuam aceitos após validação até expirarem.
- Convites pendentes são limitados e mantidos em memória no origin. Um restart invalida convites ainda não resgatados; gere outro pela Activity. Essa implementação pressupõe uma réplica do origin (como as sessões SFU atuais).
- `/api/capture-session`, SFU, ICE e WebSocket validam tokens de sala, identidade e papel. ICE novo usa Authorization; query legada permanece compatível. WebSocket ainda precisa de token na URL: redija query strings nos logs do proxy e nunca compartilhe esse endereço.
- JSON: até 16 KiB nas APIs comuns e 1,2 MB no SFU. Limite HTTP de 600 requisições/minuto por endereço de conexão, sem confiar em headers de IP enviados pelo cliente; atrás do Traefik funciona como proteção agregada, não como limite individual. Não limita pacotes de mídia.
- Origem de navegador validada nas operações mutáveis; OAuth externo vincula estado a cookie HttpOnly e restringe redirects locais. Requisições sem Origin ainda exigem autenticação quando aplicável.
- Respostas usam no-referrer, no-store, nosniff e noindex. Isso reduz vazamentos e indexação; **não bloqueia bots maliciosos nem substitui autenticação**. `/healthz`, `/api/config` e assets continuam públicos e sem segredos, necessários à operação.
- Não foi ativada restrição de guild/canal: uma identidade Discord autenticada não prova participação em um servidor. Restrição real exige guild permitida e verificação backend de participação/presença. Também não há limite financeiro ou garantia contra DDoS.
- Qualidade, SFU, fallback e franquias não foram alterados por este endurecimento. Segredos previamente expostos devem ser rotacionados nos serviços.

## Desenvolvimento

```sh
npm ci
npm test
npm run build
npm start
```

Configuração de produção: copie `.env.example` para `.env`, defina `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_ORIGIN` e um `SESSION_SECRET` aleatório com pelo menos 32 bytes. O modo de sessão de desenvolvimento deve permanecer desabilitado em produção.
