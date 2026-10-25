# SPDX-License-Identifier: AGPL-3.0-only
"""MLX-Audio TTS service — Kokoro via the mlx-audio library (Metal, CPU or CUDA MLX backend)."""

import asyncio
import concurrent.futures
import io
import logging
import math
import os
import re
import wave
from dataclasses import dataclass
from typing import Any

import numpy as np

from server.core.config import Settings

logger = logging.getLogger(__name__)

try:
    from mlx_audio.tts.utils import load_model as _mlx_load_model

    _MLX_AVAILABLE = True
except ImportError:
    _MLX_AVAILABLE = False
    logger.warning(
        "mlx-audio not installed; TTS unavailable. "
        "Install a platform extra: uv sync --extra apple | linux-cpu | linux-cuda"
    )


def _use_unidic_lite_if_unidic_missing() -> None:
    """Point fugashi at unidic-lite when the full unidic dictionary isn't downloaded.

    misaki[ja] depends on ``unidic``, which ships without its dictionary (~500 MB, fetched by
    ``python -m unidic download``). fugashi prefers ``unidic`` whenever it imports, so without
    this the Japanese G2P fails on a missing ``mecabrc``. The platform extras install
    ``unidic-lite``; a downloaded full unidic still wins.
    """
    try:
        import unidic
        import unidic_lite
    except ImportError:
        return
    if not os.path.exists(os.path.join(unidic.DICDIR, "mecabrc")):
        unidic.DICDIR = unidic_lite.DICDIR


def _patch_kokoro_interpolate() -> None:
    """Work around a float-rounding crash in mlx-audio's Kokoro vocoder (<= 0.6.1).

    SineGen downsamples the f0 track by ``1/300`` and upsamples it back by ``300``. The
    output size is ``ceil(len * scale)``, so e.g. ``ceil(34200 * (1/300))`` is
    ``ceil(114.00000000000001) == 115`` and the round trip comes back one frame long, raising
    ``[broadcast_shapes] Shapes (1,34200,1) and (1,34500,9)``. Whether it hits depends on the
    predicted audio length, so any language can trigger it. Rounding the product before
    ``ceil`` restores the intended size.
    """
    try:
        from mlx_audio.tts.models.kokoro import istftnet
    except ImportError:
        return
    original = istftnet.interpolate
    if getattr(original, "_lyra_patched", False):
        return

    def interpolate(input, size=None, scale_factor=None, *args, **kwargs):
        if size is None and isinstance(scale_factor, int | float):
            size = max(1, math.ceil(round(input.shape[-1] * scale_factor, 6)))
            scale_factor = None
        return original(input, size, scale_factor, *args, **kwargs)

    interpolate._lyra_patched = True  # type: ignore[attr-defined]
    istftnet.interpolate = interpolate


if _MLX_AVAILABLE:
    _use_unidic_lite_if_unidic_missing()
    _patch_kokoro_interpolate()


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class AudioResult:
    audio_data: bytes
    duration: float
    cached: bool = False
    voice: str = ""
    language: str = ""


# ---------------------------------------------------------------------------
# Static model / voice registry
# ---------------------------------------------------------------------------

# All Kokoro voices share a naming convention: the first ID character encodes
# the language/accent and the second encodes gender (f = female, m = male),
# e.g. "af_heart" → American-English female, "bm_george" → British-English male.
_KOKORO_LANG_LABEL: dict[str, str] = {
    "a": "English (US)",
    "b": "English (UK)",
    "j": "Japanese",
    "z": "Chinese",
    "e": "Spanish",
    "f": "French",
    "h": "Hindi",
    "i": "Italian",
    "p": "Portuguese",
}

# BCP-47 language tag (lower-cased) → Kokoro lang_code. Region-specific tags are tried
# before the bare language, so "en-GB" → British and any other "en-*" → American.
_BCP47_TO_LANG_CODE: dict[str, str] = {
    "en-gb": "b",
    "en": "a",
    "ja": "j",
    "zh": "z",
    "cmn": "z",
    "es": "e",
    "fr": "f",
    "hi": "h",
    "it": "i",
    "pt": "p",
}

# Scripts that identify a language on their own, whatever voice the user picked.
_KANA_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]")
_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097f]")
_LATIN_RE = re.compile(r"[A-Za-z\u00c0-\u024f]")

# Kokoro's pipeline only splits non-English text on ".!?" and truncates past 510 phonemes,
# so also split on CJK and Devanagari sentence marks.
_SPLIT_PATTERN = r"\n+|(?<=[。！？｡।])"

_GENDER_LABEL: dict[str, str] = {"f": "Female", "m": "Male"}

# The 54 Kokoro preset voices, shared across every Kokoro variant.
_KOKORO_VOICES: list[dict[str, str]] = [
    # American English
    {"id": "af_heart", "name": "Heart"},
    {"id": "af_bella", "name": "Bella"},
    {"id": "af_nova", "name": "Nova"},
    {"id": "af_sky", "name": "Sky"},
    {"id": "af_aurora", "name": "Aurora"},
    {"id": "af_jessica", "name": "Jessica"},
    {"id": "af_kore", "name": "Kore"},
    {"id": "af_nicole", "name": "Nicole"},
    {"id": "af_sarah", "name": "Sarah"},
    {"id": "af_valley", "name": "Valley"},
    {"id": "am_adam", "name": "Adam"},
    {"id": "am_echo", "name": "Echo"},
    {"id": "am_eric", "name": "Eric"},
    {"id": "am_fenrir", "name": "Fenrir"},
    {"id": "am_liam", "name": "Liam"},
    {"id": "am_michael", "name": "Michael"},
    {"id": "am_onyx", "name": "Onyx"},
    {"id": "am_puck", "name": "Puck"},
    # British English
    {"id": "bf_alice", "name": "Alice"},
    {"id": "bf_emma", "name": "Emma"},
    {"id": "bf_isabella", "name": "Isabella"},
    {"id": "bf_lily", "name": "Lily"},
    {"id": "bm_daniel", "name": "Daniel"},
    {"id": "bm_fable", "name": "Fable"},
    {"id": "bm_george", "name": "George"},
    {"id": "bm_lewis", "name": "Lewis"},
    # Japanese
    {"id": "jf_alpha", "name": "Alpha"},
    {"id": "jf_gongitsune", "name": "Gongitsune"},
    {"id": "jf_nezumi", "name": "Nezumi"},
    {"id": "jf_tebukuro", "name": "Tebukuro"},
    {"id": "jm_kumo", "name": "Kumo"},
    # Mandarin Chinese
    {"id": "zf_xiaobei", "name": "Xiaobei"},
    {"id": "zf_xiaoni", "name": "Xiaoni"},
    {"id": "zf_xiaoxiao", "name": "Xiaoxiao"},
    {"id": "zf_xiaoyi", "name": "Xiaoyi"},
    {"id": "zm_yunxi", "name": "Yunxi"},
    {"id": "zm_yunye", "name": "Yunye"},
    {"id": "zm_yunfeng", "name": "Yunfeng"},
    {"id": "zm_yunjian", "name": "Yunjian"},
    # Spanish
    {"id": "ef_dora", "name": "Dora"},
    {"id": "em_alex", "name": "Alex"},
    # French
    {"id": "ff_siwis", "name": "Siwis"},
    # Hindi
    {"id": "hf_alpha", "name": "Alpha"},
    {"id": "hf_beta", "name": "Beta"},
    {"id": "hm_omega", "name": "Omega"},
    {"id": "hm_psi", "name": "Psi"},
    # Italian
    {"id": "if_sara", "name": "Sara"},
    {"id": "im_nicola", "name": "Nicola"},
    # Brazilian Portuguese
    {"id": "pf_dora", "name": "Dora"},
    {"id": "pm_alex", "name": "Alex"},
]

_KOKORO_LANGUAGES = ["EN", "JA", "ZH", "FR", "ES", "IT", "PT", "HI"]

MODELS: dict[str, dict[str, Any]] = {
    "mlx-community/Kokoro-82M-bf16": {
        "name": "Kokoro 82M",
        "description": "Fast multilingual TTS with 54 preset voices — best quality",
        "load_kwargs": {},
        "languages": _KOKORO_LANGUAGES,
        "sample_rate": 24000,
        "voices": _KOKORO_VOICES,
    },
    "mlx-community/Kokoro-82M-8bit": {
        "name": "Kokoro 82M (8-bit)",
        "description": "Same 54 voices, 8-bit quantized — faster and smaller",
        "load_kwargs": {},
        "languages": _KOKORO_LANGUAGES,
        "sample_rate": 24000,
        "voices": _KOKORO_VOICES,
    },
    "mlx-community/Kokoro-82M-4bit": {
        "name": "Kokoro 82M (4-bit)",
        "description": "Same 54 voices, 4-bit quantized — lightest and fastest",
        "load_kwargs": {},
        "languages": _KOKORO_LANGUAGES,
        "sample_rate": 24000,
        "voices": _KOKORO_VOICES,
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _lang_code_from_tag(tag: str | None) -> str | None:
    """Map a BCP-47 tag (e.g. 'ja', 'pt-BR', 'en-GB') to a Kokoro lang_code, or None."""
    if not tag:
        return None
    tag = tag.strip().lower().replace("_", "-")
    parts = tag.split("-")
    return _BCP47_TO_LANG_CODE.get("-".join(parts[:2])) or _BCP47_TO_LANG_CODE.get(parts[0])


def _detect_script_lang(text: str) -> str | None:
    """Kokoro lang_code implied by the text's script (kana, Han, Devanagari), or None.

    Only scripts that outnumber Latin letters count, so an English sentence quoting a
    Chinese name stays English. Latin-script languages can't be told apart this way.
    """
    latin = len(_LATIN_RE.findall(text))
    kana = len(_KANA_RE.findall(text))
    han = len(_HAN_RE.findall(text))
    devanagari = len(_DEVANAGARI_RE.findall(text))
    if kana and kana + han > latin:
        return "j"
    if han > latin:
        return "z"
    if devanagari > latin:
        return "h"
    return None


def _resolve_lang_code(text: str, voice: str, hint: str | None) -> str:
    """Pick the Kokoro language for ``text``: script first, then the hint, then the voice.

    The script wins because a voice of another language can't read it at all (kana through
    the English G2P is gibberish). Han-only text is ambiguous between Chinese and Japanese
    (e.g. a kanji heading), so a Japanese hint keeps it Japanese.
    """
    hinted = _lang_code_from_tag(hint)
    script = _detect_script_lang(text)
    if script == "z" and hinted == "j":
        return "j"
    return script or hinted or voice[0]


def _voice_language(voice_id: str) -> str | None:
    """Human-readable language for a Kokoro voice ID (1st char), or None."""
    return _KOKORO_LANG_LABEL.get(voice_id[0]) if voice_id else None


def _voice_gender(voice_id: str) -> str | None:
    """Human-readable gender for a Kokoro voice ID (2nd char), or None."""
    return _GENDER_LABEL.get(voice_id[1]) if len(voice_id) > 1 else None


def _array_to_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    """Convert a float32 numpy array to WAV bytes (standard-library only)."""
    audio = np.clip(audio, -1.0, 1.0)
    audio_i16 = (audio * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(audio_i16.tobytes())
    return buf.getvalue()


def _voice_for_lang(lang_code: str, voice: str, voices: list[dict[str, str]], default: str) -> str:
    """Keep ``voice`` if it speaks ``lang_code``; otherwise pick one that does.

    American and British English voices are interchangeable. Prefers the server default
    voice, then the first voice of that language in the registry.
    """
    english = {"a", "b"}
    if voice[0] == lang_code or {voice[0], lang_code} <= english:
        return voice
    if default and default[0] == lang_code:
        return default
    return next((v["id"] for v in voices if v["id"][0] == lang_code), voice)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class MLXTTSService:
    """TTS service backed by the mlx-audio library."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._loaded: dict[str, Any] = {}
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="mlx-tts"
        )
        self._available = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def startup(self) -> None:
        if not _MLX_AVAILABLE:
            logger.warning("mlx-audio not installed — MLX backend unavailable")
            return
        model_id = self._settings.mlx_model
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(self._executor, self._load_model, model_id)
            self._available = True
            logger.info("MLX model ready: %s", model_id)
        except Exception as exc:
            logger.warning("Failed to load MLX model %s: %s", model_id, exc)

    async def shutdown(self) -> None:
        self._executor.shutdown(wait=False)

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def is_available(self) -> bool:
        return self._available

    @property
    def provider_name(self) -> str | None:
        return MODELS.get(self._settings.mlx_model, {}).get("name", "mlx-audio")

    # ------------------------------------------------------------------
    # Catalogue
    # ------------------------------------------------------------------

    def list_models(self) -> list[dict[str, Any]]:
        default_id = self._settings.mlx_model
        return [
            {
                "id": mid,
                "name": info["name"],
                "description": info["description"],
                "languages": info["languages"],
                "default": mid == default_id,
            }
            for mid, info in MODELS.items()
        ]

    def list_voices(self, model_id: str | None = None) -> list[dict[str, Any]]:
        mid = model_id or self._settings.mlx_model
        info = MODELS.get(mid, {})
        default_voice = self._settings.mlx_default_voice
        return [
            {
                "id": v["id"],
                "name": v["name"],
                "language": _voice_language(v["id"]),
                "gender": _voice_gender(v["id"]),
                "default": v["id"] == default_voice,
            }
            for v in info.get("voices", [])
        ]

    # ------------------------------------------------------------------
    # Generation
    # ------------------------------------------------------------------

    async def generate(
        self,
        text: str,
        voice: str | None = None,
        model_id: str | None = None,
        language: str | None = None,
    ) -> AudioResult:
        """Synthesize ``text``; ``language`` is an optional BCP-47 hint (e.g. the page lang).

        The voice is swapped for one of the resolved language when it doesn't match; the
        voice actually used is reported in the result.
        """
        mid = model_id or self._settings.mlx_model
        v = voice or self._settings.mlx_default_voice
        # ValueError is mapped to HTTP 400 by the route.
        if mid not in MODELS:
            raise ValueError(f"Invalid model: '{mid}'. Valid models: {', '.join(MODELS)}")
        valid_voices = [entry["id"] for entry in MODELS[mid]["voices"]]
        if v not in valid_voices:
            raise ValueError(f"Invalid voice: '{v}'. Valid voices: {', '.join(valid_voices)}")
        sample_rate: int = MODELS[mid]["sample_rate"]

        lang_code = _resolve_lang_code(text, v, language)
        v = _voice_for_lang(lang_code, v, MODELS[mid]["voices"], self._settings.mlx_default_voice)

        loop = asyncio.get_event_loop()
        wav_bytes, duration = await loop.run_in_executor(
            self._executor, self._generate_sync, text, v, mid, sample_rate, lang_code
        )
        return AudioResult(
            audio_data=wav_bytes, duration=duration, voice=v, language=_KOKORO_LANG_LABEL[lang_code]
        )

    # ------------------------------------------------------------------
    # Synchronous internals (run inside ThreadPoolExecutor)
    # ------------------------------------------------------------------

    def _load_model(self, model_id: str) -> Any:
        if model_id not in self._loaded:
            logger.info("Loading MLX model %s …", model_id)
            load_kwargs = MODELS.get(model_id, {}).get("load_kwargs", {})
            self._loaded[model_id] = _mlx_load_model(model_id, **load_kwargs)
        return self._loaded[model_id]

    def _generate_sync(
        self,
        text: str,
        voice: str,
        model_id: str,
        sample_rate: int,
        lang_code: str,
    ) -> tuple[bytes, float]:
        model = self._load_model(model_id)

        kwargs: dict[str, Any] = {"voice": voice, "lang_code": lang_code}
        if lang_code not in ("a", "b"):
            kwargs["split_pattern"] = _SPLIT_PATTERN

        chunks: list[np.ndarray] = []
        try:
            for result in model.generate(text, **kwargs):
                chunks.append(np.array(result.audio))
        except SystemExit as exc:
            # spaCy's auto-download calls `pip install` internally, which fails in uv
            # environments.  Fix: sync a platform extra (each one declares en-core-web-sm).
            raise RuntimeError(
                "Kokoro G2P failed to download its spaCy model via pip. "
                "Run: uv sync --extra apple (or linux-cpu / linux-cuda) to install en-core-web-sm."
            ) from exc

        audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        duration = float(len(audio)) / sample_rate
        return _array_to_wav(audio, sample_rate), duration
