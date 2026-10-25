# SPDX-License-Identifier: AGPL-3.0-only
"""MLX-Audio TTS service — Kokoro (and German Kokoro fine-tunes) via mlx-audio (Metal, CPU or CUDA)."""

import asyncio
import concurrent.futures
import io
import json
import logging
import math
import os
import re
import wave
from dataclasses import dataclass, field
from pathlib import Path
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


def _register_kokoro_german() -> None:
    """Teach mlx-audio's Kokoro pipeline a German lang_code ('d' → espeak-ng 'de').

    Upstream Kokoro has no German, so the pipeline rejects the code. The kikiri-tts German
    fine-tunes are trained on espeak-ng German phonemes, which the pipeline's generic espeak
    branch produces once the code is registered.
    """
    try:
        from mlx_audio.tts.models.kokoro import pipeline
    except ImportError:
        return
    pipeline.LANG_CODES.setdefault("d", "de")
    pipeline.ALIASES.setdefault("de", "d")


if _MLX_AVAILABLE:
    _use_unidic_lite_if_unidic_missing()
    _patch_kokoro_interpolate()
    _register_kokoro_german()


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
    model: str = ""


# ---------------------------------------------------------------------------
# Languages
# ---------------------------------------------------------------------------

# Canonical language codes used throughout the service. English keeps its region because
# Kokoro has separate US and UK G2Ps; every other language is a bare ISO 639-1 code.
LANGUAGE_LABELS: dict[str, str] = {
    "en-US": "English (US)",
    "en-GB": "English (UK)",
    "de": "German",
    "es": "Spanish",
    "fr": "French",
    "hi": "Hindi",
    "it": "Italian",
    "ja": "Japanese",
    "pt": "Portuguese",
    "zh": "Chinese",
}

_ENGLISH = {"en-US", "en-GB"}

# Deprecated or macro-language tags that browsers and pages still emit.
_TAG_ALIASES: dict[str, str] = {"cmn": "zh"}

# Scripts that identify a language on their own, whatever voice the user picked.
_KANA_RE = re.compile(r"[぀-ヿㇰ-ㇿｦ-ﾟ]")
_HAN_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")
_LATIN_RE = re.compile(r"[A-Za-zÀ-ɏ]")

# Kokoro's pipeline only splits non-English text on ".!?" and truncates past 510 phonemes,
# so also split on CJK and Devanagari sentence marks.
_KOKORO_SPLIT_PATTERN = r"\n+|(?<=[。！？｡।])"


def _language_from_tag(tag: str | None) -> str | None:
    """Map a BCP-47 tag (e.g. 'ja', 'pt-BR', 'en-GB') to a canonical language code, or None."""
    if not tag:
        return None
    parts = tag.strip().lower().replace("_", "-").split("-")
    if parts[0] == "en":
        return "en-GB" if len(parts) > 1 and parts[1] in ("gb", "uk") else "en-US"
    code = _TAG_ALIASES.get(parts[0], parts[0])
    return code if code in LANGUAGE_LABELS else None


def _detect_script_language(text: str) -> str | None:
    """Language implied by the text's script (kana, Han, Devanagari), or None.

    Only scripts that outnumber Latin letters count, so an English sentence quoting a
    Chinese name stays English. Latin-script languages can't be told apart this way.
    """
    latin = len(_LATIN_RE.findall(text))
    kana = len(_KANA_RE.findall(text))
    han = len(_HAN_RE.findall(text))
    devanagari = len(_DEVANAGARI_RE.findall(text))
    if kana and kana + han > latin:
        return "ja"
    if han > latin and han >= devanagari:
        return "zh"
    if devanagari > latin:
        return "hi"
    return None


def _resolve_language(text: str, hint: str | None) -> str | None:
    """The language of ``text``: its script first, then the BCP-47 hint; None if unknown.

    The script wins because a voice of another language can't read it at all (kana through
    the English G2P is gibberish). Han-only text is ambiguous between Chinese and Japanese
    (e.g. a kanji heading), so a Japanese hint keeps it Japanese.
    """
    hinted = _language_from_tag(hint)
    script = _detect_script_language(text)
    if script == "zh" and hinted == "ja":
        return "ja"
    return script or hinted


def _same_language(a: str | None, b: str | None) -> bool:
    """Whether two language codes are interchangeable (US and UK English are)."""
    return a == b or {a, b} <= _ENGLISH


# ---------------------------------------------------------------------------
# Static model / voice registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Voice:
    id: str
    name: str
    language: str  # Canonical code of the voice's language; Kokoro voices speak only that.
    gender: str | None


@dataclass(frozen=True)
class ModelSpec:
    name: str
    description: str
    languages: tuple[str, ...]
    voices: tuple[Voice, ...]
    # Kokoro fine-tunes published only as PyTorch checkpoints: weights file and
    # {voice id: voicepack file} in the HF repo, converted to MLX on first load.
    pth_weights: str | None = None
    pth_voices: dict[str, str] = field(default_factory=dict)


# Kokoro voice IDs encode the language in the first character and the gender in the
# second (f = female, m = male), e.g. "af_heart" → American-English female.
_KOKORO_PREFIX_LANGUAGE: dict[str, str] = {
    "a": "en-US",
    "b": "en-GB",
    "d": "de",  # Not upstream Kokoro: the kikiri-tts German fine-tunes.
    "e": "es",
    "f": "fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt",
    "z": "zh",
}
# Canonical language → Kokoro lang_code (passed to the model at generation time).
_KOKORO_LANG_CODE: dict[str, str] = {lang: p for p, lang in _KOKORO_PREFIX_LANGUAGE.items()}

_GENDER_LABEL: dict[str, str] = {"f": "Female", "m": "Male"}


def _kokoro_voices(*voices: tuple[str, str]) -> tuple[Voice, ...]:
    return tuple(
        Voice(vid, name, _KOKORO_PREFIX_LANGUAGE[vid[0]], _GENDER_LABEL.get(vid[1]))
        for vid, name in voices
    )


# The Kokoro preset voices, shared across every Kokoro variant.
_KOKORO_VOICES = _kokoro_voices(
    # American English
    ("af_heart", "Heart"),
    ("af_bella", "Bella"),
    ("af_nova", "Nova"),
    ("af_sky", "Sky"),
    ("af_aurora", "Aurora"),
    ("af_jessica", "Jessica"),
    ("af_kore", "Kore"),
    ("af_nicole", "Nicole"),
    ("af_sarah", "Sarah"),
    ("af_valley", "Valley"),
    ("am_adam", "Adam"),
    ("am_echo", "Echo"),
    ("am_eric", "Eric"),
    ("am_fenrir", "Fenrir"),
    ("am_liam", "Liam"),
    ("am_michael", "Michael"),
    ("am_onyx", "Onyx"),
    ("am_puck", "Puck"),
    # British English
    ("bf_alice", "Alice"),
    ("bf_emma", "Emma"),
    ("bf_isabella", "Isabella"),
    ("bf_lily", "Lily"),
    ("bm_daniel", "Daniel"),
    ("bm_fable", "Fable"),
    ("bm_george", "George"),
    ("bm_lewis", "Lewis"),
    # Japanese
    ("jf_alpha", "Alpha"),
    ("jf_gongitsune", "Gongitsune"),
    ("jf_nezumi", "Nezumi"),
    ("jf_tebukuro", "Tebukuro"),
    ("jm_kumo", "Kumo"),
    # Mandarin Chinese
    ("zf_xiaobei", "Xiaobei"),
    ("zf_xiaoni", "Xiaoni"),
    ("zf_xiaoxiao", "Xiaoxiao"),
    ("zf_xiaoyi", "Xiaoyi"),
    ("zm_yunxi", "Yunxi"),
    ("zm_yunye", "Yunye"),
    ("zm_yunfeng", "Yunfeng"),
    ("zm_yunjian", "Yunjian"),
    # Spanish
    ("ef_dora", "Dora"),
    ("em_alex", "Alex"),
    # French
    ("ff_siwis", "Siwis"),
    # Hindi
    ("hf_alpha", "Alpha"),
    ("hf_beta", "Beta"),
    ("hm_omega", "Omega"),
    ("hm_psi", "Psi"),
    # Italian
    ("if_sara", "Sara"),
    ("im_nicola", "Nicola"),
    # Brazilian Portuguese
    ("pf_dora", "Dora"),
    ("pm_alex", "Alex"),
)
_KOKORO_LANGUAGES = ("en-US", "en-GB", "ja", "zh", "es", "fr", "hi", "it", "pt")

# Order matters: when the requested model can't speak a language, the first model here that
# can is used.
MODELS: dict[str, ModelSpec] = {
    "mlx-community/Kokoro-82M-bf16": ModelSpec(
        name="Kokoro 82M",
        description="Fast multilingual TTS with 50 preset voices — best quality",
        languages=_KOKORO_LANGUAGES,
        voices=_KOKORO_VOICES,
    ),
    "mlx-community/Kokoro-82M-8bit": ModelSpec(
        name="Kokoro 82M (8-bit)",
        description="Same 50 voices, 8-bit quantized — faster and smaller",
        languages=_KOKORO_LANGUAGES,
        voices=_KOKORO_VOICES,
    ),
    "mlx-community/Kokoro-82M-4bit": ModelSpec(
        name="Kokoro 82M (4-bit)",
        description="Same 50 voices, 4-bit quantized — lightest and fastest",
        languages=_KOKORO_LANGUAGES,
        voices=_KOKORO_VOICES,
    ),
    "kikiri-tts/kikiri-german-victoria": ModelSpec(
        name="Kokoro 82M German (Victoria)",
        description="Community German fine-tune of Kokoro (kikiri-tts), female voice",
        languages=("de",),
        voices=_kokoro_voices(("df_victoria", "Victoria")),
        pth_weights="kikiri_german_victoria_ep10.pth",
        pth_voices={"df_victoria": "voices/victoria.pt"},
    ),
    "kikiri-tts/kikiri-german-martin": ModelSpec(
        name="Kokoro 82M German (Martin)",
        description="Community German fine-tune of Kokoro (kikiri-tts), male voice",
        languages=("de",),
        voices=_kokoro_voices(("dm_martin", "Martin")),
        pth_weights="kikiri_german_martin_ep10.pth",
        pth_voices={"dm_martin": "voices/martin.pt"},
    ),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _speaks(spec: ModelSpec, language: str) -> bool:
    return any(_same_language(language, lang) for lang in spec.languages)


def _pick_model(requested: str, language: str | None) -> str:
    """``requested`` if it speaks ``language``; else the first model that does. Falls back
    to ``requested`` when no model speaks it."""
    if language is None or _speaks(MODELS[requested], language):
        return requested
    return next((mid for mid, spec in MODELS.items() if _speaks(spec, language)), requested)


def _pick_voice(spec: ModelSpec, voice: str, language: str | None, default: str) -> str:
    """Keep ``voice`` if it's in ``spec`` and can speak ``language``; otherwise pick one.

    Prefers the server default voice, then the first voice native to ``language``, then the
    model's first voice.
    """
    by_id = {v.id: v for v in spec.voices}

    def fits(vid: str) -> bool:
        v = by_id.get(vid)
        return v is not None and (language is None or _same_language(v.language, language))

    if fits(voice):
        return voice
    if default in by_id and (language is None or _same_language(by_id[default].language, language)):
        return default
    native = [v.id for v in spec.voices if language and _same_language(v.language, language)]
    return native[0] if native else spec.voices[0].id


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


def _convert_kokoro_pth(repo_id: str, spec: ModelSpec, cache_dir: Path) -> Path:
    """Convert a PyTorch Kokoro checkpoint from the HF hub into an mlx-audio model directory.

    The checkpoint is ``{component: state_dict}`` like upstream ``kokoro-v1_0.pth``, but with
    DataParallel ``module.`` prefixes and PyTorch's newer weight-norm parametrization names.
    Kokoro's ``sanitize()`` handles the remaining PyTorch → MLX layout differences at load.
    ``config.json`` is written last, so its presence marks a finished conversion.
    """
    out = cache_dir / "models" / repo_id.replace("/", "--")
    if (out / "config.json").exists():
        return out

    import mlx.core as mx
    import torch
    from huggingface_hub import hf_hub_download

    logger.info("Converting %s to MLX in %s …", repo_id, out)
    (out / "voices").mkdir(parents=True, exist_ok=True)
    checkpoint = torch.load(
        hf_hub_download(repo_id, spec.pth_weights), map_location="cpu", weights_only=True
    )
    weights: dict[str, Any] = {}
    for component, state_dict in checkpoint.items():
        for key, tensor in state_dict.items():
            key = f"{component}.{key.removeprefix('module.')}"
            key = key.replace(".parametrizations.weight.original0", ".weight_g")
            key = key.replace(".parametrizations.weight.original1", ".weight_v")
            weights[key] = mx.array(tensor.float().numpy())
    mx.save_safetensors(str(out / "model.safetensors"), weights)

    for voice_id, filename in spec.pth_voices.items():
        pack = torch.load(hf_hub_download(repo_id, filename), map_location="cpu", weights_only=True)
        mx.save_safetensors(
            str(out / "voices" / f"{voice_id}.safetensors"),
            {"voice": mx.array(pack.float().numpy())},
        )

    # The fine-tunes reuse upstream Kokoro's architecture and phoneme vocabulary.
    with open(hf_hub_download("hexgrad/Kokoro-82M", "config.json")) as f:
        config = json.load(f)
    config["model_type"] = "kokoro"
    with open(out / "config.json", "w") as f:
        json.dump(config, f)
    return out


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
        spec = MODELS.get(self._settings.mlx_model)
        return spec.name if spec else "mlx-audio"

    # ------------------------------------------------------------------
    # Catalogue
    # ------------------------------------------------------------------

    def list_models(self) -> list[dict[str, Any]]:
        default_id = self._settings.mlx_model
        return [
            {
                "id": mid,
                "name": spec.name,
                "description": spec.description,
                "languages": list(spec.languages),
                "default": mid == default_id,
            }
            for mid, spec in MODELS.items()
        ]

    def list_voices(self, model_id: str | None = None) -> list[dict[str, Any]]:
        spec = MODELS.get(model_id or self._settings.mlx_model)
        if spec is None:
            return []
        default_voice = self._settings.mlx_default_voice
        return [
            {
                "id": v.id,
                "name": v.name,
                "language": LANGUAGE_LABELS[v.language],
                "gender": v.gender,
                "default": v.id == default_voice,
            }
            for v in spec.voices
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

        The language comes from the text's script, then ``language``, then the voice. If the
        model can't speak it, the first model that can is used; if the voice can't, a voice
        that can. The model and voice actually used are reported in the result.
        """
        mid = model_id or self._settings.mlx_model
        # ValueError is mapped to HTTP 400 by the route.
        if mid not in MODELS:
            raise ValueError(f"Invalid model: '{mid}'. Valid models: {', '.join(MODELS)}")
        valid_voices = [entry.id for entry in MODELS[mid].voices]
        if not voice:
            # The configured default may not belong to the model (e.g. a German fine-tune).
            default_voice = self._settings.mlx_default_voice
            v = default_voice if default_voice in valid_voices else valid_voices[0]
        elif voice in valid_voices:
            v = voice
        else:
            raise ValueError(f"Invalid voice: '{voice}'. Valid voices: {', '.join(valid_voices)}")

        lang = _resolve_language(text, language)
        mid = _pick_model(mid, lang)
        spec = MODELS[mid]
        default = self._settings.mlx_default_voice
        v = _pick_voice(spec, v, lang, default)
        if lang is None or not _speaks(spec, lang):
            # Unknown (or unspeakable) language: read it as the voice's own language.
            lang = next(entry.language for entry in spec.voices if entry.id == v)

        loop = asyncio.get_event_loop()
        wav_bytes, duration = await loop.run_in_executor(
            self._executor, self._generate_sync, text, v, mid, lang
        )
        return AudioResult(
            audio_data=wav_bytes,
            duration=duration,
            voice=v,
            language=LANGUAGE_LABELS[lang],
            model=mid,
        )

    # ------------------------------------------------------------------
    # Synchronous internals (run inside ThreadPoolExecutor)
    # ------------------------------------------------------------------

    def _load_model(self, model_id: str) -> Any:
        if model_id not in self._loaded:
            logger.info("Loading MLX model %s …", model_id)
            spec = MODELS[model_id]
            source: str | Path = model_id
            if spec.pth_weights:
                source = _convert_kokoro_pth(model_id, spec, self._settings.cache_dir)
            self._loaded[model_id] = _mlx_load_model(source)
        return self._loaded[model_id]

    def _generate_sync(
        self,
        text: str,
        voice: str,
        model_id: str,
        language: str,
    ) -> tuple[bytes, float]:
        model = self._load_model(model_id)
        spec = MODELS[model_id]
        sample_rate = int(getattr(model, "sample_rate", 24000))

        chunks: list[np.ndarray] = []
        try:
            for result in self._run_kokoro(model, spec, model_id, text, voice, language):
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

    def _run_kokoro(
        self,
        model: Any,
        spec: ModelSpec,
        model_id: str,
        text: str,
        voice: str,
        language: str,
    ) -> Any:
        """Yield mlx-audio Kokoro results (each with ``.audio``)."""
        voice_arg = voice
        if spec.pth_weights:
            # Converted voicepacks live next to the model, not in an HF repo.
            cache = self._settings.cache_dir / "models" / model_id.replace("/", "--")
            voice_arg = str(cache / "voices" / f"{voice}.safetensors")
        kwargs: dict[str, Any] = {"voice": voice_arg, "lang_code": _KOKORO_LANG_CODE[language]}
        if language not in _ENGLISH:
            kwargs["split_pattern"] = _KOKORO_SPLIT_PATTERN
        yield from model.generate(text, **kwargs)
