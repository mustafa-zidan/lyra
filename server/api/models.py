# SPDX-License-Identifier: AGPL-3.0-only
"""Pydantic request and response models for the API."""

from pydantic import BaseModel, Field


class TTSRequest(BaseModel):
    """Request body for ``POST /tts/generate``."""

    text: str = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Text to convert to speech.",
        examples=["Hello, world!"],
    )
    voice: str | None = Field(
        default=None,
        description=(
            "Voice ID to use.  One of: tara, leah, jess, leo, dan, mia, zac, zoe. "
            "Defaults to the server's configured default voice."
        ),
        examples=["leo"],
    )
    format: str = Field(
        default="wav",
        description="Audio format.  Currently only 'wav' is supported.",
        examples=["wav"],
    )


class VoiceInfo(BaseModel):
    """Metadata for a single TTS voice."""

    id: str = Field(..., description="Voice identifier used in API requests.")
    name: str = Field(..., description="Human-readable voice name.")
    default: bool = Field(default=False, description="Whether this is the server default voice.")


class VoicesResponse(BaseModel):
    """Response body for ``GET /voices``."""

    voices: list[VoiceInfo]


class HealthResponse(BaseModel):
    """Response body for ``GET /health``."""

    status: str = Field(..., description="'ok' or 'degraded'.")
    tts_available: bool = Field(..., description="Whether the TTS backend is reachable.")
    provider: str | None = Field(default=None, description="Active provider name.")


class RootResponse(BaseModel):
    """Response body for ``GET /``."""

    name: str
    version: str
    description: str
    docs: str


class ErrorResponse(BaseModel):
    """Standard error response."""

    detail: str