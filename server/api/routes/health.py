# SPDX-License-Identifier: AGPL-3.0-only
"""Health check endpoint."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from server.api.models import HealthResponse
from server.core.tts_service import TTSService

router = APIRouter()


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Health check",
    description="Returns the server status and whether the TTS backend is available.",
    tags=["Status"],
)
async def health(request: Request) -> JSONResponse:
    tts: TTSService = request.app.state.tts
    available = tts.is_available
    payload = HealthResponse(
        status="ok" if available else "degraded",
        tts_available=available,
        provider=tts.provider_name,
    )
    status_code = 200 if available else 503
    return JSONResponse(content=payload.model_dump(), status_code=status_code)