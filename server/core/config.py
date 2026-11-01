# SPDX-License-Identifier: AGPL-3.0-only
"""Application configuration loaded from environment variables."""

import os
from pathlib import Path

from pydantic_settings import (
    BaseSettings,
    DotEnvSettingsSource,
    EnvSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

ENV_PREFIX = "LYRA_"
#: The server's old name. Still read, below ``LYRA_``, so existing setups keep working.
LEGACY_ENV_PREFIX = "EURYDICE_"

#: Browser extension origins (Chrome/Edge, Firefox, Safari). Firefox and Safari use a
#: random per-install UUID, so the extension can't be named by a fixed origin.
EXTENSION_ORIGIN_REGEX = r"^(chrome-extension|moz-extension|safari-web-extension)://[A-Za-z0-9\-]+$"


class Settings(BaseSettings):
    """Server configuration.

    All fields can be overridden via environment variables with the ``LYRA_`` prefix
    (e.g. ``LYRA_PORT=9000``), or in a ``.env`` file. The old ``EURYDICE_`` prefix is
    still accepted; ``LYRA_`` wins when both are set.
    """

    model_config = SettingsConfigDict(env_prefix=ENV_PREFIX, env_file=".env", extra="ignore")

    # HTTP server
    host: str = "127.0.0.1"
    port: int = 8000

    # mlx-audio (Kokoro) TTS settings
    mlx_model: str = "mlx-community/Kokoro-82M-bf16"
    mlx_default_voice: str = "af_heart"

    # Where models converted at runtime (the PyTorch-only German Kokoro fine-tunes) are kept
    cache_dir: Path = Path.home() / ".cache" / "lyra"

    # CORS. Browser extensions are always allowed (cors_origin_regex). Web pages are not,
    # so a site you visit can't use the server; add origins here (comma-separated, or "*"
    # for every site) only if a web page really needs it.
    cors_origins: str = ""
    cors_origin_regex: str = EXTENSION_ORIGIN_REGEX

    # Logging
    log_level: str = "info"

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        env_file = settings_cls.model_config.get("env_file")
        return (
            init_settings,
            env_settings,
            EnvSettingsSource(settings_cls, env_prefix=LEGACY_ENV_PREFIX),
            dotenv_settings,
            DotEnvSettingsSource(settings_cls, env_file=env_file, env_prefix=LEGACY_ENV_PREFIX),
            file_secret_settings,
        )

    def cors_origins_list(self) -> list[str]:
        """Return CORS origins as a list."""
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


def legacy_env_vars() -> list[str]:
    """Names of ``EURYDICE_*`` variables set in the environment, to warn about."""
    return sorted(k for k in os.environ if k.upper().startswith(LEGACY_ENV_PREFIX))


settings = Settings()
