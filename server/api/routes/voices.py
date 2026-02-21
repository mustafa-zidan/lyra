# SPDX-License-Identifier: AGPL-3.0-only
"""Voices listing endpoint."""

from eurydice import Eurydice
from fastapi import APIRouter, Request

from server.api.models import VoiceInfo, VoicesResponse
from server.core.config import Settings

router = APIRouter()


@router.get(
    "/voices",
    response_model=VoicesResponse,
    summary="List voices",
    description="Returns all TTS voices supported by the eurydice-tts library.",
    tags=["TTS"],
)
async def list_voices(request: Request) -> VoicesResponse:
    settings: Settings = request.app.state.settings
    default_voice = settings.default_voice

    voices = [
        VoiceInfo(
            id=v.value,
            name=v.value.capitalize(),
            default=(v.value == default_voice),
        )
        for v in Eurydice.available_voices()
    ]
    return VoicesResponse(voices=voices)