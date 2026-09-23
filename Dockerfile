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

# O crate de captura (xcap) compila no Linux mesmo se a gente nao capture nada,
# e ele depende de pkg-config + headers de X11, Wayland, PipeWire, DRM/GBM e EGL.
# Sem TODAS estas, o build morre em `wayland-sys`, `pipewire-sys`, `drm-sys`...
# O `clang`/`libclang-dev` e' pro bindgen (usado por alguns desses crates).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pkg-config clang libclang-dev \
      libxcb1-dev libxrandr-dev libdbus-1-dev \
      libwayland-dev libxkbcommon-dev \
      libpipewire-0.3-dev libspa-0.2-dev \
      libdrm-dev libgbm-dev libegl1-mesa-dev libgl1-mesa-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY rs/bigducks-rs/Cargo.toml rs/bigducks-rs/Cargo.lock ./
COPY rs/bigducks-rs/src ./src
COPY rs/bigducks-rs/web ./web
RUN cargo build --release

# --------------------------------------------------------------- runtime -----
FROM debian:bookworm-slim

# As mesmas libs, agora em versao de runtime: o binario linka nelas, entao o
# loader precisa encontra-las mesmo no modo relay.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libxcb1 libxrandr2 libdbus-1-3 \
      libwayland-client0 libxkbcommon0 \
      libpipewire-0.3-0 libdrm2 libgbm1 libegl1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -s /usr/sbin/nologin bigducks

COPY --from=build /src/target/release/Desjanjador /Desjanjador

USER bigducks
EXPOSE 8791

# --relay: escuta em 0.0.0.0, exige ?secret= nas conexoes e nao instala nada no
# Discord (esse container nao tem Discord).
ENTRYPOINT ["/Desjanjador"]
CMD ["--relay", "--port", "8791"]
