# Relay de sinalizacao do bigducks-rs.
#
# No modo `--relay` o binario NAO captura tela: so serve o `/hub` (offer/answer/
# ice, alguns KB por sessao). O video nunca passa por aqui.
#
# Este Dockerfile fica na RAIZ do repo de proposito: o Dokploy usa a raiz como
# contexto de build. Por isso os COPY usam o caminho completo (rs/bigducks-rs/...).
#
# Build local:  docker build -t bigducks-relay .
# Teste local:  docker run --rm -p 8791:8791 bigducks-relay

# ---------------------------------------------------------------- build -----
FROM rust:1-bookworm AS build

# xcap (captura) tem deps de sistema no Linux que precisam existir ate' pra
# compilar o crate, mesmo que o modo relay nao capture nada.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pkg-config libxcb1-dev libxrandr-dev libdbus-1-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY rs/bigducks-rs/Cargo.toml rs/bigducks-rs/Cargo.lock ./
COPY rs/bigducks-rs/src ./src
COPY rs/bigducks-rs/web ./web
RUN cargo build --release

# --------------------------------------------------------------- runtime -----
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libxcb1 libxrandr2 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -s /usr/sbin/nologin bigducks

COPY --from=build /src/target/release/bigducks-rs /bigducks-rs

USER bigducks
EXPOSE 8791

# --relay: escuta em 0.0.0.0, exige ?secret= nas conexoes e nao instala nada no
# Discord (esse container nao tem Discord).
ENTRYPOINT ["/bigducks-rs"]
CMD ["--relay", "--port", "8791"]
