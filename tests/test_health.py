# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for GET /health."""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient


def test_health_ok(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["tts_available"] is True
    assert data["provider"] == "lmstudio"


def test_health_degraded(app, mock_tts_service: MagicMock) -> None:
    mock_tts_service.is_available = False
    mock_tts_service.provider_name = None
    app.state.tts = mock_tts_service

    with TestClient(app, raise_server_exceptions=True) as c:
        response = c.get("/health")

    assert response.status_code == 503
    data = response.json()
    assert data["status"] == "degraded"
    assert data["tts_available"] is False
    assert data["provider"] is None
