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

## Desenvolvimento

```sh
npm ci
npm test
npm run build
npm start
```

Configuração de produção: copie `.env.example` para `.env`, defina `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_ORIGIN` e um `SESSION_SECRET` aleatório com pelo menos 32 bytes. O modo de sessão de desenvolvimento deve permanecer desabilitado em produção.
