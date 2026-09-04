# Discord Stream Activity — Design

**Data:** 2026-09-04  
**Status:** aprovado em conversa; aguardando revisão do documento antes da implementação

## Objetivo

Criar, no mesmo repositório do BIG DUCKS LIVE, um app Discord Activity independente para transmitir tela inteira ou janela específica com áudio, baixa latência e fallback confiável.

A Activity será focada em assistir dentro do Discord. A captura será feita por uma página externa, pois o iframe da Activity não pode depender de `getDisplayMedia`. O serviço de relay rodará em uma VPS e não armazenará gravações.

## Escopo do MVP

- Activity Discord para espectadores.
- Captura de tela inteira ou janela específica.
- Captura opcional de áudio do sistema.
- Perfis selecionáveis: 720p/60, 1080p/30 e 1080p/60.
- Modo adaptativo para bitrate, FPS e resolução.
- Acesso privado por padrão, limitado à mesma call.
- Opção do dono de liberar acesso por link temporário.
- Transporte WebSocket inicial com tentativa de WebRTC direto.
- Fallback automático para WebSocket quando WebRTC falhar.
- Sem gravação ou armazenamento de mídia na VPS.
- Controles simples de volume, tela cheia e qualidade para espectadores.

Fora do MVP: aplicativo nativo de captura, gravação, edição, streaming para plataformas externas, chat próprio e suporte de captura em celular.

## Arquitetura

O monorepo terá componentes isolados:

```text
apps/
  activity/        # Activity Discord: sala, espectadores e player
  capture/         # Página externa: captura de tela/janela + áudio
  relay/           # Servidor VPS: autenticação, salas e encaminhamento
packages/
  media/           # WebCodecs, áudio, keyframes e adaptação
  protocol/        # Mensagens binárias/JSON compartilhadas
  discord/         # Integração Embedded App SDK
```

Fluxo principal:

1. O usuário abre a Activity na call.
2. O relay valida o contexto do Discord e cria a sessão.
3. O transmissor abre a página externa de captura.
4. A página captura tela/janela e áudio com `getDisplayMedia`.
5. O vídeo é codificado com WebCodecs.
6. O relay entrega os dados inicialmente por WebSocket.
7. Para cada espectador, o sistema tenta estabelecer WebRTC direto.
8. O relay só troca para WebRTC após o primeiro frame válido chegar.
9. Se a tentativa falhar ou ficar sem frames, o espectador permanece no WebSocket.
10. O bitrate, FPS e resolução se adaptam à capacidade observada.

A VPS funcionará como relay em tempo real. Não haverá persistência de áudio, vídeo ou gravações.

## Pipeline de mídia

### Captura

A interface do transmissor permitirá escolher:

- tela inteira;
- janela específica;
- áudio ligado/desligado.

A página informará claramente quando o navegador não oferecer captura ou áudio. O stream capturado será reutilizado para evitar pedir a seleção duas vezes.

### Vídeo

- H.264 por hardware será tentado primeiro, com nível calculado conforme resolução e FPS.
- VP8 será fallback quando H.264 não estiver disponível.
- O encoder usará modo de baixa latência.
- Frames atrasados serão descartados em vez de acumulados.
- O conteúdo usará `contentHint` apropriado para tela.
- Keyframes serão enviados sob demanda quando um espectador entrar ou precisar recuperar a decodificação.
- O limite máximo será 1920×1080.

### Áudio

- O áudio do sistema será capturado como faixa separada quando suportado pelo navegador.
- O codec será Opus.
- O áudio não será processado como microfone: echo cancellation, noise suppression e auto gain ficam desligados.
- O player usará buffer pequeno para absorver variações sem criar atraso permanente.

### Transporte

O relay WebSocket será o caminho inicial e o fallback permanente. A tentativa WebRTC usará sinalização pelo mesmo canal autenticado e STUN/TURN configurável na VPS. O relay somente deixará de encaminhar o fluxo individual depois que o espectador confirmar o primeiro frame recebido pelo WebRTC.

Isso evita tela preta causada por uma conexão que informa estado conectado, mas não entrega mídia.

### Adaptação

O modo adaptativo observará perda, fila, latência, FPS real e capacidade do encoder. Ele reduzirá primeiro bitrate, depois FPS e resolução conforme necessário; ao recuperar margem, aumentará gradualmente a qualidade. O usuário poderá sempre selecionar manualmente um dos três perfis fixos.

## Salas e acesso

- Cada instância da Activity corresponde à call onde foi aberta.
- O relay emitirá tokens temporários assinados.
- Tokens expirarão e não serão reutilizáveis indefinidamente.
- O modo padrão permitirá assistir somente a membros da mesma call.
- O dono poderá emitir um link temporário para convidados externos.
- Salas serão isoladas: mídia, espectadores e comandos de uma sala nunca serão encaminhados para outra.
- O relay limitará espectadores, bitrate, tamanho de mensagens e número de conexões.
- Quando uma sala ficar vazia, seus recursos serão liberados.

A validação por call usará a integração oficial disponível do Discord e não confiará em um ID fornecido livremente pelo navegador.

## Interface

### Transmissor

Uma interface compacta exibirá:

- fonte escolhida;
- áudio ligado/desligado;
- perfil de qualidade;
- modo adaptativo;
- estado da captura;
- FPS, bitrate e espectadores;
- ação para parar a transmissão;
- ação para gerar/liberar link temporário.

### Espectador

A Activity exibirá:

- lista de transmissões disponíveis na sala;
- ação explícita para assistir;
- player com volume, tela cheia e seleção de qualidade;
- estado de conexão compreensível;
- fallback silencioso para WebSocket quando WebRTC não for possível.

Detalhes técnicos ficarão ocultos por padrão, mas poderão aparecer em um painel de diagnóstico para desenvolvimento.

## Segurança e privacidade

- A mídia será encaminhada em tempo real e não gravada.
- O relay não terá acesso a conteúdo persistido de áudio ou vídeo.
- Logs conterão apenas eventos técnicos agregados.
- Não serão coletados tokens Discord, conteúdo de mensagens, IDs desnecessários ou identificadores de mídia.
- Links públicos serão temporários e revogáveis.
- A telemetria será opcional e separada do caminho de mídia.
- A autenticação do relay será obrigatória para publicar, assistir e sinalizar WebRTC.

## Testes e aceitação

### Testes automatizados

- codificação e seleção de codec;
- cálculo de nível H.264;
- descarte de frames atrasados;
- keyframe sob demanda;
- buffer e pacotes de áudio;
- protocolo binário e mensagens de controle;
- autenticação, expiração e revogação de tokens;
- isolamento entre salas;
- limites de espectadores e backpressure;
- fallback WebRTC para WebSocket;
- adaptação de qualidade;
- smoke test ponta a ponta do relay.

### Testes manuais

- abrir a Activity em uma call real;
- transmitir tela inteira com e sem áudio;
- transmitir uma janela específica com e sem áudio;
- assistir por dois ou mais clientes;
- testar 720p/60, 1080p/30, 1080p/60 e adaptativo;
- desligar WebRTC/TURN para confirmar fallback;
- testar rede instável e reconexão;
- validar acesso privado e link temporário;
- confirmar que a VPS não cria arquivos de mídia.

A implementação será aceita quando o transmissor conseguir publicar tela/janela com áudio, espectadores conseguirem assistir dentro do Discord com baixa latência, o fallback funcionar sem tela preta e os testes automatizados e smoke tests passarem.

## Decisões e trade-offs

A abordagem escolhida é **relay WebSocket com tentativa de WebRTC opcional**. Apenas WebSocket seria mais simples, mas acumularia atraso e consumiria mais banda. WebRTC obrigatório teria menor latência em condições ideais, mas falharia para usuários atrás de NAT/firewall sem um fallback robusto. A abordagem escolhida mantém funcionamento básico e melhora a latência quando a conexão direta for possível.
