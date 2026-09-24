# The audio-url resolver runs as a separate HexWave Radio service.
#
# No ffmpeg and no native anything: this service resolves an address and never
# decodes, downloads or transcodes a byte.
FROM python:3.13-slim

WORKDIR /srv

# Pins first, source second, so editing `resolve.py` reinstalls nothing.
COPY ytaudio/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Keep the resolver's runtime modules together in this image.
COPY ytaudio/resolve.py ytaudio/app.py ./

RUN useradd --system --uid 10002 ytaudio
USER ytaudio

ENV YTAUDIO_PORT=9322
EXPOSE 9322
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${YTAUDIO_PORT}"]
