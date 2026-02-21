# SPDX-License-Identifier: AGPL-3.0-only
"""Application configuration loaded from environment variables."""

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Server configuration.

    All fields can be overridden via environment variables with the
    ``EURYDICE_`` prefix (e.g. ``EURYDICE_PORT=9000``).
    """

    model_config = SettingsConfigDict(env_prefix="EURYDICE_", env_file=".env", extra="ignore")

    # HTTP server
    host: str = "127.0.0.1"
    port: int = 8000

    # TTS backend
    tts_provider: str = "auto"
    tts_server_url: str = "http://localhost:1234/v1"
    default_voice: str = "leo"

    # CORS: comma-separated list of allowed origins, or "*" for all
    cors_origins: str = "*"

    # Logging
    log_level: str = "info"

    @field_validator("cors_origins")
    @classmethod
    def split_cors_origins(cls, v: str) -> str:  # noqa: N805
        return v  # kept as string; parsed at usage site

    def cors_origins_list(self) -> list[str]:
        """Return CORS origins as a list."""
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()