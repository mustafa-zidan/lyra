# SPDX-License-Identifier: AGPL-3.0-only
"""TTS generation endpoint."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from server.api.models import TTSRequest

logger = logging.getLogger(__name__)

router = APIRouter()

_VALID_FORMATS = {"wav"}


@router.post(
    "/tts/generate",
    summary="Generate speech",
    description=(
        "Converts the supplied text to speech and returns a WAV audio file. "
        "Custom response headers carry metadata: ``X-Audio-Duration``, ``X-Cached``, ``X-Voice``, "
        "``X-Model``, ``X-Language``."
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
                "X-Model": {
                    "description": (
                        "Model used for generation; differs from the requested one when that "
                        "model can't speak the text's language."
                    ),
                    "schema": {"type": "string"},
                },
                "X-Language": {
                    "description": "Language the text was read as (e.g. 'Japanese').",
                    "schema": {"type": "string"},
                },
            },
        },
        400: {"description": "Invalid format."},
        503: {"description": "TTS backend is not available."},
    },
    tags=["TTS"],
)
async def generate(body: TTSRequest, request: Request) -> Response:
    tts: Any = request.app.state.tts

    if not tts.is_available:
        raise HTTPException(
            status_code=503,
            detail="TTS service is not available. Check provider configuration.",
        )

    if body.format not in _VALID_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid format: '{body.format}'. Valid formats: {', '.join(_VALID_FORMATS)}",
        )

    try:
        audio = await tts.generate(
            text=body.text,
            voice=body.voice,
            model_id=body.model,
            language=body.language,
        )
    except ValueError as exc:
        # Bad request data (e.g. an unknown voice) — client error, not server error.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("TTS generation failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"TTS generation failed: {exc}") from exc

    return Response(
        content=audio.audio_data,
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(round(audio.duration, 3)),
            "X-Cached": str(audio.cached).lower(),
            "X-Voice": audio.voice,
            "X-Model": audio.model,
            "X-Language": audio.language,
            "Cache-Control": "no-store",
        },
    )
