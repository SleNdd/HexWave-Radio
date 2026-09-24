from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from tts_bridge import Bridge, FakeBackend, Limits, RHVoiceBackend, build_backend, make_handler, validate_wav


class RunningServer:
    def __init__(self, bridge: Bridge) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "RunningServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"


def post_json(url: str, payload: object, token: str | None = None) -> tuple[int, bytes, str]:
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, response.read(), response.headers.get_content_type()
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, exc.read(), exc.headers.get_content_type()


class BridgeHttpTest(unittest.TestCase):
    def test_empty_backend_output_returns_service_unavailable(self) -> None:
        class EmptyBackend:
            name = "empty"

            def health(self) -> dict[str, bool]:
                return {"ready": True}

            def synthesize(self, text: str, voice: str) -> bytes:
                del text, voice
                buffer = io.BytesIO()
                with wave.open(buffer, "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(22050)
                    output.writeframes(b"")
                return buffer.getvalue()

        with RunningServer(Bridge(EmptyBackend())) as running:
            status, body, content_type = post_json(
                running.url + "/synthesize", {"text": "Проверка голоса"}
            )
        self.assertEqual(status, 503)
        self.assertEqual(content_type, "application/json")
        self.assertEqual(json.loads(body)["error"]["code"], "synthesis_failed")

    def test_empty_wav_header_is_not_accepted_as_speech(self) -> None:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(22050)
            output.writeframes(b"")
        with self.assertRaisesRegex(RuntimeError, "empty WAV"):
            validate_wav(buffer.getvalue(), 100_000)

    def test_backend_must_be_selected_explicitly(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "TTS_BACKEND must be rhvoice, piper or ivona"):
            build_backend("")

    def test_rhvoice_accepts_only_installed_allowlisted_station_voices(self) -> None:
        def render(argv: list[str], *, input_text: str, timeout_seconds: int) -> None:
            self.assertEqual(argv[:4], ["RHVoice-test", "--profile", "arina", "--output"])
            self.assertEqual(input_text, "Привет, кожаные мешки.\n")
            self.assertEqual(timeout_seconds, 45)
            Path(argv[4]).write_bytes(FakeBackend().synthesize("", ""))

        with tempfile.TemporaryDirectory() as voices_dir:
            (Path(voices_dir) / "mikhail").mkdir()
            (Path(voices_dir) / "arina").mkdir()
            with patch.dict(os.environ, {"TTS_RHVOICE_BINARY": "RHVoice-test", "TTS_RHVOICE_VOICE": "mikhail",
                    "TTS_RHVOICE_ALLOWED_VOICES": "mikhail,arina", "TTS_RHVOICE_VOICES_DIR": voices_dir}):
                backend = RHVoiceBackend()
            with patch("tts_bridge._run", side_effect=render):
                wav = backend.synthesize("Привет, кожаные мешки.", "arina")
            with self.assertRaisesRegex(Exception, "voice is not enabled"):
                backend.synthesize("Привет", "untrusted")
        self.assertEqual(validate_wav(wav, 100_000), wav)

    def test_rhvoice_rejects_path_like_deployment_voice(self) -> None:
        with patch.dict(os.environ, {"TTS_RHVOICE_VOICE": "../escape"}):
            with self.assertRaisesRegex(RuntimeError, "voice identifier"):
                RHVoiceBackend()

    def test_health_and_synthesis_return_expected_types(self) -> None:
        with RunningServer(Bridge(FakeBackend())) as running:
            with urllib.request.urlopen(running.url + "/health", timeout=3) as response:
                health = json.load(response)
            self.assertEqual(health["status"], "ok")
            self.assertEqual(health["backend"], "fake")
            self.assertTrue(health["serialized"])

            status, body, content_type = post_json(
                running.url + "/synthesize",
                {"text": "Привет, кожаные мешки.", "voice": "maxim"},
            )
            self.assertEqual(status, 200)
            self.assertEqual(content_type, "audio/wav")
            self.assertEqual(validate_wav(body, 100_000), body)

    def test_text_and_voice_are_bounded(self) -> None:
        limits = Limits(max_text_chars=12)
        with RunningServer(Bridge(FakeBackend(), limits)) as running:
            cases = [
                ({"text": "English only"}, 400, "russian_text_required"),
                ({"text": "Очень длинный русский текст"}, 413, "text_too_long"),
                ({"text": "Привет", "voice": "../escape"}, 400, "invalid_voice"),
            ]
            for payload, expected_status, expected_code in cases:
                with self.subTest(payload=payload):
                    status, body, _ = post_json(running.url + "/synthesize", payload)
                    self.assertEqual(status, expected_status)
                    self.assertEqual(json.loads(body)["error"]["code"], expected_code)

    def test_parallel_http_requests_are_synthesized_serially(self) -> None:
        backend = FakeBackend(delay_seconds=0.08)
        with RunningServer(Bridge(backend)) as running:
            statuses: list[int] = []

            def call() -> None:
                status, _, _ = post_json(
                    running.url + "/synthesize",
                    {"text": "Последовательная проверка", "voice": "maxim"},
                )
                statuses.append(status)

            threads = [threading.Thread(target=call) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)

        self.assertEqual(sorted(statuses), [200, 200, 200, 200])
        self.assertEqual(backend.max_active, 1)

    def test_wrong_content_type_is_rejected(self) -> None:
        with RunningServer(Bridge(FakeBackend())) as running:
            request = urllib.request.Request(
                running.url + "/synthesize",
                data=b"{}",
                headers={"Content-Type": "text/plain"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request, timeout=3)
            with raised.exception:
                self.assertEqual(raised.exception.code, 415)

    def test_optional_bearer_token_protects_synthesis(self) -> None:
        with RunningServer(Bridge(FakeBackend(), token="test-secret")) as running:
            payload = {"text": "Проверка доступа", "voice": "maxim"}
            denied, body, _ = post_json(running.url + "/synthesize", payload)
            allowed, wav, _ = post_json(running.url + "/synthesize", payload, token="test-secret")
        self.assertEqual(denied, 401)
        self.assertEqual(json.loads(body)["error"]["code"], "unauthorized")
        self.assertEqual(allowed, 200)
        self.assertEqual(validate_wav(wav, 100_000), wav)


if __name__ == "__main__":
    unittest.main()
