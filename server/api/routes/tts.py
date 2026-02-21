# SPDX-License-Identifier: AGPL-3.0-only
"""TTS generation endpoint."""

import logging

from eurydice.exceptions import EurydiceError
from eurydice.types import AudioFormat, Voice
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from server.api.models import TTSRequest
from server.core.tts_service import TTSService

logger = logging.getLogger(__name__)

router = APIRouter()

_VALID_VOICES = {v.value for v in Voice}
_VALID_FORMATS = {"wav"}


@router.post(
    "/tts/generate",
    summary="Generate speech",
    description=(
        "Converts the supplied text to speech and returns a WAV audio file. "
        "Custom response headers carry metadata: ``X-Audio-Duration``, ``X-Cached``, ``X-Voice``."
    ),
    response_class=Response,
    responses={
        200: {
            "content": {"audio/wav": {}},
            "description": "WAV audio binary.",
            "headers": {
                "X-Audio-Duration": {
                    "description": "Duration of the generated audio in seconds.",
                    "schema": {"type": "number"},
                },
                "X-Cached": {
                    "description": "Whether the result was served from cache.",
                    "schema": {"type": "boolean"},
                },
                "X-Voice": {
                    "description": "Voice used for generation.",
                    "schema": {"type": "string"},
                },
            },
        },
        400: {"description": "Invalid voice or format."},
        503: {"description": "TTS backend is not available."},
    },
    tags=["TTS"],
)
async def generate(body: TTSRequest, request: Request) -> Response:
    tts: TTSService = request.app.state.tts

    if not tts.is_available:
        raise HTTPException(
            status_code=503,
            detail="TTS service is not available. Check provider configuration.",
        )

    # Validate voice
    if body.voice is not None and body.voice not in _VALID_VOICES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid voice: '{body.voice}'. Valid voices: {', '.join(sorted(_VALID_VOICES))}",
        )

    # Validate format
    if body.format not in _VALID_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid format: '{body.format}'. Valid formats: {', '.join(_VALID_FORMATS)}",
        )

    try:
        audio = await tts.generate(
            text=body.text,
            voice=body.voice,
            format=AudioFormat.WAV,
        )
    except EurydiceError as exc:
        logger.error("TTS generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {exc}") from exc

    return Response(
        content=audio.audio_data,
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(round(audio.duration, 3)),
            "X-Cached": str(audio.cached).lower(),
            "X-Voice": audio.voice.value,
            "Cache-Control": "no-store",
        },
    )