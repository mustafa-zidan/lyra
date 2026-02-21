# Lyra — API Reference

Base URL: `http://127.0.0.1:8000` (default)

Interactive docs (OpenAPI / Swagger UI): `http://127.0.0.1:8000/docs`

---

## `GET /`

Returns API metadata.

### Response 200

```json
{
  "name": "Lyra",
  "version": "0.1.0",
  "description": "TTS API powered by eurydice-tts",
  "docs": "/docs"
}
```

---

## `GET /health`

Returns the current server and TTS backend status.

### Response 200 — OK

```json
{
  "status": "ok",
  "tts_available": true,
  "provider": "lmstudio"
}
```

### Response 503 — TTS backend unavailable

```json
{
  "status": "degraded",
  "tts_available": false,
  "provider": null
}
```

---

## `GET /voices`

Lists all voices supported by the eurydice-tts library.

### Response 200

```json
{
  "voices": [
    { "id": "tara", "name": "Tara", "default": false },
    { "id": "leah", "name": "Leah", "default": false },
    { "id": "jess", "name": "Jess", "default": false },
    { "id": "leo",  "name": "Leo",  "default": true  },
    { "id": "dan",  "name": "Dan",  "default": false },
    { "id": "mia",  "name": "Mia",  "default": false },
    { "id": "zac",  "name": "Zac",  "default": false },
    { "id": "zoe",  "name": "Zoe",  "default": false }
  ]
}
```

---

## `POST /tts/generate`

Synthesises speech from text and returns a WAV audio file.

### Request body

```json
{
  "text": "Hello, world!",
  "voice": "leo",
  "format": "wav"
}
```

| Field    | Type   | Required | Default                    | Description                            |
|----------|--------|----------|----------------------------|----------------------------------------|
| `text`   | string | Yes      | —                          | Input text (1 – 5 000 characters)      |
| `voice`  | string | No       | Server default (e.g. `leo`) | One of the 8 voice IDs                |
| `format` | string | No       | `"wav"`                    | Audio format — only `"wav"` supported  |

### Response 200

- **Content-Type**: `audio/wav`
- **Body**: Raw WAV binary

| Response header     | Description                               |
|---------------------|-------------------------------------------|
| `X-Audio-Duration`  | Duration of the generated audio (seconds) |
| `X-Cached`          | `"true"` if served from cache             |
| `X-Voice`           | Voice ID used for this response           |

### Response 400 — Invalid voice or format

```json
{
  "detail": "Invalid voice: 'unknown_voice'. Valid voices: dan, jess, leah, leo, mia, tara, zac, zoe"
}
```

### Response 422 — Validation error

```json
{
  "detail": [
    {
      "type": "string_too_short",
      "loc": ["body", "text"],
      "msg": "String should have at least 1 character",
      "input": ""
    }
  ]
}
```

### Response 503 — TTS backend unavailable

```json
{
  "detail": "TTS service is not available. Check provider configuration."
}
```

---

## Example usage

### cURL

```bash
# Health check
curl http://127.0.0.1:8000/health

# List voices
curl http://127.0.0.1:8000/voices | jq '.voices[].id'

# Generate audio (saves to output.wav)
curl -X POST http://127.0.0.1:8000/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Welcome to Eurydice.", "voice": "tara"}' \
  -o output.wav
```

### Python (httpx)

```python
import httpx

with httpx.Client(base_url="http://127.0.0.1:8000") as client:
    # Check health
    health = client.get("/health").json()
    print(health["status"])  # "ok"

    # Generate audio
    response = client.post(
        "/tts/generate",
        json={"text": "Hello, world!", "voice": "leo"},
    )
    response.raise_for_status()

    with open("output.wav", "wb") as f:
        f.write(response.content)

    print("Duration:", response.headers["X-Audio-Duration"])
```

### JavaScript (fetch)

```javascript
const response = await fetch('http://127.0.0.1:8000/tts/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Hello!', voice: 'leo' }),
});

if (!response.ok) throw new Error(await response.json().then(d => d.detail));

const arrayBuffer = await response.arrayBuffer();
const audio = new Audio();
audio.src = URL.createObjectURL(new Blob([arrayBuffer], { type: 'audio/wav' }));
audio.play();
```
