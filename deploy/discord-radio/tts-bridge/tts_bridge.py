#!/usr/bin/env python3
"""Small serialized HTTP bridge for RHVoice and optional TTS alternatives."""

from __future__ import annotations

import argparse
import hmac
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol, Sequence


SERVICE_VERSION = "0.1.0"
DEFAULT_MAX_TEXT_CHARS = 600
HARD_MAX_TEXT_CHARS = 2_000
DEFAULT_MAX_BODY_BYTES = 16_384
DEFAULT_MAX_WAV_BYTES = 32 * 1024 * 1024
VOICE_RE = re.compile(r"^[\w.-]{1,64}$", re.UNICODE)
CYRILLIC_RE = re.compile(r"[\u0400-\u052f]")


class RequestError(Exception):
    """An expected client or synthesis error safe to expose over HTTP."""

    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class Backend(Protocol):
    name: str

    def synthesize(self, text: str, voice: str) -> bytes: ...

    def health(self) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Limits:
    max_text_chars: int = DEFAULT_MAX_TEXT_CHARS
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES
    max_wav_bytes: int = DEFAULT_MAX_WAV_BYTES


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def validate_text(value: Any, max_chars: int) -> str:
    if not isinstance(value, str):
        raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_text", "text must be a string")
    text = value.strip()
    if not text:
        raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_text", "text must not be empty")
    if len(text) > max_chars:
        raise RequestError(
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            "text_too_long",
            f"text must not exceed {max_chars} characters",
        )
    if not CYRILLIC_RE.search(text):
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "russian_text_required",
            "text must contain Cyrillic characters",
        )
    if any(ord(char) < 32 and char not in "\n\t\r" for char in text):
        raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_text", "text contains control characters")
    return text


def validate_voice(value: Any) -> str:
    if value is None:
        return "default"
    if not isinstance(value, str) or not VOICE_RE.fullmatch(value):
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "invalid_voice",
            "voice must be a 1-64 character identifier",
        )
    return value


def validate_wav(data: bytes, max_bytes: int) -> bytes:
    if len(data) > max_bytes:
        raise RuntimeError(f"synthesized WAV exceeds {max_bytes} bytes")
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise RuntimeError("backend did not produce a RIFF/WAVE file")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav_file:
            if wav_file.getnframes() == 0 or not wav_file.readframes(1):
                raise RuntimeError("backend produced an empty WAV file")
    except (wave.Error, EOFError, OSError) as exc:
        raise RuntimeError("backend produced an invalid WAV file") from exc
    return data


class RHVoiceBackend:
    name = "rhvoice"

    def __init__(self) -> None:
        self.binary = os.getenv("TTS_RHVOICE_BINARY", "/usr/bin/RHVoice-test")
        self.voice = os.getenv("TTS_RHVOICE_VOICE", "mikhail")
        if not VOICE_RE.fullmatch(self.voice):
            raise RuntimeError("TTS_RHVOICE_VOICE must be a voice identifier")
        raw_allowed = os.getenv("TTS_RHVOICE_ALLOWED_VOICES", self.voice)
        allowed = [part.strip() for part in raw_allowed.split(",")]
        if not allowed or len(allowed) > 16 or any(not VOICE_RE.fullmatch(part) for part in allowed):
            raise RuntimeError("TTS_RHVOICE_ALLOWED_VOICES must list 1-16 voice identifiers")
        if self.voice not in allowed:
            raise RuntimeError("TTS_RHVOICE_ALLOWED_VOICES must include TTS_RHVOICE_VOICE")
        self.allowed_voices = frozenset(allowed)
        self.voice_dir = Path(os.getenv("TTS_RHVOICE_VOICES_DIR", "/usr/share/RHVoice/voices"))
        self.timeout_seconds = _env_int("TTS_TIMEOUT_SECONDS", 45, minimum=1, maximum=300)
        self.max_wav_bytes = _env_int(
            "TTS_MAX_WAV_BYTES", DEFAULT_MAX_WAV_BYTES, minimum=1024, maximum=256 * 1024 * 1024
        )

    def health(self) -> dict[str, Any]:
        binary_available = shutil.which(self.binary) is not None
        voice_available = all((self.voice_dir / voice).is_dir() for voice in self.allowed_voices)
        return {
            "ready": binary_available and voice_available,
            "configured": True,
            "binary_available": binary_available,
            "voice_available": voice_available,
            "voice": self.voice,
            "allowed_voices": sorted(self.allowed_voices),
        }

    def synthesize(self, text: str, voice: str) -> bytes:
        selected = self.voice if voice == "default" else voice
        if selected not in self.allowed_voices:
            raise RequestError(HTTPStatus.BAD_REQUEST, "unsupported_voice", "voice is not enabled for this station")
        if not (self.voice_dir / selected).is_dir():
            raise RuntimeError("enabled RHVoice profile is unavailable")
        with tempfile.TemporaryDirectory(prefix="tts-rhvoice-") as temp_dir:
            output_path = Path(temp_dir) / "speech.wav"
            argv = [self.binary, "--profile", selected, "--output", str(output_path)]
            _run(argv, input_text=text + "\n", timeout_seconds=self.timeout_seconds)
            return validate_wav(output_path.read_bytes(), self.max_wav_bytes)


class PiperBackend:
    name = "piper"

    def __init__(self) -> None:
        binary = os.getenv("TTS_PIPER_BINARY", "/usr/local/bin/piper")
        model = os.getenv("TTS_PIPER_MODEL")
        if not model:
            raise RuntimeError("TTS_PIPER_MODEL is required for the Piper backend")
        self.binary = binary
        self.model = model
        self.config = os.getenv("TTS_PIPER_CONFIG")
        self.speaker = os.getenv("TTS_PIPER_SPEAKER")
        self.timeout_seconds = _env_int("TTS_TIMEOUT_SECONDS", 45, minimum=1, maximum=300)
        self.max_wav_bytes = _env_int(
            "TTS_MAX_WAV_BYTES", DEFAULT_MAX_WAV_BYTES, minimum=1024, maximum=256 * 1024 * 1024
        )

    def health(self) -> dict[str, Any]:
        binary_available = shutil.which(self.binary) is not None
        model_available = Path(self.model).is_file()
        return {
            "ready": binary_available and model_available,
            "configured": bool(self.model),
            "binary_available": binary_available,
            "model_available": model_available,
        }

    def synthesize(self, text: str, voice: str) -> bytes:
        del voice  # Model/speaker selection is deployment-owned, not user-controlled.
        with tempfile.TemporaryDirectory(prefix="tts-piper-") as temp_dir:
            output_path = Path(temp_dir) / "speech.wav"
            argv = [self.binary, "--model", self.model, "--output_file", str(output_path)]
            if self.config:
                argv.extend(["--config", self.config])
            if self.speaker:
                argv.extend(["--speaker", self.speaker])
            _run(argv, input_text=text + "\n", timeout_seconds=self.timeout_seconds)
            return validate_wav(output_path.read_bytes(), self.max_wav_bytes)


class CommandBackend:
    """Runs a trusted operator command without a shell.

    The argv JSON can use {text_file}, {output_file}, and {voice}. The operator-owned
    command or wrapper must read UTF-8 text_file and write a WAV to output_file.
    """

    name = "ivona"

    def __init__(self) -> None:
        raw = os.getenv("TTS_IVONA_COMMAND_JSON")
        if not raw:
            raise RuntimeError("TTS_IVONA_COMMAND_JSON is required for the IVONA backend")
        try:
            command = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("TTS_IVONA_COMMAND_JSON must be valid JSON") from exc
        if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
            raise RuntimeError("TTS_IVONA_COMMAND_JSON must be a non-empty JSON string array")
        joined = "\n".join(command)
        if "{text_file}" not in joined or "{output_file}" not in joined:
            raise RuntimeError("IVONA command must use {text_file} and {output_file} placeholders")
        allowed = {"text_file", "output_file", "voice"}
        placeholders = set(re.findall(r"\{([^{}]+)\}", joined))
        unknown = placeholders - allowed
        if unknown:
            raise RuntimeError(f"unsupported IVONA command placeholders: {', '.join(sorted(unknown))}")
        self.command = tuple(command)
        self.timeout_seconds = _env_int("TTS_TIMEOUT_SECONDS", 45, minimum=1, maximum=300)
        self.max_wav_bytes = _env_int(
            "TTS_MAX_WAV_BYTES", DEFAULT_MAX_WAV_BYTES, minimum=1024, maximum=256 * 1024 * 1024
        )

    def health(self) -> dict[str, Any]:
        binary_available = shutil.which(self.command[0]) is not None
        return {
            "ready": binary_available,
            "configured": True,
            "binary_available": binary_available,
            "compatibility_verified": False,
            "license_assets_bundled": False,
        }

    def synthesize(self, text: str, voice: str) -> bytes:
        with tempfile.TemporaryDirectory(prefix="tts-ivona-") as temp_dir:
            text_path = Path(temp_dir) / "input.txt"
            output_path = Path(temp_dir) / "speech.wav"
            text_path.write_text(text, encoding="utf-8")
            replacements = {
                "{text_file}": str(text_path),
                "{output_file}": str(output_path),
                "{voice}": voice,
            }
            argv = [_replace_placeholders(arg, replacements) for arg in self.command]
            _run(argv, input_text=None, timeout_seconds=self.timeout_seconds)
            return validate_wav(output_path.read_bytes(), self.max_wav_bytes)


class FakeBackend:
    """Deterministic test backend. Do not select it in a real deployment."""

    name = "fake"

    def __init__(self, delay_seconds: float = 0.0) -> None:
        self.delay_seconds = delay_seconds
        self._state_lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def health(self) -> dict[str, Any]:
        return {"ready": True, "configured": True, "test_only": True}

    def synthesize(self, text: str, voice: str) -> bytes:
        del text, voice
        with self._state_lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay_seconds:
                time.sleep(self.delay_seconds)
            return _silent_wav()
        finally:
            with self._state_lock:
                self.active -= 1


def _replace_placeholders(value: str, replacements: dict[str, str]) -> str:
    for placeholder, replacement in replacements.items():
        value = value.replace(placeholder, replacement)
    return value


def _run(argv: Sequence[str], *, input_text: str | None, timeout_seconds: int) -> None:
    try:
        result = subprocess.run(
            list(argv),
            input=input_text,
            text=input_text is not None,
            stdin=subprocess.DEVNULL if input_text is None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
            shell=False,
        )
    except (FileNotFoundError, PermissionError) as exc:
        raise RuntimeError("TTS backend executable is unavailable") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"TTS backend timed out after {timeout_seconds} seconds") from exc
    if result.returncode != 0:
        stderr = (result.stderr or "").strip().replace("\n", " ")[-500:]
        detail = f": {stderr}" if stderr else ""
        raise RuntimeError(f"TTS backend exited with code {result.returncode}{detail}")


def _silent_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16_000)
        wav_file.writeframes(struct.pack("<h", 0) * 1_600)
    return buffer.getvalue()


def process_rss_bytes() -> int | None:
    status = Path("/proc/self/status")
    if status.is_file():
        for line in status.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    try:
        import resource

        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if value <= 0:
            return None
        return int(value * (1 if os.uname().sysname == "Darwin" else 1024))
    except (ImportError, AttributeError, OSError):
        return None


class Bridge:
    def __init__(self, backend: Backend, limits: Limits | None = None, token: str | None = None) -> None:
        self.backend = backend
        self.limits = limits or Limits()
        self.token = token
        self._synthesis_lock = threading.Lock()
        self.started_at = time.monotonic()

    def health(self) -> dict[str, Any]:
        backend_health = self.backend.health()
        ready = backend_health.get("ready") is True
        return {
            "status": "ok" if ready else "degraded",
            "service": "tts-bridge",
            "version": SERVICE_VERSION,
            "backend": self.backend.name,
            "serialized": True,
            "uptime_seconds": math.floor(time.monotonic() - self.started_at),
            "process_rss_bytes": process_rss_bytes(),
            "backend_health": backend_health,
        }

    def synthesize(self, payload: Any) -> bytes:
        if not isinstance(payload, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_json", "request must be a JSON object")
        text = validate_text(payload.get("text"), self.limits.max_text_chars)
        voice = validate_voice(payload.get("voice"))
        with self._synthesis_lock:
            try:
                result = self.backend.synthesize(text, voice)
                return validate_wav(result, self.limits.max_wav_bytes)
            except RequestError:
                raise
            except (OSError, RuntimeError) as exc:
                raise RequestError(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "synthesis_failed",
                    str(exc),
                ) from exc


def make_handler(bridge: Bridge) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "TTSBridge/0.1"

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self._json_error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
                return
            health = bridge.health()
            status = HTTPStatus.OK if health["status"] == "ok" else HTTPStatus.SERVICE_UNAVAILABLE
            self._json(status, health)

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/synthesize":
                self._json_error(HTTPStatus.NOT_FOUND, "not_found", "route not found")
                return
            if bridge.token is not None:
                supplied = self.headers.get("Authorization", "")
                expected = f"Bearer {bridge.token}"
                if not hmac.compare_digest(supplied, expected):
                    self._json_error(HTTPStatus.UNAUTHORIZED, "unauthorized", "valid bearer token required")
                    return
            try:
                payload = self._read_json(bridge.limits.max_body_bytes)
                wav = bridge.synthesize(payload)
            except RequestError as exc:
                self._json_error(exc.status, exc.code, exc.message)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(wav)

        def _read_json(self, max_body_bytes: int) -> Any:
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                raise RequestError(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    "unsupported_media_type",
                    "Content-Type must be application/json",
                )
            raw_length = self.headers.get("Content-Length")
            try:
                length = int(raw_length or "")
            except ValueError as exc:
                raise RequestError(HTTPStatus.LENGTH_REQUIRED, "length_required", "valid Content-Length required") from exc
            if length < 0 or length > max_body_bytes:
                raise RequestError(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    "body_too_large",
                    f"body must not exceed {max_body_bytes} bytes",
                )
            body = self.rfile.read(length)
            try:
                return json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RequestError(HTTPStatus.BAD_REQUEST, "invalid_json", "body must be valid UTF-8 JSON") from exc

        def _json_error(self, status: HTTPStatus, code: str, message: str) -> None:
            self._json(status, {"error": {"code": code, "message": message}})

        def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            # Avoid logging request bodies; the default line contains only route/status.
            super().log_message(format, *args)

    return Handler


def build_backend(name: str) -> Backend:
    if name == "rhvoice":
        return RHVoiceBackend()
    if name == "piper":
        return PiperBackend()
    if name == "ivona":
        return CommandBackend()
    if name == "fake" and os.getenv("TTS_ALLOW_FAKE_BACKEND") == "1":
        return FakeBackend()
    raise RuntimeError("TTS_BACKEND must be rhvoice, piper or ivona")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serialized HTTP TTS bridge")
    parser.add_argument("--host", default=os.getenv("TTS_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=_env_int("TTS_PORT", 8092, minimum=1, maximum=65535))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    backend_name = os.getenv("TTS_BACKEND", "").strip().lower()
    limits = Limits(
        max_text_chars=_env_int(
            "TTS_MAX_TEXT_CHARS", DEFAULT_MAX_TEXT_CHARS, minimum=1, maximum=HARD_MAX_TEXT_CHARS
        ),
        max_body_bytes=_env_int(
            "TTS_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, minimum=1024, maximum=1024 * 1024
        ),
        max_wav_bytes=_env_int(
            "TTS_MAX_WAV_BYTES", DEFAULT_MAX_WAV_BYTES, minimum=1024, maximum=256 * 1024 * 1024
        ),
    )
    token = os.getenv("TTS_TOKEN")
    bridge = Bridge(build_backend(backend_name), limits, token=token if token else None)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(bridge))
    print(f"tts-bridge listening on {args.host}:{args.port} backend={backend_name}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
