"""TTS service — manages the Eurydice client lifecycle."""

import logging

from eurydice import Eurydice
from eurydice.cache import MemoryCache
from eurydice.config import TTSConfig
from eurydice.exceptions import EurydiceError
from eurydice.types import AudioFormat, AudioResult, Voice

from server.core.config import Settings

logger = logging.getLogger(__name__)


class TTSService:
    """Singleton wrapper around :class:`~eurydice.Eurydice`.

    Manages startup/shutdown via FastAPI's lifespan context and exposes a
    simple :meth:`generate` coroutine for the route handlers.
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
                    "TTS provider not available — server will return 503 for /tts/generate"
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

    async def generate(
        self,
        text: str,
        voice: str | None = None,
        format: AudioFormat = AudioFormat.WAV,
    ) -> AudioResult:
        """Generate audio from *text*.

        Parameters
        ----------
        text:
            Input text to synthesise.
        voice:
            Voice ID string (e.g. ``"tara"``).  Falls back to the configured
            default when ``None``.
        format:
            Output audio format.  Currently only WAV is supported.

        Raises
        ------
        EurydiceError
            Propagated from the underlying provider on failure.
        """
        voice_obj: Voice | None = Voice.from_string(voice) if voice else None
        return await self._client.generate(text, voice=voice_obj, format=format)
