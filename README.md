# Lyra

HTTP API server and browser extension that read any web page aloud using the
[Kokoro-82M](https://huggingface.co/mlx-community/Kokoro-82M-bf16) text-to-speech model, run locally
via [mlx-audio](https://github.com/Blaizzy/mlx-audio) (MLX on Apple Silicon or Linux).

---

## Architecture

```
Browser Extension (Chrome / Firefox)
        │
        │  HTTP  POST /tts/generate
        ▼
Lyra Server  (FastAPI)
        │
        │  Python API
        ▼
mlx-audio  (Kokoro-82M, 50 voices, 9 languages)
```

---

## Prerequisites

| Requirement                      | Notes                                         |
|----------------------------------|-----------------------------------------------|
| A supported platform             | See [platform extras](#platform-extras) below |
| Python 3.12+                     |                                               |
| [uv](https://docs.astral.sh/uv/) | Python package & project manager              |
| Chrome 88+ or Firefox 109+       | For the browser extension                     |

### Platform extras

The TTS runtime (MLX, mlx-audio, misaki, spaCy model) is installed through one platform extra.
Pick exactly one:

| Extra        | Platform                           | MLX backend                 | Status   |
|--------------|------------------------------------|-----------------------------|----------|
| `apple`      | macOS on Apple Silicon (M1+)       | `mlx-metal` (GPU via Metal) | Tested   |
| `linux-cpu`  | Linux x86_64 / aarch64             | `mlx-cpu`                   | Untested |
| `linux-cuda` | Linux with an NVIDIA GPU (CUDA 12) | `mlx-cuda-12`               | Untested |

Each extra is gated by a platform marker, so choosing the wrong one installs nothing.
`linux-cpu` and `linux-cuda` cannot be combined (so `uv sync --all-extras` is not supported).
On Linux, `torch` (pulled in by misaki's spaCy stack, not used for inference) comes from the
PyTorch CPU index to avoid the multi-GB CUDA build.

Building `pyopenjtalk` (Japanese G2P, sdist only) needs `cmake` and a C++ compiler: Xcode
Command Line Tools on macOS, `build-essential cmake` on Debian/Ubuntu.

Without a platform extra the server still starts, but `/health` reports `degraded` and
`/tts/generate` returns 503. CI runs this way, with the TTS service mocked.

### Languages

Every Kokoro language is supported: English (US/UK), Japanese, Mandarin Chinese, Spanish,
French, Hindi, Italian and Brazilian Portuguese. English goes through misaki's English G2P,
Japanese and Chinese through `misaki[ja]` / `misaki[zh]`, and the rest through espeak-ng.

The server picks the language for each request, so you don't have to switch voices by hand:

1. Text in Japanese (kana), Chinese (Han) or Hindi (Devanagari) script is detected from the
   text itself.
2. Otherwise the extension's page language (the nearest `lang` attribute) is used.
3. Otherwise the selected voice's language.

If the selected voice doesn't speak that language, the server uses a voice that does (your
default voice if it matches, else the first voice of that language) and reports it in `X-Voice`.

Japanese uses the bundled `unidic-lite` dictionary. For the full UniDic (~500 MB, slightly
better readings) run `uv run python -m unidic download`; it's picked up automatically.

---

## Quick Start

### 1. Install

```bash
git clone <this-repo>
cd lyra
uv sync --extra apple        # macOS on Apple Silicon
# uv sync --extra linux-cpu    # Linux, CPU only
# uv sync --extra linux-cuda   # Linux, NVIDIA GPU (CUDA 12)
```

The Kokoro weights (~330 MB for bf16) are downloaded from Hugging Face on first start.

### 2. Run the server

```bash
uv run uvicorn server.main:app --host 127.0.0.1 --port 8000
```

Or use the project CLI shortcut:

```bash
uv run lyra
```

The API is now available at `http://127.0.0.1:8000`.
Interactive docs: `http://127.0.0.1:8000/docs`

### 3. Load the browser extension

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

# Default model: mlx-community/Kokoro-82M-bf16 | Kokoro-82M-8bit | Kokoro-82M-4bit
EURYDICE_MLX_MODEL=mlx-community/Kokoro-82M-bf16

# Default voice (see GET /voices), e.g. af_heart, am_adam, bf_emma, bm_george
EURYDICE_MLX_DEFAULT_VOICE=af_heart

# CORS origins (comma-separated, or * for all)
EURYDICE_CORS_ORIGINS=*
```

The same variables can be put in a `.env` file in the project root.

---

## API Reference

See [docs/api.md](docs/api.md) for the full API reference.

Quick summary:

| Method | Path            | Description                  |
|--------|-----------------|------------------------------|
| `GET`  | `/`             | API info                     |
| `GET`  | `/health`       | TTS backend status           |
| `GET`  | `/models`       | List Kokoro model variants   |
| `GET`  | `/voices`       | List available voices        |
| `POST` | `/tts/generate` | Generate WAV audio from text |

### Example

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok","tts_available":true,"provider":"Kokoro 82M"}

curl http://127.0.0.1:8000/voices | jq '.voices[].id'
# "af_heart" "af_bella" ... "pm_alex"

curl -X POST http://127.0.0.1:8000/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, world!", "voice": "af_heart"}' \
  --output hello.wav
```

---

## Development

```bash
# Install with dev extras (add your platform extra to run real TTS)
uv sync --extra dev --extra apple

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
lyra/
├── server/           # FastAPI web server
│   ├── main.py       # App factory + lifespan
│   ├── api/          # Routes and Pydantic models
│   └── core/         # Config and Kokoro (mlx-audio) TTS service
├── extension/        # Browser extension (Chrome + Firefox)
│   ├── manifest.json
│   ├── background.js # Service worker
│   ├── content.js    # Page injection
│   ├── popup/        # Toolbar popup
│   └── options/      # Settings page
└── tests/            # Pytest test suite
```
