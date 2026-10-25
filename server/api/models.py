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
            "Voice ID to use. Defaults to the server's configured default voice, or the "
            "model's first voice if the default doesn't belong to the model."
        ),
        examples=["af_heart"],
    )
    model: str | None = Field(
        default=None,
        description=(
            "Model ID (HuggingFace repo). Defaults to the server's configured default model."
        ),
        examples=["mlx-community/Kokoro-82M-bf16"],
    )
    language: str | None = Field(
        default=None,
        max_length=35,
        description=(
            "Optional BCP-47 language hint, e.g. the page's lang attribute. Non-Latin scripts "
            "(Japanese, Chinese, Hindi) are detected automatically; the hint covers Latin-script "
            "languages. If the model or voice can't speak the resolved language, one that can "
            "is used instead (reported in X-Model / X-Voice)."
        ),
        examples=["ja", "pt-BR"],
    )
    format: str = Field(
        default="wav",
        description="Audio format. Currently only 'wav' is supported.",
        examples=["wav"],
    )


class VoiceInfo(BaseModel):
    """Metadata for a single TTS voice."""

    id: str = Field(..., description="Voice identifier used in API requests.")
    name: str = Field(..., description="Human-readable voice name.")
    language: str | None = Field(
        default=None, description="Human-readable language/accent (e.g. 'English (US)')."
    )
    gender: str | None = Field(default=None, description="Voice gender ('Female' or 'Male').")
    default: bool = Field(default=False, description="Whether this is the server default voice.")


class VoicesResponse(BaseModel):
    """Response body for ``GET /voices``."""

    model: str | None = Field(default=None, description="Model ID these voices belong to.")
    voices: list[VoiceInfo]


class ModelInfo(BaseModel):
    """Metadata for a single TTS model."""

    id: str = Field(..., description="Model ID (HuggingFace repo or backend name).")
    name: str = Field(..., description="Human-readable model name.")
    description: str = Field(default="", description="Short description.")
    languages: list[str] = Field(default_factory=list, description="Supported language codes.")
    default: bool = Field(default=False, description="Whether this is the server default model.")


class ModelsResponse(BaseModel):
    """Response body for ``GET /models``."""

    models: list[ModelInfo]


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
