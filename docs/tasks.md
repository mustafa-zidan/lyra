# Tasks - Tasks

## In Progress

## To Do

## Backlog

## Done

- [x] Initialize uv project: pyproject.toml, .python-version, .gitignore
- [x] Server config: server/core/config.py (pydantic-settings, env vars)
- [x] TTS service singleton: server/core/tts_service.py (Eurydice client lifecycle)
- [x] API models: server/api/models.py (Pydantic request/response schemas)
- [x] Health endpoint: GET /health
- [x] Voices endpoint: GET /voices
- [x] TTS generate endpoint: POST /tts/generate (returns binary WAV)
- [x] App factory: server/main.py (FastAPI + CORS + lifespan + routes)
- [x] Server tests: tests/ (conftest, test_health, test_voices, test_tts)
- [x] Extension manifest + icons: extension/manifest.json
- [x] Background service worker: extension/background.js
- [x] Content script + UI overlay: extension/content.js
- [x] Extension popup: extension/popup/
- [x] Extension options page: extension/options/
- [x] README + docs/api.md
- [x] AGPL-3.0 license + SPDX headers across all source files
- [x] Fix background.js addEventListener bug + add chunk-highlight messaging
- [x] Implement page highlighting in content.js (CSS Highlight API + fallback)
- [x] JS tooling: package.json, eslint.config.js, .prettierrc.json
- [x] Pre-commit hooks: .pre-commit-config.yaml
- [x] Playwright extension tests: config, fixtures, helpers, test files
- [x] GitHub Actions: test.yml + release.yml
- [x] Generate a nicer icon (SVG + Playwright PNG generation script)
- [x] Restyle the extension — black and white flat design (popup, options, status bar)
- [x] Switch extension to TypeScript (src/ → extension/ compiled output)
