# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for GET /voices."""

from fastapi.testclient import TestClient


def test_voices_returns_all_voices(client: TestClient) -> None:
    response = client.get("/voices")
    assert response.status_code == 200
    data = response.json()
    assert "voices" in data
    voices = data["voices"]
    assert len(voices) == 8  # tara, leah, jess, leo, dan, mia, zac, zoe

    ids = {v["id"] for v in voices}
    assert ids == {"tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"}


def test_voices_default_marked(client: TestClient) -> None:
    response = client.get("/voices")
    voices = response.json()["voices"]
    defaults = [v for v in voices if v["default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == "leo"  # configured default in settings_override


def test_voices_name_capitalised(client: TestClient) -> None:
    response = client.get("/voices")
    for voice in response.json()["voices"]:
        assert voice["name"] == voice["id"].capitalize()