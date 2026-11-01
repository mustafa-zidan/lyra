# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for MLXTTSService (no model is loaded)."""

import io
import wave
from collections.abc import Iterator
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.core.config import Settings
from server.core.mlx_tts_service import (
    _MLX_AVAILABLE,
    MODELS,
    MLXTTSService,
    _array_to_wav,
    _language_from_tag,
    _Segment,
    _word_timings,
)

KOKORO = "mlx-community/Kokoro-82M-bf16"
GERMAN_VICTORIA = "kikiri-tts/kikiri-german-victoria"


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


@pytest.mark.parametrize(
    ("model", "expected_voice"),
    [(KOKORO, "af_heart"), (GERMAN_VICTORIA, "df_victoria")],
)
async def test_generate_without_voice_uses_a_voice_of_the_model(
    service: MLXTTSService, captured_generate: list[tuple], model: str, expected_voice: str
) -> None:
    result = await service.generate("Hello there", model_id=model)
    assert result.voice == expected_voice


def test_array_to_wav_produces_valid_mono_16bit_wav() -> None:
    data = _array_to_wav(np.zeros(2400, dtype=np.float32), 24000)
    with wave.open(io.BytesIO(data)) as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 24000
        assert wf.getnframes() == 2400


@pytest.fixture()
def captured_generate(service: MLXTTSService, monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    """Replace model inference with a recorder of (model, voice, language) per call."""
    calls: list[tuple] = []

    def fake_generate_sync(text, voice, model_id, language, speed=1.0):
        calls.append((model_id, voice, language))
        return b"", 0.0, []

    monkeypatch.setattr(service, "_generate_sync", fake_generate_sync)
    return calls


@pytest.mark.parametrize(
    ("text", "model", "voice", "language", "expected"),
    [
        # An English Kokoro voice can't read kana/Han/Devanagari: switch language and voice.
        ("こんにちは、いい天気ですね。", KOKORO, "af_heart", None, (KOKORO, "jf_alpha", "ja")),
        ("你好，今天天气很好。", KOKORO, "af_heart", None, (KOKORO, "zf_xiaobei", "zh")),
        ("नमस्ते, आप कैसे हैं?", KOKORO, "af_heart", None, (KOKORO, "hf_alpha", "hi")),
        # Kanji-only text is ambiguous; a Japanese page hint keeps it Japanese.
        ("東京都", KOKORO, "af_heart", "ja", (KOKORO, "jf_alpha", "ja")),
        # Latin-script languages come from the hint.
        ("Hola, ¿cómo estás?", KOKORO, "af_heart", "es-MX", (KOKORO, "ef_dora", "es")),
        ("Olá, tudo bem?", KOKORO, "af_heart", "pt-BR", (KOKORO, "pf_dora", "pt")),
        # A voice that already matches is kept.
        ("こんにちは", KOKORO, "jm_kumo", None, (KOKORO, "jm_kumo", "ja")),
        ("Bonjour", KOKORO, "ff_siwis", None, (KOKORO, "ff_siwis", "fr")),
        # US and UK English voices are interchangeable.
        ("Hello there", KOKORO, "bm_george", "en-US", (KOKORO, "bm_george", "en-US")),
        # A few CJK characters inside English text don't flip the language.
        ("The word 東京 means capital.", KOKORO, "af_heart", None, (KOKORO, "af_heart", "en-US")),
        # German isn't in upstream Kokoro: switch to the German Kokoro fine-tune.
        ("Guten Tag", KOKORO, "af_heart", "de", (GERMAN_VICTORIA, "df_victoria", "de")),
        # ...and a German model asked for another language goes back to upstream Kokoro.
        ("こんにちは", GERMAN_VICTORIA, "df_victoria", None, (KOKORO, "jf_alpha", "ja")),
        # Tags no model speaks are ignored: the voice reads it as its own language.
        ("Goedemorgen", KOKORO, "af_heart", "nl", (KOKORO, "af_heart", "en-US")),
        ("Hallo", GERMAN_VICTORIA, "df_victoria", None, (GERMAN_VICTORIA, "df_victoria", "de")),
    ],
)
async def test_generate_resolves_language_model_and_voice(
    service: MLXTTSService,
    captured_generate: list[tuple],
    text: str,
    model: str,
    voice: str,
    language: str | None,
    expected: tuple[str, str, str | None],
) -> None:
    result = await service.generate(text, voice=voice, model_id=model, language=language)
    assert captured_generate == [expected]
    assert (result.model, result.voice) == expected[:2]


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("en-GB", "en-GB"),
        ("en_us", "en-US"),
        ("EN", "en-US"),
        ("zh-Hant-TW", "zh"),
        ("cmn", "zh"),
        ("de-AT", "de"),
        ("th", None),
        ("", None),
    ],
)
def test_language_from_tag(tag: str, expected: str | None) -> None:
    assert _language_from_tag(tag) == expected


@pytest.mark.skipif(not _MLX_AVAILABLE, reason="needs a platform extra (mlx-audio)")
def test_kokoro_interpolate_round_trip_keeps_length() -> None:
    import mlx.core as mx
    from mlx_audio.tts.models.kokoro import istftnet

    # 34200 * (1/300) is 114.00000000000001 in floating point; unpatched, ceil gives 115.
    x = mx.zeros((1, 9, 34200))
    down = istftnet.interpolate(x, scale_factor=1 / 300, mode="linear")
    assert down.shape[-1] == 114
    assert istftnet.interpolate(down, scale_factor=300, mode="linear").shape[-1] == 34200


def _token(text: str, start: float | None, end: float | None) -> SimpleNamespace:
    return SimpleNamespace(text=text, start_ts=start, end_ts=end)


def test_word_timings_from_english_tokens() -> None:
    text = "Dr. Smith paid $5."
    tokens = [
        _token("Dr.", 0.2, 0.6),
        _token("Smith", 0.6, 0.9),
        _token("paid", 0.9, 1.1),
        _token("$", None, None),  # no phonemes, no timestamp
        _token("5", 1.1, 1.8),
        _token(".", 1.8, 1.9),  # punctuation isn't a word
    ]
    segments = [_Segment(text, tokens, offset=0.0, duration=2.0)]
    assert _word_timings(text, segments) == [
        (0, 2, 0.2, 0.6),
        (4, 9, 0.6, 0.9),
        (10, 14, 0.9, 1.1),
        (16, 17, 1.1, 1.8),
    ]


def test_word_timings_offsets_later_segments() -> None:
    text = "One.\nTwo."
    segments = [
        _Segment("One.", [_token("One", 0.1, 0.5)], offset=0.0, duration=0.7),
        _Segment("Two.", [_token("Two", 0.1, 0.5)], offset=0.7, duration=0.7),
    ]
    assert _word_timings(text, segments) == [(0, 3, 0.1, 0.5), (5, 8, 0.8, 1.2)]


def test_word_timings_estimated_without_tokens() -> None:
    # Non-English segments have no timestamps: the duration is shared by word length.
    text = "Bonjour, je vais bien."
    words = _word_timings(text, [_Segment(text, None, offset=1.0, duration=2.0)])
    assert [text[a:b] for a, b, _, _ in words] == ["Bonjour", "je", "vais", "bien"]
    assert words[0][2] == 1.0
    assert words[-1][3] == 3.0
    starts = [w[2] for w in words]
    assert starts == sorted(starts)
    # Longer words get longer.
    assert words[0][3] - words[0][2] > words[1][3] - words[1][2]


def test_word_timings_split_chinese_and_japanese_by_character() -> None:
    text = "今日は。"
    words = _word_timings(text, [_Segment(text, None, offset=0.0, duration=0.9)])
    assert [text[a:b] for a, b, _, _ in words] == ["今", "日", "は"]


def test_word_timings_skip_words_rewritten_by_the_g2p() -> None:
    text = "He left."
    tokens = [_token("Mister", 0.0, 0.2), _token("He", 0.2, 0.4), _token("left", 0.4, 0.8)]
    words = _word_timings(text, [_Segment(text, tokens, offset=0.0, duration=1.0)])
    assert [text[a:b] for a, b, _, _ in words] == ["He", "left"]


def test_word_timings_use_utf16_offsets() -> None:
    # The browser indexes strings in UTF-16: an emoji is two code units.
    text = "😀 hello"
    words = _word_timings(text, [_Segment(text, [_token("hello", 0.0, 0.5)], 0.0, 0.5)])
    assert words == [(3, 8, 0.0, 0.5)]


def test_word_timings_join_pieces_of_one_written_word() -> None:
    text = "the serpent's well-known bite"
    tokens = [
        _token("the", 0.0, 0.1),
        _token("serpent", 0.1, 0.5),
        _token("'s", 0.5, 0.6),
        _token("well", 0.6, 0.8),
        _token("-", None, None),
        _token("known", 0.8, 1.0),
        _token("bite", 1.0, 1.3),
    ]
    words = _word_timings(text, [_Segment(text, tokens, offset=0.0, duration=1.3)])
    assert [(text[a:b], t0, t1) for a, b, t0, t1 in words] == [
        ("the", 0.0, 0.1),
        ("serpent's", 0.1, 0.6),
        ("well-known", 0.6, 1.0),
        ("bite", 1.0, 1.3),
    ]
