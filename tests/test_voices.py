# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for GET /voices."""

from fastapi.testclient import TestClient


def test_voices_returns_all_kokoro_voices(client: TestClient) -> None:
    response = client.get("/voices")
    assert response.status_code == 200
    data = response.json()
    assert "voices" in data
    ids = {v["id"] for v in data["voices"]}
    assert len(ids) == 50
    assert {"af_heart", "bm_george", "jf_alpha", "zf_xiaobei"} <= ids


def test_voices_default_marked(client: TestClient) -> None:
    response = client.get("/voices")
    voices = response.json()["voices"]
    defaults = [v for v in voices if v["default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == "af_heart"  # configured default in settings_override


def test_voices_have_language_and_gender(client: TestClient) -> None:
    voices = {v["id"]: v for v in client.get("/voices").json()["voices"]}
    assert voices["af_heart"]["language"] == "English (US)"
    assert voices["af_heart"]["gender"] == "Female"
    assert voices["bm_george"]["language"] == "English (UK)"
    assert voices["bm_george"]["gender"] == "Male"


def test_voices_unknown_model_returns_empty(client: TestClient) -> None:
    response = client.get("/voices", params={"model": "does-not-exist"})
    assert response.status_code == 200
    assert response.json()["voices"] == []
