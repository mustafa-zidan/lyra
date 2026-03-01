# SPDX-License-Identifier: AGPL-3.0-only
"""TTS service: manages the Eurydice client lifecycle."""

import logging
from typing import Any

from eurydice import Eurydice
from eurydice.cache import MemoryCache
from eurydice.config import TTSConfig
from eurydice.exceptions import EurydiceError
from eurydice.types import AudioFormat, Voice

from server.core.config import Settings
from server.core.mlx_tts_service import AudioResult

logger = logging.getLogger(__name__)

_EURYDICE_MODEL_ID = "eurydice"


class TTSService:
    """Singleton wrapper around :class:`~eurydice.Eurydice`.

    Manages startup/shutdown via FastAPI's lifespan context and exposes the
    same duck-typed interface as :class:`~server.core.mlx_tts_service.MLXTTSService`.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        config = TTSConfig(
            provider=settings.tts_provider,
            server_url=settings.tts_server_url,
            default_voice=Voice.from_string(settings.default_voice),
            cache_enabled=True,
        )
        cache = MemoryCache(max_size=200)
        self._client = Eurydice(config=config, cache=cache)
        self._available: bool = False

    async def startup(self) -> None:
        """Connect to the TTS provider and verify availability."""
        try:
            self._available = await self._client.connect()
            if self._available:
                logger.info("TTS provider connected: %s", self._settings.tts_provider)
            else:
                logger.warning(
                    "TTS provider not available: server will return 503 for /tts/generate"
                )
        except EurydiceError as exc:
            logger.warning("TTS connection failed: %s", exc)
            self._available = False

    async def shutdown(self) -> None:
        """Close the TTS provider connection."""
        await self._client.close()

    @property
    def is_available(self) -> bool:
        return self._available

    @property
    def provider_name(self) -> str | None:
        try:
            return self._client._provider.name  # type: ignore[attr-defined]
        except AttributeError:
            return None

    def list_models(self) -> list[dict[str, Any]]:
        return [
            {
                "id": _EURYDICE_MODEL_ID,
                "name": "Eurydice TTS",
                "description": "eurydice-tts local provider",
                "languages": ["EN"],
                "default": True,
            }
        ]

    def list_voices(self, model_id: str | None = None) -> list[dict[str, Any]]:  # noqa: ARG002
        default = self._settings.default_voice
        return [
            {
                "id": v.value,
                "name": v.value.capitalize(),
                "default": v.value == default,
            }
            for v in Eurydice.available_voices()
        ]

    async def generate(
        self,
        text: str,
        voice: str | None = None,
        model_id: str | None = None,  # noqa: ARG002
    ) -> AudioResult:
        """Generate audio from *text* and return a shared :class:`AudioResult`."""
        voice_obj: Voice | None = Voice.from_string(voice) if voice else None
        result = await self._client.generate(text, voice=voice_obj, format=AudioFormat.WAV)
        return AudioResult(
            audio_data=result.audio_data,
            duration=result.duration,
            cached=result.cached,
            voice=result.voice.value,
        )
