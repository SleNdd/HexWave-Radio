# TTS bridge

Small serialized HTTP boundary for the Discord radio. The selected Compose TTS
image installs RHVoice with Russian voice profiles. It contains no IVONA
binaries, Wine prefix, or credentials. Check the separate licenses of any
voice data before distributing a built image.

## API

- `GET /health` returns the selected backend, serialization flag, backend readiness
  hints, uptime, and process RSS when the platform exposes it.
- `POST /synthesize` accepts `application/json` with `{"text":"Русский текст", "voice":"mikhail"}`
  and returns `audio/wav`.

When `TTS_TOKEN` is set, synthesis requires `Authorization: Bearer <token>`. Health
remains unauthenticated for container probes. Compare and configure the token through
runtime secrets; do not put it in `.env.example` or Git.

Text is bounded by `TTS_MAX_TEXT_CHARS` (600 by default and 2,000 hard maximum), must
contain Cyrillic, and cannot contain control characters. Voice is an identifier, not
a path. Synthesis is protected by one process-wide lock because legacy TTS engines and
small VPS installations are not assumed to be concurrency-safe.

## Backends

The bridge refuses to start until `TTS_BACKEND` is explicitly set. The selected
RHVoice image and example configuration set `TTS_BACKEND=rhvoice` and
`TTS_RHVOICE_VOICE=mikhail`. By default only that voice is permitted. The
operator can set `TTS_RHVOICE_ALLOWED_VOICES` to a comma-separated list of
installed station voices for the presenter collective. The caller may select
only those allowlisted profiles; an arbitrary or missing profile is rejected.

`RHVoice-test` reads the text via stdin and writes a private temporary WAV.
The backend checks that the binary and installed voice directory exist before
reporting ready. The engine is packaged under LGPL-2.1-or-later; the Mikhail
voice data is CC-BY-NC-ND-4.0. Review both before any image redistribution or
public use.

`TTS_BACKEND=piper` invokes the legacy Piper image's `/usr/local/bin/piper` directly with
`shell=False`, sends text through stdin, and writes to a private temporary WAV.
Mount the ONNX model and matching JSON config read-only under `/runtime/piper`, then
set the variables shown in `.env.example`. A possible Russian male fallback is
`ru_RU-dmitri-medium`; obtain its `.onnx` and `.onnx.json` from the
[Piper voices repository](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/dmitri/medium)
outside Git. The voice is not a drop-in imitation of IVONA Maxim; listen to a test
render before selecting it for the station.
The live `dmitri-medium` sample was audible but the operator rejected its natural
timbre for this robotic host; it is a diagnostic fallback only, not the selected
station voice. IVONA 2 Maxim remains a desired future upgrade, not a blocker
for the operator-approved RHVoice Mikhail voice.

The [Piper 1.8.0 package](https://pypi.org/project/piper-tts/1.8.0/) is
GPL-3.0-or-later. Distributing the TTS image requires compliance with that license,
including corresponding-source obligations. The dmitri voice repository is marked
MIT and its [model card](https://huggingface.co/rhasspy/piper-voices/blob/main/ru/ru_RU/dmitri/medium/MODEL_CARD)
identifies a CC0 training dataset. Check the license of each chosen model independently
before redistribution or public use. The image does not bundle any model.

`TTS_BACKEND=ivona` invokes the operator-provided JSON argv in
`TTS_IVONA_COMMAND_JSON`, also with `shell=False`. Only `{text_file}`, `{output_file}`,
and `{voice}` placeholders are accepted. The command/wrapper must read the UTF-8 text
file and create the WAV output. Do not put text directly in the command line.

The operator supplied archived Maxim assets, but IVONA 2 Maxim synthesis under
Wine is **not yet working**: the isolated SAPI probe enumerates the voice and
then `Speak()` returns `0x8004503A`. Do not configure `TTS_BACKEND=ivona` for
unattended playout until a non-empty WAV, ten consecutive phrases and a restart
test pass. Keep private installer and probe records outside the public repository.
Keep the Wine prefix, voice files, installer and any private activation data
outside Git and public images. A future public release has a separate rights gate.

The bridge rejects header-only WAV files, including the 46-byte output left
by the failed SAPI probe. This turns a broken narrator into a skipped segment
instead of falsely reporting a successful voice render.

## Run and verify

```bash
docker build -f deploy/discord-radio/tts-bridge/RHVoice.Dockerfile \
  -t discord-radio-tts ./deploy/discord-radio/tts-bridge
docker run --rm -p 127.0.0.1:8092:8092 \
  discord-radio-tts

python -m unittest discover -s deploy/discord-radio/tts-bridge -p 'test_*.py'
python scripts/tts-probe.py --url http://127.0.0.1:8092
```

For Compose, start the optional `tts` profile and set
`TTS_BASE_URL=http://tts:8092` in the radio's ignored
`deploy/discord-radio/.env`. The image selects RHVoice Mikhail without a
separate model volume. Configure `tts-bridge/.env` only for private overrides
or an optional shared `TTS_TOKEN`; set the same token in the radio env.

Bind any published port to localhost or keep the service on a private container
network. Do not expose the bridge to the internet.
