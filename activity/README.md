# BIG DUCKS Discord Stream Activity

Activity independente do núcleo Go do BIG DUCKS LIVE. A captura de tela ou janela acontece em uma página externa compatível com `getDisplayMedia`; espectadores assistem dentro do Discord.

Para acompanhar a passagem entre cliente e partida do LoL, abra **Fonte, qualidade e áudio → Tela inteira** e selecione o monitor do jogo no seletor do navegador. Isso compartilha todo aquele monitor, incluindo outras janelas; se autorizado, o som pode incluir outros aplicativos. O navegador não permite selecionar automaticamente outra janela de aplicativo como o capturador nativo do Discord.

Ao compartilhar somente uma janela, seu encerramento mantém a live aberta com uma tela de espera. Use **Selecionar janela da partida** para continuar na mesma live, sem reconectar os espectadores. **Trocar janela ou tela** também preserva a sessão e o áudio negociado; cancelar o seletor mantém a fonte anterior. **Parar transmissão** encerra a live de fato.

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

Sem espectadores SFU, o publicador reduz o vídeo para até 320×180, 1 FPS e 40 kbps, e o áudio para 6 kbps. Ao abrir a live, a qualidade escolhida volta automaticamente. São limites de mídia, não uma garantia de tráfego total: protocolos, miniaturas e relay de compatibilidade consomem banda adicional. As trilhas permanecem ativas porque o SFU expira mídia inativa após 30 segundos. O modo automático não aumenta a qualidade durante a economia. A prévia local mantém a captura original.

O áudio da fonte vem marcado por padrão; a autorização no seletor do navegador continua necessária. A prévia local permanece silenciada para evitar eco. Publique frontend, origin e Worker juntos e recarregue as Activities e páginas de captura para atualizar o protocolo de presença SFU. Valide em duas sessões reais: sem espectador, assistindo, voltando à lista e fechando a Activity. O fallback WebCodecs mantém seu comportamento anterior e não recebe esses limites SFU.

O player ocupa a área disponível da Activity em desktop, retrato e paisagem, preservando a proporção original. “Ampliar legendas” alterna 100%, 125% e 150%, mantendo a parte inferior da imagem como referência; a ampliação pode cortar as laterais. Legendas embutidas continuam sendo pixels do vídeo. “Tela cheia” usa o suporte do navegador; se o Discord bloquear a API no iframe, o player orienta usar o controle de tela cheia do próprio Discord. A identificação fica acima da imagem e os controles abaixo, em áreas separadas do vídeo.

A captura e o player mostram a lista de pessoas que abriram a live, com nome e avatar autenticados; os cards mostram a quantidade. A lista acompanha SFU, relay e P2P, mudanças de live, saída e desconexão, e não inclui pessoas que apenas estão na sala. Indica intenção de assistir, não confirmação de reprodução de cada frame. A mesma identidade é exibida uma vez, mesmo com mais de uma conexão.

Assistir à própria live mantém o retorno de áudio silenciado. Transmitir simultaneamente não silencia a live de outra pessoa. Respostas atrasadas de uma assinatura SFU substituída não podem limpar o player atual, e mudanças na quantidade de espectadores preservam a adaptação de qualidade enquanto houver público.

Mute, volume, ampliação e tela cheia permanecem visíveis, sem depender de hover, toque ou temporizador. Em telas estreitas os controles quebram linha em uma faixa própria abaixo do vídeo, sem cobrir as legendas. O vídeo usa somente a altura restante da Activity, com enquadramento integral em 100%.

A lista mostra carregamento até o servidor enviar `room-ready` após a lista inicial. Só então uma lista sem streams vira o estado vazio. Falhas de autenticação, desconexão ou espera acima de 20 segundos apresentam erro e “Tentar novamente”, que recarrega a sessão. Uma nova live aparece automaticamente, com destaque temporário no card e aviso de quem começou. Quem já assiste recebe um aviso com “Ver lives”, sem trocar sua transmissão automaticamente. Miniaturas e contagem de espectadores atualizam os cards sem reconstruí-los ou perder o foco do teclado.

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
