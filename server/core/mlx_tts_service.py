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
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model as _mlx_load_model

    _MLX_AVAILABLE = True
except ImportError:
    mx = None  # type: ignore[assignment]
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

MODELS: dict[str, dict[str, Any]] = {
    "mlx-community/Kokoro-82M-bf16": {
        "name": "Kokoro 82M",
        "description": "Fast multilingual TTS with 50+ preset voices",
        "load_kwargs": {},
        "languages": ["EN", "JA", "ZH", "FR", "ES", "IT", "PT", "HI"],
        "sample_rate": 24000,
        "voices": [
            # American English
            {"id": "af_heart", "name": "Heart (American ♀)"},
            {"id": "af_bella", "name": "Bella (American ♀)"},
            {"id": "af_nova", "name": "Nova (American ♀)"},
            {"id": "af_sky", "name": "Sky (American ♀)"},
            {"id": "af_aurora", "name": "Aurora (American ♀)"},
            {"id": "af_jessica", "name": "Jessica (American ♀)"},
            {"id": "af_kore", "name": "Kore (American ♀)"},
            {"id": "af_nicole", "name": "Nicole (American ♀)"},
            {"id": "af_sarah", "name": "Sarah (American ♀)"},
            {"id": "af_valley", "name": "Valley (American ♀)"},
            {"id": "am_adam", "name": "Adam (American ♂)"},
            {"id": "am_echo", "name": "Echo (American ♂)"},
            {"id": "am_eric", "name": "Eric (American ♂)"},
            {"id": "am_fenrir", "name": "Fenrir (American ♂)"},
            {"id": "am_liam", "name": "Liam (American ♂)"},
            {"id": "am_michael", "name": "Michael (American ♂)"},
            {"id": "am_onyx", "name": "Onyx (American ♂)"},
            {"id": "am_puck", "name": "Puck (American ♂)"},
            # British English
            {"id": "bf_alice", "name": "Alice (British ♀)"},
            {"id": "bf_emma", "name": "Emma (British ♀)"},
            {"id": "bf_isabella", "name": "Isabella (British ♀)"},
            {"id": "bf_lily", "name": "Lily (British ♀)"},
            {"id": "bm_daniel", "name": "Daniel (British ♂)"},
            {"id": "bm_fable", "name": "Fable (British ♂)"},
            {"id": "bm_george", "name": "George (British ♂)"},
            {"id": "bm_lewis", "name": "Lewis (British ♂)"},
            # Japanese
            {"id": "jf_alpha", "name": "Alpha (Japanese ♀)"},
            {"id": "jf_gongitsune", "name": "Gongitsune (Japanese ♀)"},
            {"id": "jf_nezumi", "name": "Nezumi (Japanese ♀)"},
            {"id": "jf_tebukuro", "name": "Tebukuro (Japanese ♀)"},
            {"id": "jm_kumo", "name": "Kumo (Japanese ♂)"},
            # Mandarin Chinese
            {"id": "zf_xiaobei", "name": "Xiaobei (Chinese ♀)"},
            {"id": "zf_xiaoni", "name": "Xiaoni (Chinese ♀)"},
            {"id": "zf_xiaoxiao", "name": "Xiaoxiao (Chinese ♀)"},
            {"id": "zf_xiaoyi", "name": "Xiaoyi (Chinese ♀)"},
            {"id": "zm_yunxi", "name": "Yunxi (Chinese ♂)"},
            {"id": "zm_yunye", "name": "Yunye (Chinese ♂)"},
            {"id": "zm_yunfeng", "name": "Yunfeng (Chinese ♂)"},
            {"id": "zm_yunjian", "name": "Yunjian (Chinese ♂)"},
            # Spanish
            {"id": "ef_dora", "name": "Dora (Spanish ♀)"},
            {"id": "em_alex", "name": "Alex (Spanish ♂)"},
            # French
            {"id": "ff_siwis", "name": "Siwis (French ♀)"},
            # Hindi
            {"id": "hf_alpha", "name": "Alpha (Hindi ♀)"},
            {"id": "hf_beta", "name": "Beta (Hindi ♀)"},
            {"id": "hm_omega", "name": "Omega (Hindi ♂)"},
            {"id": "hm_psi", "name": "Psi (Hindi ♂)"},
            # Italian
            {"id": "if_sara", "name": "Sara (Italian ♀)"},
            {"id": "im_nicola", "name": "Nicola (Italian ♂)"},
            # Brazilian Portuguese
            {"id": "pf_dora", "name": "Dora (Portuguese ♀)"},
            {"id": "pm_alex", "name": "Alex (Portuguese ♂)"},
        ],
    },
    "mlx-community/OuteTTS-1.0-0.6B-fp16": {
        "name": "OuteTTS 0.6B",
        "description": "Efficient English TTS",
        "languages": ["EN"],
        "sample_rate": 24000,
        "load_kwargs": {},
        "voices": [
            {"id": "default", "name": "Default"},
        ],
    },
    "mlx-community/Soprano-1.1-80M-bf16": {
        "name": "Soprano 80M",
        "description": "Lightweight high-quality English TTS",
        "languages": ["EN"],
        "sample_rate": 32000,
        # The mlx-community weights include extra parameters not present in the
        # current mlx-audio soprano module; strict=False silently skips them.
        "load_kwargs": {"strict": False},
        "voices": [
            {"id": "default", "name": "Default"},
        ],
    },
}

# Kokoro voice-prefix → lang_code mapping
_KOKORO_LANG: dict[str, str] = {
    "a": "a",  # American English
    "b": "b",  # British English
    "j": "j",  # Japanese
    "z": "z",  # Mandarin Chinese
    "e": "e",  # Spanish
    "f": "f",  # French
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "p": "p",  # Portuguese
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _detect_lang_code(voice: str) -> str | None:
    """Derive Kokoro lang_code from voice ID prefix (e.g. 'af_heart' → 'a')."""
    return _KOKORO_LANG.get(voice[0]) if voice else None


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
            if "Soprano" in model_id or "soprano" in model_id:
                self._loaded[model_id] = self._load_soprano(model_id)
            else:
                load_kwargs = MODELS.get(model_id, {}).get("load_kwargs", {})
                self._loaded[model_id] = _mlx_load_model(model_id, **load_kwargs)
        return self._loaded[model_id]

    def _load_soprano(self, model_id: str) -> Any:
        """Load a Soprano model with decoder dimensions inferred from the checkpoint.

        The mlx_audio DecoderConfig hard-codes decoder_dim=512, but the
        mlx-community/Soprano-1.1-80M-bf16 checkpoint was trained with
        decoder_dim=768.  Loading with strict=False patches the weight arrays
        but leaves groups=512 on the depthwise conv, causing a runtime error.
        We detect the real decoder_dim from the embed weight shape and rebuild
        the model with the correct config before loading weights.
        """
        import glob
        import json
        from pathlib import Path

        from mlx_audio.tts.models.soprano.soprano import DecoderConfig, Model, ModelConfig
        from mlx_audio.tts.utils import get_model_path

        model_path: Path = get_model_path(model_id)

        # Load all checkpoint weights.
        weight_files = glob.glob(str(model_path / "*.safetensors"))
        weights: dict[str, Any] = {}
        for wf in weight_files:
            weights.update(mx.load(wf))

        # Infer decoder architecture from weight shapes.
        embed_w = weights.get("decoder.decoder.embed.weight")
        pw1_w = weights.get("decoder.decoder.convnext.0.pwconv1.weight")
        num_layers = sum(
            1 for k in weights if k.startswith("decoder.decoder.convnext.") and k.endswith(".gamma")
        )
        decoder_dim: int = int(embed_w.shape[0]) if embed_w is not None else 512
        intermediate_dim: int = int(pw1_w.shape[0]) if pw1_w is not None else decoder_dim * 3

        # Load and patch the model config.
        with open(model_path / "config.json") as f:
            config_dict = json.load(f)

        base_cfg = ModelConfig.from_dict(config_dict)
        base_cfg.decoder_config = DecoderConfig(
            decoder_num_layers=num_layers or base_cfg.decoder_config.decoder_num_layers,
            decoder_dim=decoder_dim,
            decoder_intermediate_dim=intermediate_dim,
        )

        model = Model(base_cfg)
        sanitized = model.sanitize(weights)
        model.load_weights(list(sanitized.items()), strict=False)
        mx.eval(model.parameters())
        model.eval()
        model = Model.post_load_hook(model, model_path)
        return model

    def _generate_sync(
        self,
        text: str,
        voice: str,
        model_id: str,
        sample_rate: int,
    ) -> tuple[bytes, float]:
        model = self._load_model(model_id)

        # OuteTTS expects None to use the bundled default speaker; passing the
        # string "default" causes a "Speaker file not found" error.
        effective_voice: str | None = voice
        if ("OuteTTS" in model_id or "outetts" in model_id.lower()) and voice == "default":
            effective_voice = None

        kwargs: dict[str, Any] = {"voice": effective_voice}
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
