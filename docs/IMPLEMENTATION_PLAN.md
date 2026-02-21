# Lyra: Implementation Plan

## Overview

**Goal**: Build a web server that bridges the `eurydice-tts` library to HTTP clients, and browser extensions (Chrome + Firefox) that leverage this server to read aloud text selected on any web page.

**Stack**:
- Python 3.12 + uv + FastAPI (server)
- Vanilla JS + Manifest V3 (browser extensions)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser                        │
│                                                 │
│  ┌─────────────┐      ┌──────────────────────┐  │
│  │  Extension  │      │    Web Page          │  │
│  │  Popup/     │◄────►│  Content Script      │  │
│  │  Options    │      │  (text selection UI) │  │
│  └──────┬──────┘      └──────────┬───────────┘  │
│         │                        │              │
│         └──────────┬─────────────┘              │
│                    │ chrome.runtime.sendMessage │
│            ┌───────▼────────┐                   │
│            │  Background    │                   │
│            │  Service Worker│                   │
│            └───────┬────────┘                   │
│                    │ fetch (HTTP)               │
└────────────────────┼────────────────────────────┘
                     │
     ┌───────────────▼──────────────────────┐
     │         Lyra Server          │
     │         FastAPI + uvicorn            │
     │                                      │
     │  GET  /                              │
     │  GET  /health                        │
     │  GET  /voices                        │
     │  POST /tts/generate                  │
     └───────────────┬──────────────────────┘
                     │
     ┌───────────────▼──────────────────────┐
     │         eurydice-tts library         │
     │                                      │
     │  Providers: LMStudio | Embedded      │
     │             OrpheusCpp | vLLM        │
     │  Cache: Memory | Filesystem          │
     └──────────────────────────────────────┘
```

---

## Project Structure

```
lyra/
├── pyproject.toml              # uv project, Python 3.12+
├── .python-version             # "3.12"
├── .gitignore
├── README.md
│
├── docs/
│   ├── IMPLEMENTATION_PLAN.md  # this file
│   ├── tasks.md                # mcp-tasks tracking
│   └── api.md                  # API reference
│
├── server/                     # FastAPI web server
│   ├── __init__.py
│   ├── main.py                 # App factory + lifespan
│   ├── api/
│   │   ├── __init__.py
│   │   ├── models.py           # Pydantic schemas
│   │   └── routes/
│   │       ├── __init__.py
│   │       ├── root.py         # GET /
│   │       ├── health.py       # GET /health
│   │       ├── voices.py       # GET /voices
│   │       └── tts.py          # POST /tts/generate
│   └── core/
│       ├── __init__.py
│       ├── config.py           # pydantic-settings config
│       └── tts_service.py      # Eurydice client singleton
│
├── extension/                  # Browser extension (Chrome + Firefox)
│   ├── manifest.json           # Manifest V3
│   ├── background.js           # Service worker
│   ├── content.js              # Page injection script
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html
│   │   ├── options.js
│   │   └── options.css
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
│
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_health.py
    ├── test_voices.py
    └── test_tts.py
```

---

## Server API Specification

### `GET /`
Returns API metadata.

**Response 200:**
```json
{
  "name": "Lyra",
  "version": "0.1.0",
  "description": "TTS API powered by eurydice-tts",
  "docs": "/docs"
}
```

---

### `GET /health`
Checks if the TTS backend is available.

**Response 200:**
```json
{
  "status": "ok",
  "tts_available": true,
  "provider": "lmstudio"
}
```

**Response 503** (TTS backend unavailable):
```json
{
  "status": "degraded",
  "tts_available": false,
  "provider": null
}
```

---

### `GET /voices`
Lists all supported TTS voices.

**Response 200:**
```json
{
  "voices": [
    { "id": "tara", "name": "Tara" },
    { "id": "leah", "name": "Leah" },
    { "id": "jess", "name": "Jess" },
    { "id": "leo",  "name": "Leo", "default": true },
    { "id": "dan",  "name": "Dan" },
    { "id": "mia",  "name": "Mia" },
    { "id": "zac",  "name": "Zac" },
    { "id": "zoe",  "name": "Zoe" }
  ]
}
```

---

### `POST /tts/generate`
Generates audio from text. Returns WAV audio binary.

**Request body (JSON):**
```json
{
  "text": "Hello, world!",
  "voice": "leo",
  "format": "wav"
}
```

| Field    | Type   | Required | Default | Notes                          |
|----------|--------|----------|---------|--------------------------------|
| `text`   | string | Yes      | -       | 1–5000 characters              |
| `voice`  | string | No       | "leo"   | One of the 8 supported voices  |
| `format` | string | No       | "wav"   | Only "wav" supported currently |

**Response 200:**
- `Content-Type: audio/wav`
- `X-Audio-Duration: <float seconds>`
- `X-Cached: <true|false>`
- `X-Voice: <voice-id>`
- Body: raw WAV binary

**Response 400:** Invalid voice or format
```json
{ "detail": "Invalid voice: 'unknown'. Valid voices: tara, leah, jess, leo, dan, mia, zac, zoe" }
```

**Response 422:** Validation error (e.g., text too long or empty)

**Response 503:** TTS backend not available
```json
{ "detail": "TTS service is not available. Check provider configuration." }
```

---

## Server Configuration

Environment variables (prefix: `EURYDICE_`):

| Variable                   | Default                    | Description                          |
|----------------------------|----------------------------|--------------------------------------|
| `EURYDICE_HOST`            | `127.0.0.1`                | Server bind host                     |
| `EURYDICE_PORT`            | `8000`                     | Server bind port                     |
| `EURYDICE_TTS_PROVIDER`    | `auto`                     | Provider: auto/lmstudio/embedded/cpp |
| `EURYDICE_TTS_SERVER_URL`  | `http://localhost:1234/v1`  | LM Studio server URL                 |
| `EURYDICE_DEFAULT_VOICE`   | `leo`                      | Default TTS voice                    |
| `EURYDICE_CORS_ORIGINS`    | `*`                        | Comma-separated CORS allowed origins |
| `EURYDICE_LOG_LEVEL`       | `info`                     | Logging level                        |

---

## Browser Extension

### Manifest V3 Compatibility

The extension targets **Manifest V3** which is supported by:
- **Chrome 88+** (Manifest V3 introduced)
- **Firefox 109+** (MV3 support added)

Cross-browser JavaScript API pattern:
```javascript
const api = typeof browser !== 'undefined' ? browser : chrome;
```

Firefox requires `"browser_specific_settings"` in manifest for AMO submission.

---

### Permissions Required

```json
{
  "permissions": ["contextMenus", "storage", "activeTab", "scripting"],
  "host_permissions": ["http://127.0.0.1:8000/*", "http://localhost:8000/*"]
}
```

---

### Extension Features

**Context Menu:**
- Right-click → "Read selection aloud with Lyra"
- Appears only when text is selected

**Popup (toolbar icon):**
- Read page button (extracts & reads `document.body.innerText`)
- Read selection button (reads currently highlighted text)
- Stop button
- Voice selector (fetched from `/voices`)
- Link to options

**Content Script (`content.js`):**
- Injected into all `http://*` and `https://*` pages
- Handles floating playback UI (play/pause/stop bar at bottom of page)
- Extracts clean text from selection (`window.getSelection()`)
- Listens for messages from background worker

**Background Service Worker (`background.js`):**
- Registers context menu on install
- Makes `fetch()` calls to the TTS server
- Manages `AudioContext` for playback
- Stores settings in `chrome.storage.local`
- Sends status updates to active tabs

**Options Page:**
- Server URL (default: `http://127.0.0.1:8000`)
- Default voice selector
- Text chunk size (for long-text splitting)
- Save / Reset buttons

---

### Text Chunking Strategy

Long text is split into sentence-length chunks (~500 characters, split at sentence boundaries) and streamed sequentially for perceived low latency:

1. Split at `.`, `!`, `?` followed by whitespace
2. Batch into chunks ≤ 500 chars
3. Pre-fetch next chunk while current plays

---

## Server Dependencies

```toml
[project]
name = "lyra"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.34.0",
    "pydantic-settings>=2.7.0",
    "eurydice-tts[audio]",  # local path or PyPI
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",
    "pytest-asyncio>=0.25.0",
    "httpx>=0.28.0",         # async test client for FastAPI
    "ruff>=0.9.0",
]
```

---

## Implementation Tasks (ordered)

### Phase 1: Server

| # | Task                            | File(s)                             |
|---|---------------------------------|-------------------------------------|
| 1 | Initialize uv project structure | `pyproject.toml`, `.python-version` |
| 2 | Server configuration            | `server/core/config.py`             |
| 3 | TTS service singleton           | `server/core/tts_service.py`        |
| 4 | API models (Pydantic)           | `server/api/models.py`              |
| 5 | Health endpoint                 | `server/api/routes/health.py`       |
| 6 | Voices endpoint                 | `server/api/routes/voices.py`       |
| 7 | TTS generate endpoint           | `server/api/routes/tts.py`          |
| 8 | App factory + CORS + lifespan   | `server/main.py`                    |
| 9 | Tests                           | `tests/`                            |

### Phase 2: Browser Extension

| #  | Task                        | File(s)                             |
|----|-----------------------------|-------------------------------------|
| 10 | Manifest + icons            | `extension/manifest.json`, `icons/` |
| 11 | Background service worker   | `extension/background.js`           |
| 12 | Content script (UI overlay) | `extension/content.js`              |
| 13 | Popup                       | `extension/popup/`                  |
| 14 | Options page                | `extension/options/`                |

### Phase 3: Docs & Polish

| #  | Task                                    | File(s)       |
|----|-----------------------------------------|---------------|
| 15 | README (quick start, extension install) | `README.md`   |
| 16 | API reference docs                      | `docs/api.md` |

---

## Known Risks & Mitigations

| Risk                                         | Mitigation                                                                   |
|----------------------------------------------|------------------------------------------------------------------------------|
| `eurydice-tts[audio]` requires torch (heavy) | Document this; server degrades gracefully to 503 if no provider is available |
| LM Studio must be running                    | Health endpoint shows status; extension shows warning if server unreachable  |
| MV3 service worker may be killed             | Use `chrome.storage` for state persistence; re-init on wake                  |
| Firefox vs Chrome API differences            | `typeof browser !== 'undefined'` fallback throughout                         |
| CORS for extension origins                   | Default `*` origin; options page lets users configure                        |
| Long text → slow response                    | Text chunking with sequential playback                                       |

---

## Quality Gates

Before marking any phase complete:
1. `uv run ruff check .` → 0 errors
2. `uv run ruff format --check .` → no diffs
3. `uv run pytest` → all tests pass
