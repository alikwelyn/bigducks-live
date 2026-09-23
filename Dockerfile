# syntax=docker/dockerfile:1

# Relay de sinalizacao do bigducks-rs.
#
# No modo `--relay` o binario NAO captura tela: so serve o `/hub` (offer/answer/
# ice, alguns KB por sessao). O video nunca passa por aqui.
#
# Este Dockerfile fica na RAIZ do repo de proposito: o Dokploy usa a raiz como
# contexto de build. Por isso os COPY usam o caminho completo (rs/bigducks-rs/...).
#
# CACHE: o build do Rust demora ~2,5 min porque a arvore de dependencias inteira
# recompilava a cada deploy (mudar src/ ou web/ invalidava o RUN cargo build). A
# correcao tem DUAS partes e nenhuma muda o que e' buildado:
#   1) `# syntax=docker/dockerfile:1` + cache mounts para o registry E o target;
#   2) o truque classico: copiar Cargo.toml/Cargo.lock antes e fazer um build
#      "de mentira" (src/main.rs stub) numa camada propria - assim as ~200 crates
#      de dependencia ficam em cache mesmo quando o codigo real muda.
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

# (1) Manifestos primeiro. Enquanto Cargo.toml/Cargo.lock nao mudarem, TODAS as
# camadas abaixo ficam em cache - mesmo que src/ e web/ mudem a cada deploy.
COPY rs/bigducks-rs/Cargo.toml rs/bigducks-rs/Cargo.lock ./

# Build "de mentira": compila SO a arvore de dependencias (o bin do stub e'
# descartavel). O `target` e' um cache mount, entao as crates compiladas ficam no
# volume de cache entre builds - mesmo quando Cargo.toml muda e esta camada e'
# reconstruida, o cargo reaproveita o que ja' compilou.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    mkdir -p src \
 && printf 'fn main() {}\n' > src/main.rs \
 && cargo build --release

# (2) Codigo real (src + web, que entra via include_str! no main.rs). Mudar
# QUALQUER arquivo daqui invalida SO' esta camada: as dependencias vem do cache.
COPY rs/bigducks-rs/src ./src
COPY rs/bigducks-rs/web ./web
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release \
 && cp -f /src/target/release/Desjanjador /Desjanjador.build

# Cache mounts NAO entram na imagem: o `target` e' so' um volume de cache. Por
# isso o binario e' recolocado no caminho de sempre num layer NORMAL, para o
# `COPY --from=build /src/target/release/Desjanjador` do runtime seguir igual.
RUN mkdir -p /src/target/release \
 && cp -f /Desjanjador.build /src/target/release/Desjanjador

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

# Canal de atualizacao: o exe que vai pra pasta de release do repo vira
# /release.json + o proprio binario servidos pelo relay. Assim, publicar versao
# nova e' copiar o exe pra rs/bigducks-rs/release/ e dar push (o Dokploy
# rebuilda no On Push e todas as maquinas se atualizam sozinhas).
COPY rs/bigducks-rs/release /release

USER bigducks
EXPOSE 8791

# --relay: escuta em 0.0.0.0, exige ?secret= nas conexoes e nao instala nada no
# Discord (esse container nao tem Discord).
ENTRYPOINT ["/Desjanjador"]
CMD ["--relay", "--port", "8791", "--release-dir", "/release"]
