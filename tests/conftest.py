"""Pytest fixtures shared across the test suite."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from eurydice.types import AudioFormat, AudioResult, Voice
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from server.core.config import Settings
from server.main import create_app


def _make_fake_audio(voice: Voice = Voice.LEO) -> AudioResult:
    # Minimal valid WAV: 44-byte header + 2 bytes silence
    wav_header = (
        b"RIFF"
        + (36).to_bytes(4, "little")
        + b"WAVE"
        + b"fmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")  # PCM
        + (1).to_bytes(2, "little")  # channels
        + (24000).to_bytes(4, "little")  # sample rate
        + (48000).to_bytes(4, "little")  # byte rate
        + (2).to_bytes(2, "little")  # block align
        + (16).to_bytes(2, "little")  # bits per sample
        + b"data"
        + (2).to_bytes(4, "little")
        + b"\x00\x00"
    )
    return AudioResult(
        audio_data=wav_header,
        duration=0.001,
        format=AudioFormat.WAV,
        sample_rate=24000,
        voice=voice,
        cached=False,
    )


@pytest.fixture()
def settings_override() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8000,
        tts_provider="lmstudio",
        default_voice="leo",
        cors_origins="*",
    )


@pytest.fixture()
def mock_tts_service(settings_override: Settings) -> MagicMock:
    svc = MagicMock()
    svc.is_available = True
    svc.provider_name = "lmstudio"
    svc.generate = AsyncMock(return_value=_make_fake_audio())
    svc.startup = AsyncMock()
    svc.shutdown = AsyncMock()
    return svc


@pytest.fixture()
def app(settings_override: Settings, mock_tts_service: MagicMock):
    """FastAPI app with mocked TTS service."""
    application = create_app(cfg=settings_override)

    # Override lifespan: inject mock service directly
    application.state.tts = mock_tts_service
    application.state.settings = settings_override
    return application


@pytest.fixture()
def client(app) -> TestClient:
    """Synchronous test client (lifespan disabled via direct state injection)."""
    # We bypass lifespan by injecting state before TestClient starts
    with (
        patch("server.main.TTSService", return_value=app.state.tts),
        TestClient(app, raise_server_exceptions=True) as c,
    ):
        yield c


@pytest.fixture()
async def async_client(app) -> AsyncClient:
    """Async test client."""
    with patch("server.main.TTSService", return_value=app.state.tts):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
