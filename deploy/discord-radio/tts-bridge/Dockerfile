FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN python -m pip install --no-cache-dir 'piper-tts==1.8.0'

RUN groupadd --system tts && useradd --system --gid tts --home-dir /nonexistent tts

WORKDIR /app
COPY --chown=tts:tts tts_bridge.py /app/tts_bridge.py

USER tts
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8092/health', timeout=2).read()"]

ENTRYPOINT ["python", "/app/tts_bridge.py"]
