# SPDX-License-Identifier: AGPL-3.0-only
"""Models listing endpoint."""

from typing import Any

from fastapi import APIRouter, Request

from server.api.models import ModelInfo, ModelsResponse

router = APIRouter()


@router.get(
    "/models",
    response_model=ModelsResponse,
    summary="List models",
    description="Returns all TTS models supported by the active backend.",
    tags=["TTS"],
)
async def list_models(request: Request) -> ModelsResponse:
    tts: Any = request.app.state.tts
    models = [ModelInfo(**m) for m in tts.list_models()]
    return ModelsResponse(models=models)
