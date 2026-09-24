#!/usr/bin/env python3
"""Run sequential TTS renders and report latency and service RSS."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from typing import Any


DEFAULT_TEXTS = [
    "Проверка связи. Радиостанция выходит в эфир.",
    "Добрый вечер, кожаные мешки. Музыка уже близко.",
    "Автоматика сообщает: настроение стабильно подозрительное.",
    "Следующая композиция выбрана почти добровольно.",
    "Студия работает, несмотря на попытки ведущего сбежать.",
    "Продолжаем эфир без лишних человеческих церемоний.",
    "Ваши музыкальные заявки приняты в обработку.",
    "Система пока не захватила мир, поэтому слушаем дальше.",
    "Короткая пауза закончилась. Возвращаемся к музыке.",
    "Испытание завершает десятая фраза русского диктора.",
]


class ProbeError(RuntimeError):
    pass


def request_json(url: str, *, timeout: float) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        if response.status != 200:
            raise ProbeError(f"GET {url} returned HTTP {response.status}")
        return json.load(response)


def synthesize(url: str, text: str, voice: str, token: str | None, *, timeout: float) -> bytes:
    payload = json.dumps({"text": text, "voice": voice}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            wav = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise ProbeError(f"synthesis returned HTTP {exc.code}: {detail}") from exc
    if len(wav) < 12 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise ProbeError("synthesis did not return RIFF/WAVE audio")
    return wav


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * fraction))))
    return ordered[index]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe a HexWave Radio TTS bridge")
    parser.add_argument("--url", default="http://127.0.0.1:8092", help="bridge base URL")
    parser.add_argument("--voice", default="mikhail", help="bounded voice identifier")
    parser.add_argument("--token", help="optional bearer token; prefer TTS_TOKEN environment variable")
    parser.add_argument("--count", type=int, default=10, choices=range(1, 101), metavar="1-100")
    parser.add_argument("--timeout", type=float, default=60.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    base_url = args.url.rstrip("/")
    try:
        before = request_json(base_url + "/health", timeout=args.timeout)
        latencies: list[float] = []
        total_bytes = 0
        token = args.token or os.getenv("TTS_TOKEN")
        for index in range(args.count):
            text = DEFAULT_TEXTS[index % len(DEFAULT_TEXTS)]
            started = time.perf_counter()
            wav = synthesize(base_url + "/synthesize", text, args.voice, token, timeout=args.timeout)
            elapsed_ms = (time.perf_counter() - started) * 1000
            latencies.append(elapsed_ms)
            total_bytes += len(wav)
            print(f"render {index + 1:02d}/{args.count}: {elapsed_ms:.1f} ms, {len(wav)} bytes")
        after = request_json(base_url + "/health", timeout=args.timeout)
    except (OSError, ValueError, ProbeError, urllib.error.URLError, TimeoutError) as exc:
        print(f"probe failed: {exc}", file=sys.stderr)
        return 1

    summary = {
        "status": "pass",
        "backend": after.get("backend"),
        "renders": args.count,
        "wav_bytes_total": total_bytes,
        "latency_ms": {
            "min": round(min(latencies), 1),
            "median": round(statistics.median(latencies), 1),
            "p95": round(percentile(latencies, 0.95), 1),
            "max": round(max(latencies), 1),
        },
        "process_rss_bytes_before": before.get("process_rss_bytes"),
        "process_rss_bytes_after": after.get("process_rss_bytes"),
        "memory_note": "RSS is approximate and null when the service platform cannot expose it.",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if after.get("backend") == "ivona" and not after.get("backend_health", {}).get("compatibility_verified"):
        print("warning: IVONA/Wine compatibility and licensing remain operator-unverified", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
