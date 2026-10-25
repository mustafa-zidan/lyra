# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for MLXTTSService (no model is loaded)."""

import io
import wave
from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.core.config import Settings
from server.core.mlx_tts_service import (
    _MLX_AVAILABLE,
    MODELS,
    MLXTTSService,
    _array_to_wav,
    _lang_code_from_tag,
)


@pytest.fixture()
def service(settings_override: Settings) -> Iterator[MLXTTSService]:
    svc = MLXTTSService(settings_override)
    yield svc
    svc._executor.shutdown(wait=False)


def test_models_endpoint_lists_kokoro_variants(client: TestClient) -> None:
    models = client.get("/models").json()["models"]
    assert [m["id"] for m in models] == list(MODELS)
    assert [m["id"] for m in models if m["default"]] == ["mlx-community/Kokoro-82M-bf16"]


async def test_generate_rejects_unknown_voice(service: MLXTTSService) -> None:
    with pytest.raises(ValueError, match="Invalid voice"):
        await service.generate("Hi", voice="leo")


async def test_generate_rejects_unknown_model(service: MLXTTSService) -> None:
    with pytest.raises(ValueError, match="Invalid model"):
        await service.generate("Hi", model_id="eurydice")


def test_array_to_wav_produces_valid_mono_16bit_wav() -> None:
    data = _array_to_wav(np.zeros(2400, dtype=np.float32), 24000)
    with wave.open(io.BytesIO(data)) as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 24000
        assert wf.getnframes() == 2400


@pytest.fixture()
def captured_generate(service: MLXTTSService, monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    """Replace model inference with a recorder of (voice, lang_code) per call."""
    calls: list[tuple] = []

    def fake_generate_sync(text, voice, model_id, sample_rate, lang_code):
        calls.append((voice, lang_code))
        return b"", 0.0

    monkeypatch.setattr(service, "_generate_sync", fake_generate_sync)
    return calls


@pytest.mark.parametrize(
    ("text", "voice", "language", "expected"),
    [
        # An English voice can't read kana/Han/Devanagari: switch language and voice.
        ("こんにちは、今日はいい天気ですね。", "af_heart", None, ("jf_alpha", "j")),
        ("你好，今天天气很好。", "af_heart", None, ("zf_xiaobei", "z")),
        ("नमस्ते, आप कैसे हैं?", "af_heart", None, ("hf_alpha", "h")),
        # Kanji-only text is ambiguous; a Japanese page hint keeps it Japanese.
        ("東京都", "af_heart", "ja", ("jf_alpha", "j")),
        # Latin-script languages come from the hint.
        ("Hola, ¿cómo estás?", "af_heart", "es-MX", ("ef_dora", "e")),
        ("Olá, tudo bem?", "af_heart", "pt-BR", ("pf_dora", "p")),
        # A voice that already matches is kept.
        ("こんにちは", "jm_kumo", None, ("jm_kumo", "j")),
        ("Bonjour", "ff_siwis", None, ("ff_siwis", "f")),
        # US and UK English voices are interchangeable.
        ("Hello there", "bm_george", "en-US", ("bm_george", "a")),
        # A few CJK characters inside English text don't flip the language.
        ("The word 東京 means eastern capital.", "af_heart", None, ("af_heart", "a")),
        # Unsupported hints are ignored.
        ("Guten Tag", "af_heart", "de", ("af_heart", "a")),
    ],
)
async def test_generate_resolves_language_and_voice(
        service: MLXTTSService,
        captured_generate: list[tuple],
        text: str,
        voice: str,
        language: str | None,
        expected: tuple[str, str],
) -> None:
    result = await service.generate(text, voice=voice, language=language)
    assert captured_generate == [expected]
    assert result.voice == expected[0]


@pytest.mark.parametrize(
    ("tag", "expected"),
    [("en-GB", "b"), ("en_us", "a"), ("EN", "a"), ("zh-Hant-TW", "z"), ("ko", None), ("", None)],
)
def test_lang_code_from_tag(tag: str, expected: str | None) -> None:
    assert _lang_code_from_tag(tag) == expected


@pytest.mark.skipif(not _MLX_AVAILABLE, reason="mlx-audio not installed")
def test_kokoro_interpolate_round_trip_keeps_length() -> None:
    import mlx.core as mx
    from mlx_audio.tts.models.kokoro import istftnet

    # 34200 * (1/300) is 114.00000000000001 in floating point; unpatched, ceil gives 115.
    x = mx.zeros((1, 9, 34200))
    down = istftnet.interpolate(x, scale_factor=1 / 300, mode="linear")
    assert down.shape[-1] == 114
    assert istftnet.interpolate(down, scale_factor=300, mode="linear").shape[-1] == 34200
