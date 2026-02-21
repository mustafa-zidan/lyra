# Eurydice Web

HTTP API server and browser extension that expose the [eurydice-tts](https://github.com/mustafa-zidan/eurydice) text-to-speech library to any web page.

---

## Architecture

```
Browser Extension (Chrome / Firefox)
        │
        │  HTTP  POST /tts/generate
        ▼
Eurydice Web Server  (FastAPI)
        │
        │  Python API
        ▼
eurydice-tts library  (Orpheus TTS model)
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Python 3.12+ | Required by eurydice-tts |
| [uv](https://docs.astral.sh/uv/) | Python package & project manager |
| A TTS provider | See [providers](#providers) below |
| Chrome 88+ or Firefox 109+ | For the browser extension |

### Providers

The server delegates inference to one of the following backends (auto-detected in priority order):

| Provider | Extra | Notes |
|----------|-------|-------|
| **vLLM** | `vllm` | Highest throughput — requires CUDA GPU |
| **orpheus-cpp** | `cpp` | Fast CPU/Apple Silicon inference via llama.cpp |
| **Embedded** | `embedded` | Local transformers inference (CPU/MPS/CUDA) |
| **LM Studio** | *(none)* | Default — requires [LM Studio](https://lmstudio.ai) running with the `orpheus-3b-0.1-ft` model loaded |

---

## Quick Start

### 1. Install

```bash
git clone <this-repo>
cd eurydice-web
uv sync
```

### 2. Start LM Studio (or another provider)

Load the **Orpheus 3B** model in LM Studio and start the local server on port 1234.

### 3. Run the server

```bash
uv run uvicorn server.main:app --host 127.0.0.1 --port 8000
```

Or use the project CLI shortcut:

```bash
uv run eurydice-web
```

The API is now available at `http://127.0.0.1:8000`.
Interactive docs: `http://127.0.0.1:8000/docs`

### 4. Load the browser extension

**Chrome:**
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory in this repository

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `extension/manifest.json`

---

## Configuration

Environment variables (prefix: `EURYDICE_`):

```bash
# Server bind address
EURYDICE_HOST=127.0.0.1
EURYDICE_PORT=8000

# TTS provider: auto | lmstudio | embedded | cpp | vllm
EURYDICE_TTS_PROVIDER=auto

# LM Studio server URL (used when provider=lmstudio or auto)
EURYDICE_TTS_SERVER_URL=http://localhost:1234/v1

# Default voice: tara | leah | jess | leo | dan | mia | zac | zoe
EURYDICE_DEFAULT_VOICE=leo

# CORS origins (comma-separated, or * for all)
EURYDICE_CORS_ORIGINS=*
```

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

---

## API Reference

See [docs/api.md](docs/api.md) for the full API reference.

Quick summary:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | API info |
| `GET` | `/health` | TTS backend status |
| `GET` | `/voices` | List available voices |
| `POST` | `/tts/generate` | Generate WAV audio from text |

### Example

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok","tts_available":true,"provider":"lmstudio"}

curl http://127.0.0.1:8000/voices | jq '.voices[].id'
# "tara" "leah" "jess" "leo" "dan" "mia" "zac" "zoe"

curl -X POST http://127.0.0.1:8000/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, world!", "voice": "leo"}' \
  --output hello.wav
```

---

## Development

```bash
# Install with dev extras
uv sync --extra dev

# Lint
uv run ruff check .

# Format
uv run ruff format .

# Tests
uv run pytest -v
```

---

## Project Structure

```
eurydice-web/
├── server/           # FastAPI web server
│   ├── main.py       # App factory + lifespan
│   ├── api/          # Routes and Pydantic models
│   └── core/         # Config and TTS service
├── extension/        # Browser extension (Chrome + Firefox)
│   ├── manifest.json
│   ├── background.js # Service worker
│   ├── content.js    # Page injection
│   ├── popup/        # Toolbar popup
│   └── options/      # Settings page
└── tests/            # Pytest test suite
```
