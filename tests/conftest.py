# SPDX-License-Identifier: AGPL-3.0-only
"""Pytest fixtures shared across the test suite."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from eurydice.types import AudioFormat, AudioResult, Voice
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from server.core.config import Settings


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
        tts_backend="eurydice",  # Use eurydice backend for tests
        default_voice="leo",
        cors_origins="*",
    )


@pytest.fixture()
def mock_tts_service(settings_override: Settings) -> MagicMock:
    svc = MagicMock()
    svc.is_available = True
    svc.provider_name = "lmstudio"

    # Mock generate to validate voices
    async def mock_generate(text: str, voice: str | None = None, model_id: str | None = None):
        valid_voices = ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"]
        if voice and voice not in valid_voices:
            raise ValueError(f"Invalid voice: {voice}")
        return _make_fake_audio()

    svc.generate = AsyncMock(side_effect=mock_generate)
    svc.startup = AsyncMock()
    svc.shutdown = AsyncMock()

    # Mock list_voices to return test voices
    svc.list_voices.return_value = [
        {"id": "tara", "name": "Tara", "default": False},
        {"id": "leah", "name": "Leah", "default": False},
        {"id": "jess", "name": "Jess", "default": False},
        {"id": "leo", "name": "Leo", "default": True},  # Matches settings_override default_voice
        {"id": "dan", "name": "Dan", "default": False},
        {"id": "mia", "name": "Mia", "default": False},
        {"id": "zac", "name": "Zac", "default": False},
        {"id": "zoe", "name": "Zoe", "default": False},
    ]

    # Mock list_models to return test models
    svc.list_models.return_value = []

    return svc


@pytest.fixture()
def app(settings_override: Settings, mock_tts_service: MagicMock):
    """FastAPI app with mocked TTS service."""
    # Create app without lifespan to avoid real service initialization
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    from server.api.models import RootResponse
    from server.api.routes import health, models, tts, voices

    application = FastAPI(
        title="Lyra",
        version="0.1.0",
        description="Test app",
        lifespan=None,  # Disable lifespan for tests
    )

    # Configure middleware
    cors_origins = settings_override.cors_origins_list()
    application.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Accept"],
        expose_headers=["X-Audio-Duration", "X-Cached", "X-Voice", "X-Model"],
    )

    # Add routes
    application.include_router(health.router)
    application.include_router(voices.router)
    application.include_router(models.router)
    application.include_router(tts.router)

    @application.get("/", response_model=RootResponse)
    async def root() -> RootResponse:
        return RootResponse(
            name="Lyra",
            version="0.1.0",
            description="Test API",
            docs="/docs",
        )

    # Inject mock service and settings
    application.state.tts = mock_tts_service
    application.state.settings = settings_override
    return application


@pytest.fixture()
def client(app) -> TestClient:
    """Synchronous test client (lifespan disabled via direct state injection)."""
    # We bypass lifespan by injecting state before TestClient starts
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture()
async def async_client(app) -> AsyncClient:
    """Async test client."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac
