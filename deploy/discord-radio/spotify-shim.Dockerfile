FROM golang:1-trixie AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
ARG GO_LIBRESPOT_VERSION=v0.7.4
RUN git clone --depth 1 --branch "${GO_LIBRESPOT_VERSION}" https://github.com/devgianlu/go-librespot /src
COPY stream/spotify-shim/*.go /src/cmd/hexwave-shim/
RUN cd /src && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/hexwave-shim ./cmd/hexwave-shim

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system shim \
 && useradd --system --gid shim --home-dir /nonexistent shim \
 && mkdir -p /streamstate \
 && chown shim:shim /streamstate
COPY --from=build /out/hexwave-shim /usr/local/bin/hexwave-shim
USER shim
EXPOSE 3679
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:3679/health"]
ENTRYPOINT ["/usr/local/bin/hexwave-shim"]
