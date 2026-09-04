# Deploy VPS

1. Instale Docker e Caddy.
2. Copie `.env.example` para `.env` e gere `SESSION_SECRET` com `openssl rand -hex 32`.
3. Defina `PUBLIC_ORIGIN` com o domínio HTTPS da Activity.
4. Crie o app no Discord Developer Portal e configure o URL Mapping para `/`.
5. Suba: `docker build -t bigducks-activity ./activity && docker run --env-file activity/.env --restart unless-stopped -p 127.0.0.1:3001:3001 bigducks-activity`.
6. Rode Caddy com `PUBLIC_ORIGIN=activity.seudominio.com caddy run --config activity/infra/Caddyfile`.

O modo de sessão de desenvolvimento deve permanecer desligado em produção. Antes de uso público, configure a verificação de contexto do Embedded App SDK no endpoint `/api/session`.
