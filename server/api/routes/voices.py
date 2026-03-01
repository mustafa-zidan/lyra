# SPDX-License-Identifier: AGPL-3.0-only
"""Voices listing endpoint."""

from typing import Any

from fastapi import APIRouter, Query, Request

from server.api.models import VoiceInfo, VoicesResponse

router = APIRouter()


@router.get(
    "/voices",
    response_model=VoicesResponse,
    summary="List voices",
    description="Returns TTS voices for the given model (or the server default model).",
    tags=["TTS"],
)
async def list_voices(
    request: Request,
    model: str | None = Query(default=None, description="Model ID to list voices for."),
) -> VoicesResponse:
    tts: Any = request.app.state.tts
    voices = [VoiceInfo(**v) for v in tts.list_voices(model)]
    return VoicesResponse(model=model, voices=voices)
