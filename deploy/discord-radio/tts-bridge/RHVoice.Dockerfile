FROM ubuntu:24.04

ARG UBUNTU_MIRROR=http://mirror.yandex.ru/ubuntu

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TTS_BACKEND=rhvoice \
    TTS_RHVOICE_VOICE=mikhail \
    TTS_RHVOICE_ALLOWED_VOICES=mikhail,arina,pavel,yuriy,evgeniy-rus,victoria

RUN sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 rhvoice rhvoice-russian \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10002 --home-dir /nonexistent --shell /usr/sbin/nologin tts

WORKDIR /app
COPY --chown=tts:tts tts_bridge.py /app/tts_bridge.py

USER tts
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8092/health', timeout=2).read()"]

ENTRYPOINT ["python3", "/app/tts_bridge.py"]
