# SPDX-License-Identifier: AGPL-3.0-only
"""FastAPI application factory."""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.api.models import RootResponse
from server.api.routes import health, models, tts, voices
from server.core.config import Settings, settings

logging.basicConfig(level=settings.log_level.upper())
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage startup and shutdown of the TTS service."""
    cfg: Settings = app.state.settings

    if cfg.tts_backend == "mlx_audio":
        from server.core.mlx_tts_service import MLXTTSService

        tts_service = MLXTTSService(cfg)
    else:
        from server.core.tts_service import TTSService

        tts_service = TTSService(cfg)  # type: ignore[assignment]

    app.state.tts = tts_service
    await tts_service.startup()
    logger.info("Lyra server started (backend: %s)", cfg.tts_backend)
    yield
    await tts_service.shutdown()
    logger.info("Lyra server shut down")


def create_app(cfg: Settings | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    cfg = cfg or settings

    app = FastAPI(
        title="Lyra",
        version="0.1.0",
        description=(
            "HTTP API server exposing TTS via mlx-audio or eurydice-tts. "
            "Designed for use with the Lyra browser extension."
        ),
        license_info={"name": "AGPL-3.0-only"},
        lifespan=lifespan,
    )

    app.state.settings = cfg

    cors_origins = cfg.cors_origins_list()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Accept"],
        expose_headers=["X-Audio-Duration", "X-Cached", "X-Voice", "X-Model"],
    )

    app.include_router(health.router)
    app.include_router(voices.router)
    app.include_router(models.router)
    app.include_router(tts.router)

    @app.get("/", response_model=RootResponse, tags=["Status"], summary="API info")
    async def root() -> RootResponse:
        return RootResponse(
            name="Lyra",
            version="0.1.0",
            description="TTS API powered by mlx-audio / eurydice-tts",
            docs="/docs",
        )

    return app


app = create_app()


def run() -> None:
    """Entry point for ``lyra`` CLI script."""
    uvicorn.run(
        "server.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        reload=False,
    )


if __name__ == "__main__":
    run()
