# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for settings (env prefixes) and the CORS policy built from them."""

import pytest
from fastapi.testclient import TestClient

from server.core.config import Settings
from server.main import create_app

EXTENSION_ORIGINS = [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "moz-extension://0f8e3c2a-1b2c-4d5e-8f90-123456789abc",
    "safari-web-extension://0F8E3C2A-1B2C-4D5E-8F90-123456789ABC",
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # Keep a developer's real LYRA_/EURYDICE_ variables and .env out of these tests.
    import os

    for key in list(os.environ):
        if key.upper().startswith(("LYRA_", "EURYDICE_")):
            monkeypatch.delenv(key)
    monkeypatch.chdir(tmp_path)


def _preflight(client: TestClient, origin: str):
    return client.options(
        "/tts/generate",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )


# ---------------------------------------------------------------------------
# Env prefixes
# ---------------------------------------------------------------------------


def test_lyra_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LYRA_PORT", "9001")
    assert Settings().port == 9001


def test_legacy_eurydice_prefix_still_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EURYDICE_PORT", "9002")
    assert Settings().port == 9002


def test_lyra_prefix_wins_over_legacy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EURYDICE_PORT", "9002")
    monkeypatch.setenv("LYRA_PORT", "9001")
    assert Settings().port == 9001


def test_legacy_prefix_in_dotenv(tmp_path) -> None:
    (tmp_path / ".env").write_text("EURYDICE_PORT=9003\n")
    assert Settings().port == 9003


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("origin", EXTENSION_ORIGINS)
def test_cors_allows_extensions_by_default(origin: str) -> None:
    client = TestClient(create_app(Settings()))
    response = _preflight(client, origin)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_cors_blocks_web_pages_by_default() -> None:
    client = TestClient(create_app(Settings()))
    response = _preflight(client, "https://evil.example")
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers

    simple = client.get("/", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in simple.headers


def test_cors_extension_regex_is_anchored() -> None:
    client = TestClient(create_app(Settings()))
    response = _preflight(client, "chrome-extension://abc.evil.example")
    assert "access-control-allow-origin" not in response.headers


def test_cors_extra_origins_are_added() -> None:
    client = TestClient(create_app(Settings(cors_origins="http://localhost:3000")))
    assert _preflight(client, "http://localhost:3000").status_code == 200
    assert _preflight(client, EXTENSION_ORIGINS[0]).status_code == 200
    assert _preflight(client, "https://evil.example").status_code == 400


def test_cors_wildcard_opt_in() -> None:
    client = TestClient(create_app(Settings(cors_origins="*")))
    response = _preflight(client, "https://any.example")
    assert response.status_code == 200
