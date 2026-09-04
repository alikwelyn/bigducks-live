# BIG DUCKS Discord Stream Activity

Activity independente do núcleo Go do BIG DUCKS LIVE. A Activity permite assistir transmissões dentro do Discord; a captura de tela/janela acontece em uma página externa compatível com `getDisplayMedia`.

## Desenvolvimento

```sh
npm ci
npm test
npm run build
npm start
```

Configuração de produção: copie `.env.example` para `.env`, defina `DISCORD_CLIENT_ID`, `PUBLIC_ORIGIN` e um `SESSION_SECRET` aleatório com pelo menos 32 bytes.
