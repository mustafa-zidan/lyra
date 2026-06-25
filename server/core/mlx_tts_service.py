# SPDX-License-Identifier: AGPL-3.0-only
"""MLX-Audio TTS service — Apple Silicon backend via the mlx-audio library."""

import asyncio
import concurrent.futures
import io
import logging
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
    logger.warning("mlx-audio not installed; MLX TTS backend unavailable (pip install mlx-audio)")


# ---------------------------------------------------------------------------
# Shared result type (mirrors eurydice AudioResult interface)
# ---------------------------------------------------------------------------


@dataclass
class AudioResult:
    audio_data: bytes
    duration: float
    cached: bool = False
    voice: str = ""


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

# First-character → Kokoro lang_code (passed to the model at generation time).
_KOKORO_LANG_CODE: dict[str, str] = {prefix: prefix for prefix in _KOKORO_LANG_LABEL}

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


def _detect_lang_code(voice: str) -> str | None:
    """Derive Kokoro lang_code from voice ID prefix (e.g. 'af_heart' → 'a')."""
    return _KOKORO_LANG_CODE.get(voice[0]) if voice else None


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


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class MLXTTSService:
    """TTS service backed by the mlx-audio library (Apple Silicon only)."""

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
    ) -> AudioResult:
        mid = model_id or self._settings.mlx_model
        v = voice or self._settings.mlx_default_voice
        sample_rate: int = MODELS.get(mid, {}).get("sample_rate", 24000)

        loop = asyncio.get_event_loop()
        wav_bytes, duration = await loop.run_in_executor(
            self._executor, self._generate_sync, text, v, mid, sample_rate
        )
        return AudioResult(audio_data=wav_bytes, duration=duration, voice=v)

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
    ) -> tuple[bytes, float]:
        model = self._load_model(model_id)

        kwargs: dict[str, Any] = {"voice": voice}
        if "Kokoro" in model_id or "kokoro" in model_id:
            lang_code = _detect_lang_code(voice)
            if lang_code:
                kwargs["lang_code"] = lang_code

        chunks: list[np.ndarray] = []
        try:
            for result in model.generate(text, **kwargs):
                chunks.append(np.array(result.audio))
        except SystemExit as exc:
            # spaCy's auto-download calls `pip install` internally, which fails in uv
            # environments.  Fix: `uv pip install -e ".[mlx]"` (includes en-core-web-sm).
            raise RuntimeError(
                "Kokoro G2P failed to download its spaCy model via pip. "
                "Run: uv pip install -e '.[mlx]'  to install en-core-web-sm with uv."
            ) from exc

        audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        duration = float(len(audio)) / sample_rate
        return _array_to_wav(audio, sample_rate), duration
