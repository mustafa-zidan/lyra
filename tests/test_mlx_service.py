# SPDX-License-Identifier: AGPL-3.0-only
"""Unit tests for MLXTTSService (no model is loaded)."""

import io
import wave
from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient

from server.core.config import Settings
from server.core.mlx_tts_service import MODELS, MLXTTSService, _array_to_wav


@pytest.fixture()
def service(settings_override: Settings) -> Iterator[MLXTTSService]:
    svc = MLXTTSService(settings_override)
    yield svc
    svc._executor.shutdown(wait=False)


def test_models_endpoint_lists_kokoro_variants(client: TestClient) -> None:
    models = client.get("/models").json()["models"]
    assert [m["id"] for m in models] == list(MODELS)
    assert [m["id"] for m in models if m["default"]] == ["mlx-community/Kokoro-82M-bf16"]


async def test_generate_rejects_unknown_voice(service: MLXTTSService) -> None:
    with pytest.raises(ValueError, match="Invalid voice"):
        await service.generate("Hi", voice="leo")


async def test_generate_rejects_unknown_model(service: MLXTTSService) -> None:
    with pytest.raises(ValueError, match="Invalid model"):
        await service.generate("Hi", model_id="eurydice")


def test_array_to_wav_produces_valid_mono_16bit_wav() -> None:
    data = _array_to_wav(np.zeros(2400, dtype=np.float32), 24000)
    with wave.open(io.BytesIO(data)) as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 24000
        assert wf.getnframes() == 2400
