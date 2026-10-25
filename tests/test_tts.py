# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for POST /tts/generate."""

from unittest.mock import AsyncMock, MagicMock

from fastapi.testclient import TestClient

from server.core.mlx_tts_service import AudioResult


def test_generate_returns_wav(client: TestClient) -> None:
    response = client.post("/tts/generate", json={"text": "Hello, world!"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert "X-Audio-Duration" in response.headers
    assert "X-Voice" in response.headers
    assert "X-Cached" in response.headers
    assert response.headers["X-Voice"] == "af_heart"
    assert len(response.content) > 0


def test_generate_with_valid_voice(client: TestClient) -> None:
    response = client.post("/tts/generate", json={"text": "Hello!", "voice": "bm_george"})
    assert response.status_code == 200
    assert response.headers["X-Voice"] == "bm_george"


def test_generate_invalid_voice(client: TestClient) -> None:
    response = client.post("/tts/generate", json={"text": "Hi!", "voice": "unknown_voice"})
    assert response.status_code == 400
    assert "Invalid voice" in response.json()["detail"]


def test_generate_invalid_format(client: TestClient) -> None:
    response = client.post("/tts/generate", json={"text": "Hi!", "format": "mp3"})
    assert response.status_code == 400
    assert "Invalid format" in response.json()["detail"]


def test_generate_empty_text(client: TestClient) -> None:
    response = client.post("/tts/generate", json={"text": ""})
    assert response.status_code == 422


def test_generate_text_too_long(client: TestClient) -> None:
    response = client.post("/tts/generate", json={"text": "x" * 5001})
    assert response.status_code == 422


def test_generate_service_unavailable(app, mock_tts_service: MagicMock) -> None:
    mock_tts_service.is_available = False
    app.state.tts = mock_tts_service

    with TestClient(app, raise_server_exceptions=True) as c:
        response = c.post("/tts/generate", json={"text": "Hello!"})

    assert response.status_code == 503
    assert "not available" in response.json()["detail"]


def test_generate_cached_response(client: TestClient, mock_tts_service: MagicMock) -> None:

    cached_audio = AudioResult(
        audio_data=b"RIFF\x00\x00\x00\x00WAVEdata\x00\x00\x00\x00",
        duration=0.5,
        voice="af_heart",
        cached=True,
    )
    mock_tts_service.generate = AsyncMock(return_value=cached_audio)

    response = client.post("/tts/generate", json={"text": "cached text"})
    assert response.status_code == 200
    assert response.headers["X-Cached"] == "true"
