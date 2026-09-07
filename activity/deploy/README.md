# Deploy da Discord Activity

A produção atual usa Dokploy/Traefik para site, OAuth e proxy autenticado do Cloudflare Realtime; o Worker/Durable Object fornece presença e controle na borda.

## Variáveis do serviço Dokploy

```env
NODE_ENV=production
PORT=3001
PUBLIC_ORIGIN=https://stream.skillup.com.br
DISCORD_CLIENT_ID=<client-id público>
DISCORD_CLIENT_SECRET=<segredo>
SESSION_SECRET=<mínimo 32 bytes aleatórios>
CLOUDFLARE_SFU_APP_ID=<Realtime SFU App ID>
CLOUDFLARE_SFU_APP_SECRET=<Realtime SFU App Secret>
CLOUDFLARE_TURN_KEY_ID=<TURN key id opcional>
CLOUDFLARE_TURN_KEY_SECRET=<TURN key secret opcional>
MAX_VIEWERS=25
```

Segredos devem existir somente no ambiente do serviço. Não grave valores no Dockerfile, frontend, GitHub ou configuração pública do Worker.

## Publicação

1. Crie um Realtime SFU App no painel Cloudflare e copie App ID/Secret para o ambiente Dokploy.
2. Faça build/deploy do serviço usando `activity/Dockerfile`.
3. Publique o relay de controle:

```sh
cd activity
npm ci
npm run edge:deploy
```

4. Confirme:

```sh
curl https://stream.skillup.com.br/healthz
curl https://stream.skillup.com.br/edge/healthz
curl https://relay.skillup.com.br/healthz
```

## Comportamento de segurança

- `/api/sfu/*` exige o token temporário de sala.
- O backend assina os identificadores publicados em uma capacidade de mídia vinculada à sala.
- Um viewer não consegue puxar tracks de outra sala.
- Sem credenciais SFU, o sistema seleciona explicitamente o relay WebCodecs existente.
